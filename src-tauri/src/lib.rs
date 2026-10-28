//! SupaNet desktop shell.
//!
//! Two windows: a small `launcher` that checks Docker + the Supabase CLI and boots a
//! local Supabase stack (stack.rs), then the `main` workspace window — the same SPA
//! the web build serves — with the stack's URL/key injected as
//! `window.__SUPANET_CONFIG__` (read by src/lib/supabase.ts).

mod stack;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn open_workspace(app: tauri::AppHandle, api_url: String, anon_key: String) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("main") {
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let config = serde_json::json!({ "supabaseUrl": api_url, "supabaseAnonKey": anon_key });
    WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("/".into()))
        .title("SupaNet")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(&format!("window.__SUPANET_CONFIG__ = {config};"))
        .build()
        .map_err(|e| e.to_string())?;
    // Main exists now, so closing the launcher doesn't end the app; closing main does.
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.close();
    }
    Ok(())
}

pub fn run() {
    stack::extend_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(stack::StackState::default())
        .invoke_handler(tauri::generate_handler![
            stack::check_prereqs,
            stack::load_settings,
            stack::save_settings,
            stack::start_stack,
            open_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the SupaNet desktop app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stack::shutdown(handle);
        }
    });
}
