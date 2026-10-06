//! Run events: in-memory ring + append-only JSONL under `<app data>/agent-traces/`.
//! Everything stored here has already been redacted by `Sink::emit` (see agent.rs).
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const RING_CAP: usize = 4000;
const FILE_CAP: u64 = 2 * 1024 * 1024; // rotate the live file at 2 MB
const FILES_KEPT: usize = 3; // traces.jsonl, traces.1.jsonl, traces.2.jsonl
const MAX_LINE: usize = 16 * 1024;
const MAX_TEXT: usize = 2000;
const MAX_REPLAY: usize = 1000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub run_id: String,
    pub seq: u32,
    /// Unix epoch milliseconds.
    pub ts: u64,
    /// step | tool_call | tool_result | answer | error | done | cancelled
    pub kind: String,
    /// thinking | searching | reading | writing | null
    pub state: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<Value>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn valid_run_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub struct Trace {
    ring: Mutex<VecDeque<Event>>,
    dir: Option<PathBuf>,
    file_cap: u64,
}

impl Trace {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self::with_file_cap(dir, FILE_CAP)
    }
    pub fn with_file_cap(dir: Option<PathBuf>, file_cap: u64) -> Self {
        Self { ring: Mutex::new(VecDeque::new()), dir, file_cap }
    }

    fn path(&self, n: usize) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(if n == 0 { "traces.jsonl".to_string() } else { format!("traces.{n}.jsonl") }))
    }

    pub fn record(&self, e: &Event) {
        let mut e = e.clone();
        if e.text.chars().count() > MAX_TEXT {
            e.text = e.text.chars().take(MAX_TEXT).collect::<String>() + "…";
        }
        let mut line = serde_json::to_string(&e).unwrap_or_default();
        if line.len() > MAX_LINE {
            e.detail = Some(Value::String("[détail trop volumineux, supprimé]".into()));
            line = serde_json::to_string(&e).unwrap_or_default();
        }
        if let Ok(mut r) = self.ring.lock() {
            if r.len() >= RING_CAP {
                r.pop_front();
            }
            r.push_back(e);
        }
        let _ = self.append(&line); // a full disk must never break a run
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        let (Some(dir), Some(live)) = (self.dir.as_ref(), self.path(0)) else { return Ok(()) };
        fs::create_dir_all(dir)?;
        if fs::metadata(&live).map(|m| m.len() >= self.file_cap).unwrap_or(false) {
            for n in (0..FILES_KEPT - 1).rev() {
                let (from, to) = (self.path(n).unwrap(), self.path(n + 1).unwrap());
                if from.exists() {
                    let _ = fs::rename(from, to); // overwrites the oldest on Windows too (std semantics: replace)
                }
            }
        }
        let mut f = fs::OpenOptions::new().create(true).append(true).open(live)?;
        writeln!(f, "{line}")
    }

    /// Events of one run, in order. Falls back to the files when the ring no longer has them.
    pub fn events(&self, run_id: &str) -> Vec<Event> {
        let mut v: Vec<Event> = self.ring.lock().map(|r| r.iter().filter(|e| e.run_id == run_id).cloned().collect()).unwrap_or_default();
        if v.is_empty() {
            for n in (0..FILES_KEPT).rev() {
                let Some(p) = self.path(n) else { continue };
                let Ok(raw) = fs::read_to_string(p) else { continue };
                v.extend(raw.lines().filter_map(|l| serde_json::from_str::<Event>(l).ok()).filter(|e| e.run_id == run_id));
                if v.len() >= MAX_REPLAY {
                    v.truncate(MAX_REPLAY);
                    break;
                }
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(run: &str, seq: u32, text: &str) -> Event {
        Event { run_id: run.into(), seq, ts: 1, kind: "step".into(), state: None, text: text.into(), detail: None }
    }

    #[test]
    fn ring_file_rotation_and_replay() {
        let dir = std::env::temp_dir().join(format!("crm360-trace-{}", now_ms()));
        let t = Trace::with_file_cap(Some(dir.clone()), 600);
        for i in 0..40 {
            t.record(&ev("r1", i, &"x".repeat(50)));
        }
        t.record(&ev("r2", 0, "autre"));
        assert_eq!(t.events("r1").len(), 40);
        assert_eq!(t.events("r2").len(), 1);
        // rotation kept at most FILES_KEPT files, each roughly bounded
        let n = fs::read_dir(&dir).unwrap().count();
        assert!((2..=FILES_KEPT).contains(&n), "{n}");
        // a fresh Trace (empty ring) replays from disk
        let t2 = Trace::with_file_cap(Some(dir.clone()), 600);
        assert!(!t2.events("r2").is_empty());
        assert!(t2.events("zzz").is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn caps_and_ids() {
        let t = Trace::new(None);
        let mut e = ev("r", 1, &"é".repeat(5000));
        e.detail = Some(Value::String("d".repeat(40_000)));
        t.record(&e);
        let got = &t.events("r")[0];
        assert!(got.text.chars().count() <= MAX_TEXT + 1);
        assert!(got.detail.as_ref().unwrap().as_str().unwrap().contains("trop volumineux"));
        assert!(valid_run_id("run-1a2b-3") && !valid_run_id("../x") && !valid_run_id(""));
    }
}
