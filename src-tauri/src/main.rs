// Retocker Snap: screenshots for Windows. Press PrintScreen, pick an area — copy, save or take the text.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cap;
mod cfg;
mod clip;
mod hist;
mod hook;
mod logx;
mod ocr;
mod setup;
mod sys;
mod upd;
mod win;

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};

/// the same for every window: they share one WebView2 browser, which needs identical arguments
const ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding";

static OVL: AtomicIsize = AtomicIsize::new(0);
static CARD: AtomicIsize = AtomicIsize::new(0);
static MAIN: AtomicIsize = AtomicIsize::new(0);
/// the overlay is up (or coming up): a second hotkey press is ignored
static ACTIVE: AtomicBool = AtomicBool::new(false);
// the round menu shows its own result, so its actions skip the corner card
static NO_CARD: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(0);
/// the last area, in screen pixels («повторить прошлую область»)
static LAST: Mutex<Option<cap::R>> = Mutex::new(None);
/// the preview of the last snapshot, for the corner card
static THUMB: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static UPDATED: OnceLock<String> = OnceLock::new();

fn h(a: &AtomicIsize) -> HWND {
  win::hwnd_of(a.load(Ordering::SeqCst))
}

fn show_main(app: &AppHandle, page: Option<&str>) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if let Ok(hw) = w.hwnd() {
      win::force_front(hw);
    }
    if let Some(p) = page {
      let _ = app.emit_to("main", "page", p);
    }
  }
}

fn apply_hotkeys() {
  let ids = hook::set_hotkeys(&cfg::hotkeys());
  logx::log(&format!("hotkeys: {}", ids.join(", ")));
}

// ---------------------------------------------------------------- the snapshot flow

fn to_frame(r: cap::R, f: &cap::Frame) -> cap::R {
  cap::R { x: r.x - f.x, y: r.y - f.y, w: r.w, h: r.h }
}

/// grab the screen into FRAME; returns its number
fn grab() -> Result<u64, String> {
  let t = std::time::Instant::now();
  let f = cap::grab()?;
  let n = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
  if hook::debug() {
    logx::log(&format!("grab {}x{} in {} ms", f.w, f.h, t.elapsed().as_millis()));
  }
  *cap::FRAME.lock().unwrap_or_else(|e| e.into_inner()) = Some((n, f));
  Ok(n)
}

fn delay() {
  let s = cfg::num("delay", 0.0).clamp(0.0, 10.0);
  if s > 0.0 {
    std::thread::sleep(Duration::from_millis((s * 1000.0) as u64));
  }
}

/// the overlay: frozen screen, the user picks an area
fn start_overlay(app: &AppHandle, mode: &str) {
  if ACTIVE.swap(true, Ordering::SeqCst) {
    return;
  }
  hide_card();
  delay();
  let n = match grab() {
    Ok(n) => n,
    Err(e) => {
      logx::log(&format!("grab failed: {e}"));
      ACTIVE.store(false, Ordering::SeqCst);
      return;
    }
  };
  let (fx, fy, fw, fh) = {
    let g = cap::FRAME.lock().unwrap_or_else(|e| e.into_inner());
    let f = &g.as_ref().unwrap().1;
    (f.x, f.y, f.w, f.h)
  };
  let skip = [OVL.load(Ordering::SeqCst), CARD.load(Ordering::SeqCst), MAIN.load(Ordering::SeqCst)];
  let wins: Vec<Value> = cap::windows(&skip).into_iter().map(|w| json!({ "x": w.x - fx, "y": w.y - fy, "w": w.w, "h": w.h, "t": w.title })).collect();
  let mons: Vec<Value> = cap::monitors().into_iter().map(|m| json!({ "x": m.x - fx, "y": m.y - fy, "w": m.w, "h": m.h, "p": m.primary })).collect();
  let (cx, cy) = win::cursor();
  let ov = h(&OVL);
  win::place(ov, RECT { left: fx, top: fy, right: fx + fw, bottom: fy + fh });
  let last = LAST.lock().unwrap_or_else(|e| e.into_inner()).map(|r| json!({ "x": r.x - fx, "y": r.y - fy, "w": r.w, "h": r.h }));
  let _ = app.emit_to(
    "ovl",
    "shot",
    json!({ "n": n, "w": fw, "h": fh, "wins": wins, "mons": mons, "cur": [cx - fx, cy - fy], "mode": mode, "last": last, "cfg": cfg::all() }),
  );
  // if the page never answers (it crashed), don't leave the hotkey dead
  let a = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(2500));
    if ACTIVE.load(Ordering::SeqCst) && !visible(h(&OVL)) && SEQ.load(Ordering::SeqCst) == n {
      logx::log("overlay did not answer: showing it anyway");
      let _ = a.emit_to("ovl", "force", n);
      ovl_show_now();
    }
  });
}

fn visible(hw: HWND) -> bool {
  unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hw).as_bool() }
}

fn ovl_show_now() {
  let ov = h(&OVL);
  unsafe {
    let _ = ShowWindow(ov, windows::Win32::UI::WindowsAndMessaging::SW_SHOW);
  }
  win::keep_on_top(ov);
  win::force_front(ov);
}

/// full screen / window / last area: no overlay, straight to the action
fn quick(app: &AppHandle, kind: &str) {
  if ACTIVE.load(Ordering::SeqCst) {
    return;
  }
  hide_card();
  delay();
  let (cx, cy) = win::cursor();
  let skip = [OVL.load(Ordering::SeqCst), CARD.load(Ordering::SeqCst), MAIN.load(Ordering::SeqCst)];
  let r = match kind {
    "window" => {
      let fg = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
      let mut ws = cap::windows(&skip);
      let i = ws.iter().position(|w| cx >= w.x && cx < w.x + w.w && cy >= w.y && cy < w.y + w.h);
      let _ = fg;
      i.map(|i| ws.swap_remove(i)).map(|w| cap::R { x: w.x, y: w.y, w: w.w, h: w.h })
    }
    "last" => *LAST.lock().unwrap_or_else(|e| e.into_inner()),
    _ => cap::monitors().into_iter().find(|m| cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h).map(|m| cap::R { x: m.x, y: m.y, w: m.w, h: m.h }),
  };
  let Some(r) = r else {
    if kind == "last" {
      start_overlay(app, "area");
    }
    return;
  };
  if grab().is_err() {
    return;
  }
  let fr = {
    let g = cap::FRAME.lock().unwrap_or_else(|e| e.into_inner());
    to_frame(r, &g.as_ref().unwrap().1)
  };
  let action = cfg::str_("quickAction", "copy");
  let a = app.clone();
  std::thread::spawn(move || {
    let _ = do_action(&a, fr, &action);
  });
}

fn hide_card() {
  let c = h(&CARD);
  if visible(c) {
    unsafe {
      let _ = ShowWindow(c, SW_HIDE);
    }
  }
}

fn show_card(app: &AppHandle, v: &Value) {
  if NO_CARD.swap(false, Ordering::SeqCst) || !cfg::bool_("cardOn", true) {
    return;
  }
  let Some(w) = app.get_webview_window("card") else { return };
  let k = w.scale_factor().unwrap_or(1.0);
  let wa = win::work_area();
  let (cw, ch) = ((380.0 * k) as i32, (300.0 * k) as i32);
  let pos = cfg::str_("cardPos", "br");
  let m = (8.0 * k) as i32;
  let x = if pos.ends_with('l') { wa.left + m } else { wa.right - cw - m };
  let y = if pos.starts_with('t') { wa.top + m } else { wa.bottom - ch - m };
  let c = h(&CARD);
  win::place(c, RECT { left: x, top: y, right: x + cw, bottom: y + ch });
  let _ = app.emit_to("card", "card", v);
  unsafe {
    let _ = ShowWindow(c, SW_SHOWNOACTIVATE);
  }
  win::keep_on_top(c);
}

fn pictures() -> std::path::PathBuf {
  let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
  std::path::PathBuf::from(home).join("Pictures").join("Retocker Snap")
}

/// the file name from the template: {date} {time} {yyyy} {MM} {dd} {HH} {mm} {ss} {w} {h} {n}
fn file_name(tpl: &str, w: u32, h: u32) -> String {
  let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
  let n = cfg::num("saveCounter", 0.0) as u64 + 1;
  cfg::merge(&json!({ "saveCounter": n }));
  let s = tpl
    .replace("{date}", &format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay))
    .replace("{time}", &format!("{:02}-{:02}-{:02}", t.wHour, t.wMinute, t.wSecond))
    .replace("{yyyy}", &format!("{:04}", t.wYear))
    .replace("{MM}", &format!("{:02}", t.wMonth))
    .replace("{dd}", &format!("{:02}", t.wDay))
    .replace("{HH}", &format!("{:02}", t.wHour))
    .replace("{mm}", &format!("{:02}", t.wMinute))
    .replace("{ss}", &format!("{:02}", t.wSecond))
    .replace("{w}", &w.to_string())
    .replace("{h}", &h.to_string())
    .replace("{n}", &n.to_string());
  let s: String = s.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect();
  let s = s.trim().trim_end_matches('.').to_string();
  if s.is_empty() {
    "Snap".into()
  } else {
    s
  }
}

fn save_file(w: u32, hh: u32, bgra: &[u8], png: &[u8]) -> Result<std::path::PathBuf, String> {
  let dir = cfg::str_("saveDir", "");
  let dir = if dir.trim().is_empty() { pictures() } else { std::path::PathBuf::from(dir.trim()) };
  std::fs::create_dir_all(&dir).map_err(|e| format!("Не получилось создать папку: {e}"))?;
  let fmt = cfg::str_("saveFmt", "png");
  let ext = match fmt.as_str() {
    "jpg" => "jpg",
    "webp" => "webp",
    _ => "png",
  };
  let bytes = if ext == "png" { png.to_vec() } else { cap::encode(w, hh, bgra, ext, cfg::num("saveQ", 92.0) as u8)? };
  let base = file_name(&cfg::str_("saveName", "Snap {date} {time}"), w, hh);
  let mut p = dir.join(format!("{base}.{ext}"));
  let mut i = 2;
  while p.exists() {
    p = dir.join(format!("{base} ({i}).{ext}"));
    i += 1;
  }
  std::fs::write(&p, bytes).map_err(|e| format!("Не получилось сохранить: {e}"))?;
  Ok(p)
}

fn groq_opts() -> ocr::GroqOpts {
  ocr::GroqOpts {
    key: cfg::str_("groqKey", ""),
    model: cfg::str_("groqModel", "meta-llama/llama-4-scout-17b-16e-instruct"),
    prompt: cfg::str_(
      "groqPrompt",
      "Перепиши весь текст с картинки точно как есть, сохраняя строки, абзацы и списки. Таблицы — в Markdown. Без комментариев, только текст.",
    ),
    proxy: cfg::str_("groqProxy", ""),
  }
}

fn read_text(w: u32, hh: u32, bgra: &[u8], ai: bool) -> Result<String, String> {
  if ai {
    let jpg = cap::encode(w, hh, bgra, "jpg", 92)?;
    ocr::groq(&jpg, &groq_opts())
  } else {
    let t = ocr::windows(w, hh, bgra, &cfg::str_("ocrLang", ""))?;
    // nothing found by Windows: try Groq if there is a key and the user allows it
    if t.trim().is_empty() && cfg::bool_("ocrFallback", true) && !cfg::str_("groqKey", "").trim().is_empty() {
      let jpg = cap::encode(w, hh, bgra, "jpg", 92)?;
      return ocr::groq(&jpg, &groq_opts());
    }
    Ok(t)
  }
}

/// crop, then copy / save / read the text; the corner card shows the result
fn do_action(app: &AppHandle, r: cap::R, action: &str) -> Result<Value, String> {
  let t0 = std::time::Instant::now();
  let (w, hh, bgra, screen) = {
    let g = cap::FRAME.lock().unwrap_or_else(|e| e.into_inner());
    let (_, f) = g.as_ref().ok_or("нет снимка")?;
    let (w, hh, b) = cap::crop(f, r).ok_or("пустая область")?;
    (w, hh, b, cap::R { x: r.x + f.x, y: r.y + f.y, w: r.w, h: r.h })
  };
  *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(screen);
  let png = cap::encode(w, hh, &bgra, "png", 0)?;
  let thumb = cap::thumb(w, hh, &bgra, 720);
  *THUMB.lock().unwrap_or_else(|e| e.into_inner()) = thumb.clone();
  let id = if cfg::bool_("histOn", true) { hist::add(w, hh, &png, &thumb) } else { None };
  let n = SEQ.load(Ordering::SeqCst);
  let mut out = json!({ "id": id, "w": w, "h": hh, "action": action, "thumb": format!("thumb?n={n}") });
  let owner = h(&MAIN);
  let ai = action == "ai";
  match action {
    "save" => {
      match save_file(w, hh, &bgra, &png) {
        Ok(p) => out["path"] = json!(p.display().to_string()),
        Err(e) => out["error"] = json!(e),
      }
      if cfg::bool_("saveAlsoCopy", true) {
        clip::set_image(owner, w, hh, &bgra, &png);
      }
    }
    "ocr" | "ai" => {
      out["busy"] = json!(true);
      show_card(app, &out);
      out["busy"] = json!(false);
      match read_text(w, hh, &bgra, ai) {
        Ok(t) => {
          if !t.trim().is_empty() {
            clip::set_text(owner, &t);
          }
          if let Some(id) = &id {
            hist::set_text(id, &t);
          }
          out["text"] = json!(t);
        }
        Err(e) => out["error"] = json!(e),
      }
    }
    _ => {
      if !clip::set_image(owner, w, hh, &bgra, &png) {
        out["error"] = json!("Буфер обмена занят другой программой");
      }
      if cfg::bool_("copyAlsoSave", false) {
        if let Ok(p) = save_file(w, hh, &bgra, &png) {
          out["path"] = json!(p.display().to_string());
        }
      }
    }
  }
  out["ms"] = json!(t0.elapsed().as_millis() as u64);
  logx::log(&format!("{action} {w}x{hh} in {} ms{}", t0.elapsed().as_millis(), out["error"].as_str().map(|e| format!(" — {e}")).unwrap_or_default()));
  show_card(app, &out);
  let _ = app.emit_to("main", "hist", &out);
  Ok(out)
}

// ---------------------------------------------------------------- commands

#[derive(Deserialize)]
struct Rect {
  x: f64,
  y: f64,
  w: f64,
  h: f64,
}

/// the overlay decoded the new frame: show it
#[tauri::command]
fn ovl_ready(n: u64) {
  if SEQ.load(Ordering::SeqCst) == n && ACTIVE.load(Ordering::SeqCst) {
    ovl_show_now();
  }
}

#[tauri::command]
fn ovl_hide() {
  unsafe {
    let _ = ShowWindow(h(&OVL), SW_HIDE);
  }
  ACTIVE.store(false, Ordering::SeqCst);
}

#[tauri::command]
async fn shot_do(app: AppHandle, r: Rect, action: String, card: Option<bool>) -> Result<Value, String> {
  NO_CARD.store(card == Some(false), Ordering::SeqCst);
  let r = cap::R { x: r.x.round() as i32, y: r.y.round() as i32, w: r.w.round() as i32, h: r.h.round() as i32 };
  tauri::async_runtime::spawn_blocking(move || do_action(&app, r, &action)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn card_hide() {
  hide_card();
}

#[tauri::command]
fn cfg_get() -> Value {
  cfg::all()
}

#[tauri::command]
fn cfg_set(app: AppHandle, v: Value) {
  cfg::merge(&v);
  if v.as_object().map(|o| o.keys().any(|k| k.starts_with("hk_"))).unwrap_or(false) {
    apply_hotkeys();
  }
  let _ = app.emit("cfg", &v);
}

#[tauri::command]
fn hk_record(on: bool) {
  hook::set_record(on);
}

#[tauri::command]
fn set_paused(on: bool) {
  hook::set_paused(on);
}

#[tauri::command]
fn snap_now(app: AppHandle, kind: String) {
  std::thread::spawn(move || {
    // let the settings window get out of the way first
    std::thread::sleep(Duration::from_millis(250));
    match kind.as_str() {
      "full" | "window" | "last" => quick(&app, &kind),
      k => start_overlay(&app, k),
    }
  });
}

#[tauri::command]
fn hist_list(limit: Option<usize>) -> Vec<hist::Item> {
  hist::list(limit.unwrap_or(300))
}

#[tauri::command]
fn hist_del(id: String) {
  hist::remove(&id);
}

#[tauri::command]
fn hist_clear() {
  hist::clear();
}

fn hist_bgra(id: &str) -> Result<(u32, u32, Vec<u8>, Vec<u8>), String> {
  let png = hist::read(id, "png").ok_or("файл не найден")?;
  let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(|e| e.to_string())?.to_rgba8();
  let (w, hh) = img.dimensions();
  let mut b = img.into_raw();
  for p in b.chunks_exact_mut(4) {
    p.swap(0, 2);
  }
  Ok((w, hh, b, png))
}

#[tauri::command]
async fn hist_copy(id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (w, hh, b, png) = hist_bgra(&id)?;
    if clip::set_image(h(&MAIN), w, hh, &b, &png) {
      Ok(())
    } else {
      Err("Буфер обмена занят".into())
    }
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hist_text(id: String, ai: bool) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (w, hh, b, _) = hist_bgra(&id)?;
    let t = read_text(w, hh, &b, ai)?;
    hist::set_text(&id, &t);
    if !t.trim().is_empty() {
      clip::set_text(h(&MAIN), &t);
    }
    Ok(t)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn hist_save(id: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (w, hh, b, png) = hist_bgra(&id)?;
    save_file(w, hh, &b, &png).map(|p| p.display().to_string())
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
fn hist_open(id: String) {
  if let Some(p) = hist::png_path(&id) {
    win::open_url(&p.display().to_string());
  }
}

#[tauri::command]
fn copy_text(text: String) -> bool {
  clip::set_text(h(&MAIN), &text)
}

/// open a file or a folder with Explorer (only our own places or the save folder)
#[tauri::command]
fn open_path(p: String, select: Option<bool>) {
  let path = std::path::PathBuf::from(&p);
  if !path.exists() {
    return;
  }
  if select.unwrap_or(false) {
    let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn();
  } else {
    win::open_url(&path.display().to_string());
  }
}

#[tauri::command]
fn open_save_dir() {
  let dir = cfg::str_("saveDir", "");
  let dir = if dir.trim().is_empty() { pictures() } else { std::path::PathBuf::from(dir.trim()) };
  let _ = std::fs::create_dir_all(&dir);
  win::open_url(&dir.display().to_string());
}

#[tauri::command]
fn default_save_dir() -> String {
  pictures().display().to_string()
}

#[tauri::command]
fn name_preview(tpl: String) -> String {
  let n = cfg::num("saveCounter", 0.0);
  let s = file_name(&tpl, 1280, 720);
  cfg::merge(&json!({ "saveCounter": n }));
  s
}

#[tauri::command]
async fn groq_test(key: String, proxy: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || ocr::groq_ping(&key, &proxy)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn show_settings(app: AppHandle, page: Option<String>) {
  show_main(&app, page.as_deref());
}

#[tauri::command]
fn quit(app: AppHandle) {
  app.exit(0);
}

#[tauri::command]
fn app_info(app: AppHandle) -> Value {
  json!({
    "version": app.package_info().version.to_string(),
    "autostart": win::autostart_get(),
    "logs": logx::dir().map(|d| d.display().to_string()).unwrap_or_default(),
    "updated": UPDATED.get().cloned().unwrap_or_default(),
    "installed": setup::installed_dir().is_some(),
    "hist": hist::dir().display().to_string(),
  })
}

#[tauri::command]
async fn upd_check(app: AppHandle) -> Result<Value, String> {
  let cur = app.package_info().version.to_string();
  tauri::async_runtime::spawn_blocking(move || {
    upd::check().map(|m| {
      json!({ "version": m.version, "notes": m.notes, "size": m.size, "url": m.url, "newer": upd::newer(&m.version, &cur),
        "can": !m.sha256.is_empty() && !m.sig.is_empty() && !m.url.is_empty() })
    })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
fn upd_install(app: AppHandle) {
  std::thread::spawn(move || {
    let _ = upd::install(app);
  });
}

#[tauri::command]
fn autostart(on: bool) -> bool {
  win::autostart_set(on) && win::autostart_get() == on
}

#[tauri::command]
fn open_url(url: String) {
  if url.starts_with("https://") || url.starts_with("http://") {
    win::open_url(&url);
  }
}

#[tauri::command]
fn open_logs() {
  if let Some(d) = logx::dir() {
    win::open_url(&d.display().to_string());
  }
}

#[tauri::command]
fn log(msg: String) {
  logx::log(&format!("js: {}", msg.chars().take(2000).collect::<String>()));
}

#[tauri::command]
fn win_ctl(window: WebviewWindow, a: String) {
  match a.as_str() {
    "min" => {
      let _ = window.minimize();
    }
    "max" => {
      if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
      } else {
        let _ = window.maximize();
      }
    }
    _ => {
      let _ = window.hide();
    }
  }
}

// ---------------------------------------------------------------- the snap:// pictures

fn respond(mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
  tauri::http::Response::builder()
    .status(if body.is_empty() { 404 } else { 200 })
    .header("Content-Type", mime)
    .header("Cache-Control", "max-age=600")
    .header("Access-Control-Allow-Origin", "*")
    .body(body)
    .unwrap()
}

fn serve(req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
  let path = req.uri().path().trim_start_matches('/').to_string();
  if path == "frame" {
    let g = cap::FRAME.lock().unwrap_or_else(|e| e.into_inner());
    return respond("image/bmp", g.as_ref().map(|(_, f)| cap::bmp(f)).unwrap_or_default());
  }
  if path == "thumb" {
    return respond("image/jpeg", THUMB.lock().unwrap_or_else(|e| e.into_inner()).clone());
  }
  if let Some(f) = path.strip_prefix("hist/") {
    if let Some((id, ext)) = f.rsplit_once('.') {
      if ext == "jpg" || ext == "png" {
        return respond(if ext == "jpg" { "image/jpeg" } else { "image/png" }, hist::read(id, ext).unwrap_or_default());
      }
    }
  }
  respond("text/plain", Vec::new())
}

// ---------------------------------------------------------------- start

fn main() {
  let args: Vec<String> = std::env::args().collect();
  if let Some(t) = setup::arg_after(&args, "--apply-update") {
    std::process::exit(upd::apply_elevated(&t));
  }
  if let Some(d) = setup::arg_after(&args, "--install-files") {
    std::process::exit(setup::install_files_elevated(&d));
  }
  logx::init(cfg::dir().join("logs"));
  std::panic::set_hook(Box::new(|p| logx::log(&format!("panic: {p}"))));
  if let Some(pid) = setup::arg_after(&args, "--wait-pid").and_then(|s| s.parse::<u32>().ok()) {
    let gone = sys::wait_pid(pid, 20000);
    logx::log(&format!("waited for the old copy ({pid}): {}", if gone { "gone" } else { "still there" }));
  }
  if let Some(v) = setup::arg_after(&args, "--updated") {
    let _ = UPDATED.set(v);
  }
  let ctx = tauri::generate_context!();
  let ver = ctx.package_info().version.to_string();
  let mode = setup::mode(&args);
  if mode != setup::Mode::App && args.iter().any(|a| a == "--silent" || a == "/S") {
    std::process::exit(setup::silent(mode, &ver, &args));
  }
  if !sys::webview2_ensure() {
    std::process::exit(1);
  }
  if mode != setup::Mode::App {
    logx::log(&format!("{mode:?} v{ver}"));
    setup::run_ui(mode, ctx);
    return;
  }
  upd::cleanup_old();
  run_app(ctx, args.iter().any(|a| a == "--autostart"));
}

fn on_second(app: &AppHandle, args: Vec<String>) {
  let dbg = hook::debug();
  // RA_DEBUG only (the build check)
  if dbg {
    if let Some(k) = setup::arg_after(&args, "--test-shot") {
      hook::test_fire(&k);
      return;
    }
    if let Some(s) = setup::arg_after(&args, "--test-cfg") {
      if let Some((k, v)) = s.split_once('=') {
        let val: Value = serde_json::from_str(v).unwrap_or_else(|_| Value::String(v.to_string()));
        let mut m = serde_json::Map::new();
        m.insert(k.to_string(), val);
        let o = Value::Object(m);
        cfg::merge(&o);
        let _ = app.emit("cfg", &o);
      }
      return;
    }
    if let Some(s) = setup::arg_after(&args, "--test-sel") {
      let _ = app.emit_to("ovl", "test_sel", s);
      return;
    }
    if let Some(p) = setup::arg_after(&args, "--test-page") {
      show_main(app, Some(&p));
      return;
    }
    if args.iter().any(|a| a == "--test-update") {
      let a = app.clone();
      std::thread::spawn(move || {
        let _ = upd::install(a);
      });
      return;
    }
  }
  if args.iter().any(|a| a == "--snap") {
    let a = app.clone();
    std::thread::spawn(move || start_overlay(&a, "area"));
    return;
  }
  show_main(app, None)
}

fn run_app(ctx: tauri::Context<tauri::Wry>, autostarted: bool) {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| on_second(app, args)))
    .register_uri_scheme_protocol("snap", |_ctx, req| serve(&req))
    .invoke_handler(tauri::generate_handler![
      ovl_ready, ovl_hide, shot_do, card_hide, cfg_get, cfg_set, hk_record, set_paused, snap_now, hist_list, hist_del, hist_clear, hist_copy,
      hist_text, hist_save, hist_open, copy_text, open_path, open_save_dir, default_save_dir, name_preview, groq_test, show_settings, quit,
      app_info, upd_check, upd_install, autostart, open_url, open_logs, log, win_ctl
    ])
    .setup(move |app| {
      let hnd = app.handle().clone();
      logx::log(&format!("start v{} autostart={autostarted} updated={}", app.package_info().version, UPDATED.get().map(|s| s.as_str()).unwrap_or("")));
      let v = cap::virtual_screen();

      // the overlay: the frozen screen over every monitor, created once and kept hidden so it opens instantly
      let ovl = WebviewWindowBuilder::new(app, "ovl", WebviewUrl::App("overlay.html".into()))
        .title("Retocker Snap — выделение")
        .inner_size(800.0, 600.0)
        .position(0.0, 0.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .additional_browser_args(ARGS)
        .build()?;
      if let Ok(hw) = ovl.hwnd() {
        OVL.store(hw.0 as isize, Ordering::SeqCst);
        win::place(hw, RECT { left: v.x, top: v.y, right: v.x + v.w, bottom: v.y + v.h });
      }

      // the corner card after a snapshot
      let card = WebviewWindowBuilder::new(app, "card", WebviewUrl::App("card.html".into()))
        .title("Retocker Snap — снимок")
        .inner_size(380.0, 300.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .additional_browser_args(ARGS)
        .build()?;
      if let Ok(hw) = card.hwnd() {
        CARD.store(hw.0 as isize, Ordering::SeqCst);
      }

      // settings
      let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("settings.html".into()))
        .title("Retocker Snap")
        .inner_size(1040.0, 700.0)
        .min_inner_size(900.0, 580.0)
        .center()
        .decorations(false)
        .shadow(true)
        .visible(false)
        .background_color(tauri::window::Color(25, 25, 25, 255))
        .additional_browser_args(ARGS)
        .build()?;
      if let Ok(hw) = main.hwnd() {
        MAIN.store(hw.0 as isize, Ordering::SeqCst);
      }
      {
        let m2 = main.clone();
        main.on_window_event(move |e| {
          if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = m2.hide();
          }
        });
      }

      // tray
      let snap_i = MenuItem::with_id(app, "snap", "Снимок области", true, None::<&str>)?;
      let full_i = MenuItem::with_id(app, "full", "Снимок экрана", true, None::<&str>)?;
      let text_i = MenuItem::with_id(app, "text", "Текст с экрана", true, None::<&str>)?;
      let sep = PredefinedMenuItem::separator(app)?;
      let open = MenuItem::with_id(app, "open", "Настройки", true, None::<&str>)?;
      let hist_i = MenuItem::with_id(app, "hist", "История", true, None::<&str>)?;
      let sep2 = PredefinedMenuItem::separator(app)?;
      let quit_i = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&snap_i, &full_i, &text_i, &sep, &open, &hist_i, &sep2, &quit_i])?;
      let mut tb = TrayIconBuilder::with_id("tray")
        .tooltip("Retocker Snap")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
          "snap" => snap_now(app.clone(), "area".into()),
          "full" => snap_now(app.clone(), "full".into()),
          "text" => snap_now(app.clone(), "text".into()),
          "open" => show_main(app, None),
          "hist" => show_main(app, Some("hist")),
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, e| {
          if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            let a = tray.app_handle().clone();
            if cfg::str_("trayClick", "snap") == "snap" {
              snap_now(a, "area".into());
            } else {
              show_main(&a, None);
            }
          }
        });
      if let Some(i) = app.default_window_icon() {
        tb = tb.icon(i.clone());
      }
      tb.build(app)?;

      // keyboard
      let hh = hnd.clone();
      hook::start(move |e| match e {
        hook::Ev::Hk(id) => match id.as_str() {
          "full" | "window" | "last" => quick(&hh, &id),
          k => start_overlay(&hh, k),
        },
        hook::Ev::Rec { name, down, m } => {
          let _ = hh.emit_to("main", "rec", json!({ "name": name, "down": down, "m": m }));
        }
        _ => {}
      });
      apply_hotkeys();

      let first = !cfg::bool_("welcomed", false);
      if first {
        cfg::merge(&json!({ "welcomed": true }));
      }
      if !autostarted && (first || !cfg::bool_("startHidden", true)) {
        let _ = main.show();
        let _ = main.set_focus();
      }
      Ok(())
    })
    .run(ctx)
    .expect("Retocker Snap could not start");
}
