//! Agent 桥：本机 HTTP 端口 → 转发给 webview 执行 → 等回执 → 回给调用方。
//!
//! 所有操作都在前端 store 里执行，所以 agent 的修改会进撤销栈、实时渲染、自动保存，
//! 和用户亲手操作走完全相同的路径。这一层只负责鉴权和转发。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Pending {
    waiters: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
    ready: AtomicBool,
}

fn bridge_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".naotu")
}

pub fn bridge_file() -> PathBuf {
    bridge_dir().join("bridge.json")
}

pub fn start(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("无法获取端口")?;
    let token = uuid::Uuid::new_v4().simple().to_string();

    // token 只写在仅本人可读的文件里：网页无法读到它，也就无法冒充 agent 调用本机端口
    let dir = bridge_dir();
    std::fs::create_dir_all(&dir)?;
    let info = json!({ "port": port, "token": token, "pid": std::process::id() });
    std::fs::write(bridge_file(), serde_json::to_vec_pretty(&info)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(bridge_file(), std::fs::Permissions::from_mode(0o600))?;
    }

    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle(app, req, &token));
        }
    });
    Ok(())
}

pub fn cleanup() {
    // 只删属于本进程的桥文件，避免误删新启动实例写的文件
    if let Ok(text) = std::fs::read_to_string(bridge_file()) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if v["pid"].as_u64() == Some(std::process::id() as u64) {
                let _ = std::fs::remove_file(bridge_file());
            }
        }
    }
}

fn respond(req: tiny_http::Request, status: u16, body: Value) {
    let header = "Content-Type: application/json; charset=utf-8".parse::<tiny_http::Header>().unwrap();
    let resp = tiny_http::Response::from_string(body.to_string()).with_status_code(status).with_header(header);
    let _ = req.respond(resp);
}

fn handle(app: AppHandle, mut req: tiny_http::Request, token: &str) {
    let expected = format!("Bearer {token}");
    // tiny_http 的 HeaderField::equiv 只接受 &'static str
    let header = |name: &'static str| {
        req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
    };
    // 浏览器发起的请求一定带 Origin，直接拒绝
    if header("Origin").is_some() {
        return respond(req, 403, json!({ "ok": false, "error": "forbidden" }));
    }
    if header("Authorization").as_deref() != Some(expected.as_str()) {
        return respond(req, 401, json!({ "ok": false, "error": "unauthorized" }));
    }
    if req.method() != &tiny_http::Method::Post || req.url() != "/rpc" {
        return respond(req, 404, json!({ "ok": false, "error": "POST /rpc only" }));
    }

    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        return respond(req, 400, json!({ "ok": false, "error": "bad body" }));
    }
    let msg: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return respond(req, 400, json!({ "ok": false, "error": e.to_string() })),
    };
    let method = msg["method"].as_str().unwrap_or("").to_string();
    let pending = app.state::<Pending>();

    if method == "ping" {
        let ready = pending.ready.load(Ordering::SeqCst);
        return respond(req, 200, json!({ "ok": true, "result": { "ready": ready, "pid": std::process::id() } }));
    }
    if !pending.ready.load(Ordering::SeqCst) {
        return respond(req, 503, json!({ "ok": false, "error": "界面还没加载完，请稍后重试" }));
    }

    let id = pending.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    pending.waiters.lock().unwrap().insert(id, tx);
    let payload = json!({ "id": id, "method": method, "params": msg.get("params").cloned().unwrap_or(json!({})) });
    if let Err(e) = app.emit("agent-rpc", payload) {
        pending.waiters.lock().unwrap().remove(&id);
        return respond(req, 500, json!({ "ok": false, "error": e.to_string() }));
    }
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(v) => respond(req, 200, v),
        Err(_) => {
            pending.waiters.lock().unwrap().remove(&id);
            respond(req, 504, json!({ "ok": false, "error": "界面响应超时" }))
        }
    }
}

#[tauri::command]
pub fn agent_reply(id: u64, payload: Value, state: State<Pending>) {
    if let Some(tx) = state.waiters.lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
}

#[tauri::command]
pub fn bridge_ready(state: State<Pending>) {
    state.ready.store(true, Ordering::SeqCst);
}
