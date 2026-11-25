// Musicplayer desktop: a native window around a remote Musicplayer server.
// The start page (../dist) asks for the server URL and remembers it; this file
// only creates the window and adds a Ctrl+Shift+S shortcut to get back to it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

// Address of the bundled start page as the webview sees it.
#[cfg(windows)]
const START_PAGE: &str = "http://tauri.localhost/index.html#change";
#[cfg(not(windows))]
const START_PAGE: &str = "tauri://localhost/index.html#change";

fn shortcut_script() -> String {
    format!(
        r#"window.addEventListener('keydown', (e) => {{
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {{
    e.preventDefault();
    location.href = {start:?};
  }}
}}, true);"#,
        start = START_PAGE
    )
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Musicplayer")
                .inner_size(1280.0, 820.0)
                .min_inner_size(380.0, 520.0)
                .background_color(tauri::window::Color(0, 0, 0, 255))
                .theme(Some(tauri::Theme::Dark))
                .initialization_script(&shortcut_script())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Musicplayer");
}
