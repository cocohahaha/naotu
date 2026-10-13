//! macOS 菜单栏。菜单项只负责把 id 发给前端（"menu" 事件），具体动作都在前端 store 里执行，
//! 和键盘、agent 走同一条路径。
//!
//! 快捷键归菜单所有：WebKit 先把 ⌘ 组合键交给网页，网页没处理才轮到菜单，
//! 所以前端在桌面版里不再自己处理这些组合键，避免一次按键执行两遍。

use std::path::Path;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

pub struct AppMenu {
    recent: Submenu<Wry>,
    /// 没有打开脑图时置灰的菜单项
    doc_items: Vec<MenuItem<Wry>>,
}

fn item(app: &AppHandle, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, true, accel)
}

pub fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, AppMenu)> {
    let sep = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        comments: Some("本地脑图，直接读写 .xmind".into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "Naotu",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Naotu"), Some(about))?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some("服务"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Naotu"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &sep()?,
            // 不用系统自带的退出：它会跳过关窗确认，未命名的脑图会直接丢掉
            &item(app, "quit", "退出 Naotu", Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    let recent = Submenu::with_id(app, "recent", "打开最近使用", true)?;
    let save = item(app, "save", "保存", Some("CmdOrCtrl+S"))?;
    let save_as = item(app, "save_as", "另存为…", Some("CmdOrCtrl+Shift+S"))?;
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item(app, "new", "新建", Some("CmdOrCtrl+N"))?,
            &item(app, "open", "打开…", Some("CmdOrCtrl+O"))?,
            &recent,
            &sep()?,
            &save,
            &save_as,
            &sep()?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;

    let undo = item(app, "undo", "撤销", Some("CmdOrCtrl+Z"))?;
    let redo = item(app, "redo", "重做", Some("CmdOrCtrl+Shift+Z"))?;
    let fold = item(app, "fold", "折叠 / 展开分支", Some("CmdOrCtrl+/"))?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &undo,
            &redo,
            &sep()?,
            // 剪切 / 拷贝 / 粘贴用系统项：它们触发网页的 copy / cut / paste 事件，
            // 输入框里是普通文本操作，画布上由前端换成 Markdown 大纲
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &sep()?,
            &fold,
        ],
    )?;

    let zoom_in = item(app, "zoom_in", "放大", Some("CmdOrCtrl+="))?;
    let zoom_out = item(app, "zoom_out", "缩小", Some("CmdOrCtrl+-"))?;
    let fit = item(app, "fit", "适应窗口", Some("CmdOrCtrl+0"))?;
    let layout = item(app, "layout", "切换布局", None)?;
    let notes = item(app, "notes", "备注面板", Some("CmdOrCtrl+Shift+N"))?;
    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &zoom_in,
            &zoom_out,
            &fit,
            &sep()?,
            &layout,
            &notes,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?,
        ],
    )?;
    // 空的帮助菜单交给系统，macOS 会在里面放菜单搜索框
    let help_menu = Submenu::with_items(app, "帮助", true, &[])?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])?;
    #[cfg(target_os = "macos")]
    {
        window_menu.set_as_windows_menu_for_nsapp()?;
        help_menu.set_as_help_menu_for_nsapp()?;
    }

    let doc_items = vec![save, save_as, undo, redo, fold, zoom_in, zoom_out, fit, layout, notes];
    let state = AppMenu { recent, doc_items };
    fill_recent(app, &state.recent, &[])?;
    sync(&state, false)?;
    Ok((menu, state))
}

fn sync(state: &AppMenu, has_doc: bool) -> tauri::Result<()> {
    for it in &state.doc_items {
        it.set_enabled(has_doc)?;
    }
    Ok(())
}

fn fill_recent(app: &AppHandle, sub: &Submenu<Wry>, paths: &[String]) -> tauri::Result<()> {
    for old in sub.items()? {
        sub.remove(&old)?;
    }
    let name = |p: &str| Path::new(p).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string());
    for p in paths {
        let n = name(p);
        // 同名文件在不同文件夹时，后面带上所在文件夹名区分
        let dup = paths.iter().filter(|q| name(q) == n).count() > 1;
        let label = match Path::new(p).parent().and_then(|d| d.file_name()) {
            Some(dir) if dup => format!("{n}（{}）", dir.to_string_lossy()),
            _ => n,
        };
        sub.append(&MenuItem::with_id(app, format!("recent:{p}"), label, true, None::<&str>)?)?;
    }
    if !paths.is_empty() {
        sub.append(&PredefinedMenuItem::separator(app)?)?;
    }
    sub.append(&MenuItem::with_id(app, "recent_clear", "清除菜单", !paths.is_empty(), None::<&str>)?)?;
    Ok(())
}

/// 前端在“是否有打开的脑图”或“最近文件”变化时调用
#[tauri::command]
pub fn sync_menu(app: AppHandle, state: State<AppMenu>, has_doc: bool, recent: Vec<String>) -> Result<(), String> {
    sync(&state, has_doc).and_then(|_| fill_recent(&app, &state.recent, &recent)).map_err(|e| e.to_string())
}

pub fn on_event(app: &AppHandle, id: &str) {
    if id == "quit" {
        return request_quit(app);
    }
    let _ = app.emit("menu", id);
}

/// 退出走关窗流程：前端在关窗前会保存有路径的文件、对未命名的改动弹确认。
/// 窗口关掉后应用随之退出。
pub fn request_quit(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            let _ = w.close();
        }
        None => app.exit(0),
    }
}
