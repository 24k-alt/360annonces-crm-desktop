use serde::{Deserialize, Serialize};
use std::{fs, io::Read, sync::Mutex};
use tauri::{webview::NewWindowResponse, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Workspace this build opens by default. A different workspace can be baked in at build time
/// (`CRM_DEFAULT_URL=https://crm.example.com cargo tauri build`) or chosen by the user on the splash page.
fn default_workspace() -> &'static str {
    match option_env!("CRM_DEFAULT_URL") {
        Some(u) if !u.trim().is_empty() => u,
        _ => "https://crm.360annonces.com",
    }
}

/// The single remote origin the window may show. Shared with the navigation guard.
struct Workspace(Mutex<Url>);

/// Accepts only a bare https origin (optional port); everything else is rejected, never "fixed".
fn parse_origin(raw: &str) -> Result<Url, String> {
    let u: Url = raw.trim().parse().map_err(|_| "Adresse invalide".to_string())?;
    let bare = u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
        && matches!(u.path(), "" | "/")
        && u.host_str().map(|h| h.contains('.') && !h.ends_with('.')).unwrap_or(false);
    if !bare {
        return Err("Entrez l'adresse de votre CRM, par exemple https://crm.votre-agence.com".into());
    }
    let mut origin = u.clone();
    origin.set_path("/");
    Ok(origin)
}

/// Local splash origin: `tauri://localhost` (macOS/Linux) or `http(s)://tauri.localhost` (Windows).
fn is_local(u: &Url) -> bool {
    match u.scheme() {
        "tauri" => u.host_str() == Some("localhost"),
        "http" | "https" => u.host_str() == Some("tauri.localhost"),
        _ => u.as_str() == "about:blank",
    }
}

/// The only remote origin the window may show: the configured workspace (same host and port, no userinfo).
fn is_crm(u: &Url, ws: &Url) -> bool {
    u.scheme() == "https"
        && u.host_str() == ws.host_str()
        && u.port() == ws.port()
        && u.username().is_empty()
        && u.password().is_none()
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("workspace.json"))
}

fn load_workspace(app: &tauri::AppHandle) -> Url {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("url").and_then(|x| x.as_str()).map(String::from))
        .and_then(|raw| parse_origin(&raw).ok())
        .unwrap_or_else(|| parse_origin(default_workspace()).expect("CRM_DEFAULT_URL must be a bare https origin"))
}

#[tauri::command]
fn get_workspace(webview: tauri::Webview, ws: tauri::State<Workspace>) -> Result<String, String> {
    if !webview.url().map(|u| is_local(&u)).unwrap_or(false) {
        return Err("forbidden".into());
    }
    Ok(ws.0.lock().map_err(|e| e.to_string())?.to_string())
}

#[tauri::command]
fn set_workspace(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    ws: tauri::State<Workspace>,
    url: String,
) -> Result<String, String> {
    if !webview.url().map(|u| is_local(&u)).unwrap_or(false) {
        return Err("forbidden".into());
    }
    let origin = parse_origin(&url)?;
    let path = config_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::json!({ "url": origin.as_str() }).to_string()).map_err(|e| e.to_string())?;
    *ws.0.lock().map_err(|e| e.to_string())? = origin.clone();
    Ok(origin.to_string())
}

/// Anything else a user clicks goes to the system browser, never into the app window.
/// Scheme allowlist: the opener would happily launch `file:`, `ms-msdt:` etc.
fn open_external(app: &tauri::AppHandle, u: &Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto" | "tel") {
        let _ = app.opener().open_url(u.as_str(), None::<&str>);
    }
}

// ---- local MCP plugin manifests ---------------------------------------------------------------
const MAX_FILES: usize = 64;
const MAX_FILE_BYTES: u64 = 16 * 1024;
const MAX_ARGS: usize = 32;

/// `<app data dir>/mcp-plugins/*.json`. Discovery + validation only: nothing here spawns anything.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct McpPlugin {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

fn clean(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn validate(p: &McpPlugin) -> bool {
    let name_ok = clean(&p.name, 64)
        && p.name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && p.name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    // Bare executable name only: no path separators, drive letters, `..`, or leading `-`.
    let cmd_ok = clean(&p.command, 128)
        && !p.command.starts_with('-')
        && !p.command.contains(['/', '\\', ':'])
        && !p.command.contains("..");
    name_ok && cmd_ok && p.args.len() <= MAX_ARGS && p.args.iter().all(|a| clean(a, 256))
}

fn scan(dir: &std::path::Path) -> Vec<McpPlugin> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for entry in rd.flatten().take(MAX_FILES * 4) {
        if out.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        // Regular files only (file_type does not follow symlinks), `.json`, size-capped.
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(f) = fs::File::open(&path) else { continue };
        let mut raw = String::new();
        if f.take(MAX_FILE_BYTES + 1).read_to_string(&mut raw).is_err()
            || raw.len() as u64 > MAX_FILE_BYTES
        {
            continue;
        }
        // A broken or invalid manifest is skipped, not fatal.
        if let Ok(p) = serde_json::from_str::<McpPlugin>(&raw) {
            if validate(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Defence in depth on top of the capability: refuse unless the caller is the local splash.
#[tauri::command]
fn load_local_mcp_plugins(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Vec<McpPlugin>, String> {
    if !webview.url().map(|u| is_local(&u)).unwrap_or(false) {
        return Err("forbidden".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mcp-plugins");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(scan(&dir))
}

pub fn run() {
    tauri::Builder::default()
        // Second launch: focus the existing window. Args/cwd are ignored on purpose (untrusted input).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // Used from Rust only: no `opener:*` permission is granted in any capability,
        // so no webview (local or remote) can call it.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let (nav, win) = (app.handle().clone(), app.handle().clone());
            app.manage(Workspace(Mutex::new(load_workspace(app.handle()))));
            // Tauri cannot append to the default UA, so the token is added to `navigator.userAgent`
            // (JS-visible only; the HTTP User-Agent header is NOT modified).
            let ua = format!(
                "(function(){{try{{var u=navigator.userAgent+' 360crm-desktop/{}';Object.defineProperty(Navigator.prototype,'userAgent',{{get:function(){{return u}},configurable:true}})}}catch(e){{}}}})();",
                env!("CARGO_PKG_VERSION")
            );
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("360annonces CRM")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(ua)
                .on_navigation(move |u| {
                    let allowed = nav
                        .state::<Workspace>()
                        .0
                        .lock()
                        .map(|ws| is_local(u) || is_crm(u, &ws))
                        .unwrap_or_else(|_| is_local(u));
                    if allowed {
                        return true;
                    }
                    open_external(&nav, u);
                    false
                })
                // window.open / target=_blank: never create an in-app window.
                .on_new_window(move |u, _| {
                    open_external(&win, &u);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_local_mcp_plugins, get_workspace, set_workspace])
        .run(tauri::generate_context!())
        .expect("error while running 360annonces CRM");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }
    fn p(name: &str, command: &str) -> McpPlugin {
        McpPlugin { name: name.into(), command: command.into(), args: vec![] }
    }
    fn allowed(s: &str) -> bool {
        let ws = parse_origin("https://crm.360annonces.com").unwrap();
        is_local(&u(s)) || is_crm(&u(s), &ws)
    }

    #[test]
    fn workspace_origin_parsing() {
        assert_eq!(parse_origin(" https://crm.exemple.ma ").unwrap().as_str(), "https://crm.exemple.ma/");
        assert_eq!(parse_origin("https://crm.exemple.ma:8443/").unwrap().port(), Some(8443));
        for bad in [
            "http://crm.exemple.ma", "crm.exemple.ma", "https://localhost", "https://exemple.ma/app",
            "https://u:p@crm.exemple.ma", "https://crm.exemple.ma/?x=1", "https://crm.exemple.ma/#x",
            "file:///x", "javascript:alert(1)", "",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad}");
        }
        // a second workspace is allowed only when it is the configured one
        let other = parse_origin("https://crm.exemple.ma").unwrap();
        assert!(is_crm(&u("https://crm.exemple.ma/page"), &other));
        assert!(!is_crm(&u("https://crm.360annonces.com/"), &other));
    }

    #[test]
    fn navigation_allowlist() {
        for ok in [
            "https://crm.360annonces.com/",
            "https://crm.360annonces.com/a?b#c",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
        ] {
            assert!(allowed(ok), "{ok}");
        }
        for bad in [
            "http://crm.360annonces.com/",
            "https://crm.360annonces.com.evil.io/",
            "https://evil.io/?crm.360annonces.com",
            "https://crm.360annonces.com@evil.io/",
            "https://user@crm.360annonces.com/",
            "https://crm.360annonces.com:8443/",
            "https://tauri.localhost.evil.io/",
            "tauri://evil/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "blob:https://crm.360annonces.com/x",
        ] {
            assert!(!allowed(bad), "{bad}");
        }
    }

    #[test]
    fn manifest_validation() {
        assert!(validate(&p("fs-tools_1", "npx")));
        for (n, c) in [
            ("", "x"),
            ("../x", "x"),
            ("a b", "x"),
            ("a", ""),
            ("a", "../bin/x"),
            ("a", "C:\\x.exe"),
            ("a", "/bin/sh"),
            ("a", "-rf"),
            ("a", "x\n"),
        ] {
            assert!(!validate(&p(n, c)), "{n:?} {c:?}");
        }
        let mut q = p("a", "x");
        q.args = vec!["x".repeat(257)];
        assert!(!validate(&q));
        q.args = vec!["ok".into(); MAX_ARGS + 1];
        assert!(!validate(&q));
        assert!(serde_json::from_str::<McpPlugin>(r#"{"name":"a","command":"b","env":{}}"#).is_err());
    }
}
