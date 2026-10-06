//! Test-only in-process HTTP/1.1 mock server (one response per connection). No extra dependency.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub struct Mock {
    pub addr: SocketAddr,
    pub reqs: Arc<Mutex<Vec<Req>>>,
}

impl Mock {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    pub fn requests(&self) -> Vec<Req> {
        self.reqs.lock().unwrap().clone()
    }
}

/// Handler gets the request and its 0-based index; returns (status, body, delay_ms, extra headers).
pub type Reply = (u16, String, u64, Vec<(String, String)>);

pub async fn serve<F>(handler: F) -> Mock
where
    F: Fn(&Req, usize) -> Reply + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let reqs = Arc::new(Mutex::new(Vec::new()));
    let (r2, h) = (reqs.clone(), Arc::new(handler));
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { return };
            let (r3, h2) = (r2.clone(), h.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.lines();
                let mut first = lines.next().unwrap_or("").split_whitespace();
                let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
                let headers: Vec<(String, String)> =
                    lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
                let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let req = Req { method, path, headers, body };
                let idx = {
                    let mut g = r3.lock().unwrap();
                    g.push(req.clone());
                    g.len() - 1
                };
                let (status, resp, delay, extra) = h2(&req, idx);
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                let extra: String = extra.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
                let out = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{resp}",
                    resp.len()
                );
                let _ = s.write_all(out.as_bytes()).await;
                let _ = s.shutdown().await;
            });
        }
    });
    Mock { addr, reqs }
}
