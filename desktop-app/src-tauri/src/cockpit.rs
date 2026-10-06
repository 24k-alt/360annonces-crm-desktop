//! IPC surface of the Cockpit (local window). Every command refuses unless the caller's URL is the local origin,
//! on top of the ACL (build.rs AppManifest + capabilities/cockpit.json: no `remote` block, so the CRM origin has no IPC).
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::watch;

use crate::{
    agent::{self, Cfg, Sink},
    crm::{self, Crm},
    secrets::{self, KeyStore, OsKeyStore},
    trace::{now_ms, valid_run_id, Event, Trace},
    Workspace,
};

pub const EVENT_CHANNEL: &str = "agent://event";
const MAX_TASK_CHARS: usize = 2000;
const MAX_ACTIVE_RUNS: usize = 2;

pub struct AgentState {
    trace: Arc<Trace>,
    keys: Box<dyn KeyStore>,
    dir: PathBuf,
    runs: Mutex<HashMap<String, watch::Sender<bool>>>,
    counter: AtomicU64,
}

impl AgentState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            trace: Arc::new(Trace::new(Some(dir.join("agent-traces")))),
            keys: Box::new(OsKeyStore),
            dir,
            runs: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
        }
    }
}

fn local_only(webview: &tauri::Webview) -> Result<(), String> {
    if webview.url().map(|u| crate::is_local(&u)).unwrap_or(false) {
        Ok(())
    } else {
        Err("forbidden".into())
    }
}

fn workspace(app: &tauri::AppHandle) -> Result<Url, String> {
    Ok(app.state::<Workspace>().0.lock().map_err(|e| e.to_string())?.clone())
}

/// Reads the CRM credential from the main webview's cookie jar at call time. Memory only, never logged.
/// Async on purpose: webview cookie APIs deadlock when called from a sync command on Windows.
async fn crm_token(app: &tauri::AppHandle) -> Option<(Url, String)> {
    let ws = workspace(app).ok()?;
    let win = app.get_webview_window("main")?;
    let jar = win.cookies_for_url(ws.clone()).ok()?;
    let pairs: Vec<(String, String)> = jar.iter().map(|c| (c.name().to_string(), c.value().to_string())).collect();
    crm::extract_token(&pairs).map(|t| (ws, t))
}

#[derive(Serialize)]
pub struct SessionStatus {
    signed_in: bool,
    workspace: String,
}

#[derive(Serialize)]
pub struct SettingsView {
    openrouter_key_set: bool,
    model: String,
    model_options: Vec<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn crm_session_status(app: tauri::AppHandle, webview: tauri::Webview) -> Result<SessionStatus, String> {
    local_only(&webview)?;
    let ws = workspace(&app)?;
    Ok(SessionStatus { signed_in: crm_token(&app).await.is_some(), workspace: ws.to_string() })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_settings_get(webview: tauri::Webview, st: tauri::State<'_, AgentState>) -> Result<SettingsView, String> {
    local_only(&webview)?;
    Ok(SettingsView {
        openrouter_key_set: st.keys.get().is_some(),
        model: secrets::load_model(&st.dir),
        model_options: secrets::MODEL_OPTIONS.iter().map(|s| s.to_string()).collect(),
    })
}

/// Flat arguments (`{openrouter_key?, model?}`). An empty key string clears the stored key.
#[tauri::command(rename_all = "snake_case")]
pub async fn agent_settings_set(
    webview: tauri::Webview,
    st: tauri::State<'_, AgentState>,
    openrouter_key: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    local_only(&webview)?;
    // Validate everything first so a bad model does not leave a half-applied change.
    if let Some(m) = &model {
        secrets::validate_model(m)?;
    }
    let key = openrouter_key.map(|k| k.trim().to_string());
    if let Some(k) = key.as_deref().filter(|k| !k.is_empty()) {
        secrets::validate_key(k)?;
    }
    if let Some(m) = &model {
        secrets::save_model(&st.dir, m)?;
    }
    match key.as_deref() {
        Some("") => st.keys.clear()?,
        Some(k) => st.keys.set(k)?,
        None => {}
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_run(app: tauri::AppHandle, webview: tauri::Webview, st: tauri::State<'_, AgentState>, task: String) -> Result<String, String> {
    local_only(&webview)?;
    let task = task.trim().to_string();
    if task.is_empty() || task.chars().count() > MAX_TASK_CHARS || task.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(format!("Tâche invalide (1 à {MAX_TASK_CHARS} caractères)."));
    }
    let model = secrets::load_model(&st.dir);
    let session = crm_token(&app).await;
    let (key, token) = agent::preflight(st.keys.get(), session.as_ref().map(|s| s.1.clone()), &model)?;
    let ws = session.map(|s| s.0).ok_or("Non connecté au CRM.")?;

    let run_id = format!("run-{:x}-{:x}", now_ms(), st.counter.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = watch::channel(false);
    {
        let mut runs = st.runs.lock().map_err(|e| e.to_string())?;
        if runs.len() >= MAX_ACTIVE_RUNS {
            return Err("Une exécution est déjà en cours : attendez qu'elle se termine ou annulez-la.".into());
        }
        runs.insert(run_id.clone(), tx);
    }

    let cfg = Cfg::production(model, key.clone());
    let crm = Crm::new(ws, token, std::time::Duration::from_secs(10), crm::task_needs_pii(&task)).map_err(|e| {
        let _ = st.runs.lock().map(|mut r| r.remove(&run_id));
        e
    })?;
    let mut secrets_list = crm.secrets();
    secrets_list.push(key);
    let handle = app.clone();
    let ui: Arc<dyn Fn(&Event) + Send + Sync> = Arc::new(move |e: &Event| {
        // Only the Cockpit window receives run events (never the remote CRM webview).
        let _ = handle.emit_to("cockpit", EVENT_CHANNEL, e);
    });
    let sink = Sink::new(run_id.clone(), st.trace.clone(), secrets_list, Some(ui));
    let rid = run_id.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        agent::run(&cfg, &task, &crm, &sink, rx).await;
        if let Ok(mut r) = app2.state::<AgentState>().runs.lock() {
            r.remove(&rid);
        }
    });
    Ok(run_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_cancel(webview: tauri::Webview, st: tauri::State<'_, AgentState>, run_id: String) -> Result<(), String> {
    local_only(&webview)?;
    if let Some(tx) = st.runs.lock().map_err(|e| e.to_string())?.get(&run_id) {
        let _ = tx.send(true);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn agent_trace(webview: tauri::Webview, st: tauri::State<'_, AgentState>, run_id: String) -> Result<Vec<Event>, String> {
    local_only(&webview)?;
    if !valid_run_id(&run_id) {
        return Err("run_id invalide".into());
    }
    Ok(st.trace.events(&run_id))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn open_cockpit(app: tauri::AppHandle, webview: tauri::Webview) -> Result<(), String> {
    local_only(&webview)?;
    show_cockpit(&app).map_err(|e| e.to_string())
}

/// Creates (or focuses) the `cockpit` window. Local pages only: navigation outside the local origin is
/// refused (not handed to the browser either), and no new windows can be spawned from it.
pub fn show_cockpit(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("cockpit") {
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, "cockpit", WebviewUrl::App("cockpit/index.html".into()))
        .title("Cockpit - 360annonces CRM")
        .inner_size(1000.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(|u| crate::is_local(u))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    Ok(())
}
