#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod menu;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

// 文件以 base64 过 IPC：.xmind 通常只有几十 KB，换来的是不用给前端开放整盘的 fs 插件权限。

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read(&path).map(|b| B64.encode(b)).map_err(|e| format!("读取失败 {path}: {e}"))
}

/// 先写同目录临时文件再 rename，写到一半崩溃也不会留下损坏的 .xmind
#[tauri::command]
fn write_file(path: String, data: String) -> Result<f64, String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    let target = Path::new(&path);
    let dir = target.parent().ok_or("路径没有父目录")?;
    let name = target.file_name().ok_or("路径没有文件名")?.to_string_lossy();
    let tmp: PathBuf = dir.join(format!(".{name}.naotu-tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入失败 {path}: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| format!("保存失败 {path}: {e}"))?;
    mtime(target)
}

#[tauri::command]
fn file_mtime(path: String) -> Result<f64, String> {
    mtime(Path::new(&path))
}

fn mtime(p: &Path) -> Result<f64, String> {
    let m = std::fs::metadata(p).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
    Ok(m.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge::Pending::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_mtime,
            bridge::agent_reply,
            bridge::bridge_ready,
            menu::sync_menu
        ])
        .setup(|app| {
            let (bar, state) = menu::build(app.handle())?;
            app.set_menu(bar)?;
            app.manage(state);
            app.on_menu_event(|app, e| menu::on_event(app, e.id().as_ref()));
            bridge::start(app.handle().clone())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Naotu 启动失败")
        .run(|app, event| match event {
            // 从程序坞退出等系统发起的退出：窗口还在就先走关窗确认，窗口关掉后会再来一次，那时放行
            tauri::RunEvent::ExitRequested { code: None, api, .. } if app.get_webview_window("main").is_some() => {
                api.prevent_exit();
                menu::request_quit(app);
            }
            tauri::RunEvent::Exit => bridge::cleanup(),
            _ => {}
        });
}
