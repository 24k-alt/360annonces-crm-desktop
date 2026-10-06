# 360annonces CRM — desktop client (prototype)

Tauri v2 (Rust). Uses the system WebView (WebView2 / WKWebView / WebKitGTK): no bundled Chromium, no Node at runtime.
The window (created in Rust, `src-tauri/src/lib.rs`) opens a local splash (`ui/`), checks the CRM is reachable, then navigates to https://crm.360annonces.com.

## Security model (zero trust for the remote origin)

| Decision | Threat it closes |
|---|---|
| `on_navigation` allowlist: only `https://crm.360annonces.com` (default port, no userinfo) and the local splash origin (`tauri://localhost`, `http://tauri.localhost`). Everything else is blocked in-window; `http(s)/mailto/tel` links are handed to the system browser. | A CRM link, redirect or injected content turning the app window into a general browser (phishing inside a trusted frame). |
| `on_new_window` always `Deny` (+ same external-open rule). | `window.open` / `target=_blank` creating in-app windows. |
| Capability `default` has no `remote` block (local origins only) and grants only `allow-load-local-mcp-plugins`; the command is declared in `build.rs` (`AppManifest`), so it is ACL-governed. No `core:default`. | Remote origin calling any IPC command or Tauri API. |
| `load_local_mcp_plugins` also refuses unless the calling webview URL is local. | Capability misconfiguration later (defence in depth). |
| `withGlobalTauri: false`; no `dangerousRemoteDomainIpcAccess`; no `opener:*` permission (plugin used from Rust only, scheme allowlist `http/https/mailto/tel`). | `window.__TAURI__` exposure; remote launching `file:` / custom protocol handlers. |
| CSP (applies to local pages): `default-src 'self'`, `object-src/base-uri/form-action/frame-src 'none'`. The CRM's own CSP is the server's responsibility. | Injection into the splash. |
| Plugin manifests: regular `.json` files only (no symlinks), <=16 KiB, <=64 files, strict schema (`deny_unknown_fields`), name `[A-Za-z0-9._-]{1,64}`, `command` = bare executable name (no `/ \ : ..`, no leading `-`), <=32 args of <=256 chars, no control chars. **Nothing is ever spawned.** | Path traversal, oversized/hostile manifests, accidental command execution. |
| UA token `360crm-desktop/<version>`: appended to `navigator.userAgent` by an init script. | Lets the web popup detect the app. **Limits:** JS-only (the HTTP `User-Agent` header is unchanged, so servers cannot see it); a page could also spoof it, so it is a hint, never an auth signal. Tauri has no "append to default UA" API; the alternative (`.user_agent()`) replaces the whole string. |
| Single instance (`tauri-plugin-single-instance`): second launch focuses the window; args/cwd ignored. | — |

Bug found while verifying: the identifier `com.360annonces.crm` made single-instance **panic at startup on Linux** (D-Bus names cannot start with a digit). Identifier is now `com.annonces360.crm` (changes the app-data dir; nothing was shipped yet).

Tests: `cargo test --lib` covers the URL allowlist (lookalike hosts, userinfo, ports, `file:`/`javascript:`/`data:`/`blob:`) and manifest validation. The `on_navigation`/`on_new_window` wiring itself was **not** exercised end-to-end (needs a GUI driver); only the predicate is tested.

## Measurements (honest)

Method: `cargo build --release` (`opt-level=z`, LTO, `panic=abort`, strip) in `rust:1-bookworm` + WebKitGTK 4.1 on **Linux aarch64** (Oracle ARM host), run under Xvfb (1280x900) in a memory-capped container with `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` (bwrap does not work in docker), no GPU (software rendering). Values from `/proc/<pid>/smaps_rollup`, one run each, idle at +60 s.

- Release binary (aarch64, stripped, excludes the installer and the system WebView): **3.41 MB**. Not measured: x86_64, Windows `.exe`, NSIS/deb/AppImage sizes.
- Splash only (network off, so the splash stays):
  - `crm360` process itself: RSS 152 MB, **PSS 80 MB** (PSS anon 29 MB; most of the RSS is shared GTK/WebKit libraries mapped into the process).
  - plus WebKitWebProcess RSS 244 MB / PSS 174 MB and WebKitNetworkProcess RSS 62 MB / PSS 30 MB. Whole tree PSS ≈ 284 MB.
- After the CRM URL loads (network on; the web process grew, which is consistent with the SPA loading, but I did not screenshot to confirm the page rendered): `crm360` PSS 81 MB, WebKitWebProcess RSS ~705 MB / PSS ~631 MB, network process PSS 72 MB. Whole tree PSS ≈ 785 MB.

**The <40 MB target is not met on this measurement and is not demonstrated for any platform.** Even the app process alone is ~80 MB PSS on Linux, and the dominant cost is the CRM web app itself (a Twenty SPA), which no shell can shrink.

What this does NOT say about Windows/WebView2: WebView2 runs the page in separate `msedgewebview2.exe` processes (browser, renderer, GPU, utility) that are **not** in `crm360.exe`'s own RSS; the Windows "app" number will look small but the real footprint is the sum of all of them (typically hundreds of MB for a heavy SPA, but unmeasured here). Different engine, allocator, GPU path, shared-lib accounting and no Xvfb; the Linux numbers are an order-of-magnitude illustration for WebKitGTK only. A Windows number needs measuring on Windows (Task Manager "Details" tree, or `Get-Process msedgewebview2` summed with the app, private working set).

## Other

- `load_local_mcp_plugins`: lists validated `*.json` manifests `{name, command, args}` from `<app data>/mcp-plugins/`. Discovery only; spawning needs its own design (allowlist, user consent, no shell).
- Icons are placeholders; replace with `cargo tauri icon logo.png`.
- Build: `cargo install tauri-cli --version "^2"` then `cargo tauri build` (from this folder). CI: `.github/workflows/desktop.yml`.
- Known gaps: permission requests (camera/mic/geolocation/notifications) and downloads from the CRM are not yet restricted; sub-frame navigations are not covered by `on_navigation` on every platform; the CRM's own CSP/headers are out of scope here.
