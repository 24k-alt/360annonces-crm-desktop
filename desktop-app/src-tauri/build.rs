fn main() {
    // Declaring the app command makes it ACL-governed: callable only where a capability grants
    // `allow-<command>` (local splash only).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["load_local_mcp_plugins", "get_workspace", "set_workspace"])),
    )
    .expect("tauri build failed");
}
