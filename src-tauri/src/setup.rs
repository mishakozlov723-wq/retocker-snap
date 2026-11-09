//! The installer and the uninstaller — the same exe as the app. Named «…Setup….exe» it installs itself;
//! started with --uninstall it removes itself. Both show a small window in the app's style (ui/setup.html);
//! with --silent they work without one (the build check uses that).
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::System::Registry::HKEY_CURRENT_USER;

use crate::{logx, sys};

pub const UNINST_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RetockerSnap";
const RUN: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const EXE: &str = "retocker-snap.exe";
const NAME: &str = "Retocker Snap";
const IDENT: &str = "com.retocker.snap";

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum Mode {
  App,
  Setup,
  Uninstall,
}

pub fn mode(args: &[String]) -> Mode {
  if args.iter().any(|a| a == "--uninstall") {
    return Mode::Uninstall;
  }
  if args.iter().any(|a| a == "--app") {
    return Mode::App;
  }
  let name = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())).unwrap_or_default();
  if name.contains("setup") {
    Mode::Setup
  } else {
    Mode::App
  }
}

pub fn arg_after(args: &[String], k: &str) -> Option<String> {
  args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
}

/// where our own installer put the app (None if it is not installed that way)
pub fn installed_dir() -> Option<PathBuf> {
  sys::reg_get(HKEY_CURRENT_USER, UNINST_KEY, "InstallLocation").map(PathBuf::from).filter(|d| d.join(EXE).exists())
}

pub fn default_dir() -> PathBuf {
  installed_dir().unwrap_or_else(|| sys::local_appdata().join("Programs").join(NAME))
}

fn nsis_dir(name: &str) -> Option<PathBuf> {
  sys::reg_get(HKEY_CURRENT_USER, &format!("Software\\Retocker\\{name}"), "").map(PathBuf::from)
}

fn links() -> (Option<PathBuf>, Option<PathBuf>) {
  (sys::programs_menu().map(|p| p.join(format!("{NAME}.lnk"))), sys::desktop().map(|p| p.join(format!("{NAME}.lnk"))))
}

/// after an update inside the app: the version in «Apps & features»
pub fn note_version(exe: &Path, ver: &str) {
  if installed_dir().as_deref() == exe.parent() {
    sys::reg_set(UNINST_KEY, "DisplayVersion", ver);
  }
}

// ---------------------------------------------------------------- install

#[derive(serde::Deserialize, Clone, Debug)]
pub struct Opts {
  pub dir: String,
  pub autostart: bool,
  pub desktop: bool,
  #[serde(default)]
  pub asr: bool,
}

/// the old NSIS installs (1.0.20 and before, also under the old name): quietly removed first.
/// Settings and the Groq key stay: a silent NSIS uninstall does not touch them.
fn remove_nsis(name: &str) {
  let key = format!("Software\\Retocker\\{name}");
  let Some(dir) = nsis_dir(name) else { return };
  let un = dir.join("uninstall.exe");
  if un.exists() {
    // NSIS wants «_?=» last and without quotes, even with spaces in the path
    let c = std::process::Command::new(&un).raw_arg(format!("/S _?={}", dir.display())).creation_flags(sys::NO_WINDOW).status();
    logx::log(&format!("setup: old {name} at {} removed: {:?}", dir.display(), c.map(|s| s.code())));
    let _ = std::fs::remove_file(&un);
  }
  let _ = std::fs::remove_dir(&dir);
  sys::reg_del_tree(&key);
  sys::reg_del_if_empty("Software\\Retocker");
}

fn copy_in(src: &Path, exe: &Path) -> Result<(), String> {
  if let (Ok(a), Ok(b)) = (src.canonicalize(), exe.canonicalize()) {
    if a == b {
      return Ok(());
    }
  }
  if let Some(d) = exe.parent() {
    std::fs::create_dir_all(d).map_err(|e| format!("Не получилось создать папку: {e}"))?;
  }
  let mut last = String::new();
  for i in 0..20 {
    match std::fs::copy(src, exe) {
      Ok(_) => {
        // the copy keeps the «downloaded from the internet» mark of the setup file; without it Windows does not
        // ask «are you sure you want to run this?» every time the installed program starts
        let _ = std::fs::remove_file(format!("{}:Zone.Identifier", exe.display()));
        return Ok(());
      }
      Err(e) => {
        last = e.to_string();
        // still in use (a copy that is just closing): move it aside, it goes away on the next start
        if i == 10 && exe.exists() {
          let _ = std::fs::rename(exe, exe.with_file_name("retocker-snap.old.exe"));
        }
        std::thread::sleep(Duration::from_millis(250));
      }
    }
  }
  Err(format!("Не получилось скопировать программу: {last}"))
}

/// `--install-files <dir>`: the elevated helper for folders like Program Files (copies only; the rest is done
/// by the normal, non-elevated setup so the shortcuts and the registry belong to the user)
pub fn install_files_elevated(dir: &str) -> i32 {
  let Ok(me) = std::env::current_exe() else { return 2 };
  match copy_in(&me, &PathBuf::from(dir).join(EXE)) {
    Ok(_) => 0,
    Err(_) => 1,
  }
}

fn ymd() -> String {
  // days since 1970 -> civil date (Howard Hinnant's algorithm)
  let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|x| x.as_secs() / 86400).unwrap_or(0) as i64;
  let z = d + 719468;
  let era = z.div_euclid(146097);
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
  format!("{y:04}{m:02}{day:02}")
}

pub fn install(ver: &str, o: &Opts, step: &dyn Fn(u32, &str)) -> Result<PathBuf, String> {
  let dir = PathBuf::from(o.dir.trim().trim_end_matches(['\\', '/']));
  if !dir.is_absolute() || dir.parent().is_none() {
    return Err("Выбери папку на диске".into());
  }
  let me = std::env::current_exe().map_err(|e| e.to_string())?;
  let exe = dir.join(EXE);
  logx::log(&format!("setup v{ver}: into {} autostart={} desktop={}", dir.display(), o.autostart, o.desktop));

  step(6, "Закрываю Retocker Snap…");
  let n = sys::kill_app_copies();
  if n > 0 {
    std::thread::sleep(Duration::from_millis(400));
  }
  step(18, "Убираю прошлую версию…");
  remove_nsis("Retocker Snap");

  step(45, "Копирую программу…");
  if sys::writable(&dir) {
    copy_in(&me, &exe)?;
  } else {
    logx::log("setup: the folder needs admin rights");
    match sys::run_elevated(&me, &format!("--install-files \"{}\"", dir.display())) {
      Ok(0) => {}
      Ok(c) => return Err(format!("Не получилось скопировать программу (код {c})")),
      Err(true) => return Err("Для этой папки нужно разрешение Windows. Нажми «Да» в окне Windows или выбери другую папку".into()),
      Err(false) => return Err("Не получилось получить права администратора".into()),
    }
    if !exe.exists() {
      return Err("Программа не скопировалась".into());
    }
  }

  step(70, "Создаю ярлыки…");
  let (menu, desk) = links();
  if let Some(m) = &menu {
    sys::shortcut(m, &exe, "", "Диктовка в любую программу");
  }
  if let Some(d) = &desk {
    if o.desktop {
      sys::shortcut(d, &exe, "", "Диктовка в любую программу");
    } else {
      let _ = std::fs::remove_file(d);
    }
  }

  step(86, "Записываю в Windows…");
  let size_kb = std::fs::metadata(&exe).map(|m| (m.len() / 1024) as u32).unwrap_or(0);
  let ex = exe.display().to_string();
  sys::reg_set(UNINST_KEY, "DisplayName", NAME);
  sys::reg_set(UNINST_KEY, "DisplayIcon", &format!("{ex},0"));
  sys::reg_set(UNINST_KEY, "DisplayVersion", ver);
  sys::reg_set(UNINST_KEY, "Publisher", "Retocker");
  sys::reg_set(UNINST_KEY, "InstallLocation", &dir.display().to_string());
  sys::reg_set(UNINST_KEY, "InstallDate", &ymd());
  sys::reg_set(UNINST_KEY, "UninstallString", &format!("\"{ex}\" --uninstall"));
  sys::reg_set(UNINST_KEY, "QuietUninstallString", &format!("\"{ex}\" --uninstall --silent"));
  sys::reg_set_dword(UNINST_KEY, "NoModify", 1);
  sys::reg_set_dword(UNINST_KEY, "NoRepair", 1);
  sys::reg_set_dword(UNINST_KEY, "EstimatedSize", size_kb);
  if o.autostart {
    sys::reg_set(RUN, NAME, &format!("\"{ex}\" --autostart"));
  } else {
    sys::reg_del_value(RUN, NAME);
  }
  step(100, "Готово");
  logx::log(&format!("setup: installed {ex}"));
  Ok(exe)
}

// ---------------------------------------------------------------- uninstall

/// what to delete once this process is gone (our own exe can not be deleted while it runs)
static TAIL: Mutex<Option<(String, bool)>> = Mutex::new(None);

pub fn uninstall(wipe: bool, step: &dyn Fn(u32, &str)) -> Result<(), String> {
  let me = std::env::current_exe().ok();
  let dir = installed_dir().or_else(|| {
    me.as_ref().filter(|p| p.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case(EXE)).unwrap_or(false)).and_then(|p| p.parent().map(|d| d.to_path_buf()))
  });
  logx::log(&format!("uninstall: {:?} wipe={wipe}", dir));
  step(10, "Закрываю Retocker Snap…");
  sys::kill_app_copies();
  step(30, "Убираю автозапуск и ярлыки…");
  sys::reg_del_value(RUN, NAME);
  let (menu, desk) = links();
  for l in [menu, desk].into_iter().flatten() {
    let _ = std::fs::remove_file(l);
  }
  step(50, "Убираю из списка программ…");
  sys::reg_del_tree(UNINST_KEY);
  if wipe {
    step(70, "Удаляю настройки и ключ…");
    for d in [sys::local_appdata().join(IDENT), sys::roaming_appdata().join(IDENT)] {
      for _ in 0..12 {
        if !d.exists() || std::fs::remove_dir_all(&d).is_ok() {
          break;
        }
        std::thread::sleep(Duration::from_millis(300));
      }
    }
  }
  if let Some(d) = dir {
    let ds = d.display().to_string();
    let tail = format!("del /f /q \"{ds}\\{EXE}\" & del /f /q \"{ds}\\retocker-snap.old*.exe\" & rmdir \"{ds}\"");
    *TAIL.lock().unwrap_or_else(|e| e.into_inner()) = Some((tail, !sys::writable(&d)));
  }
  step(100, "Готово");
  Ok(())
}

fn finish(webdata: Option<&Path>) {
  let mut tail = TAIL.lock().unwrap_or_else(|e| e.into_inner()).take();
  if let Some(w) = webdata {
    let t = format!("rmdir /s /q \"{}\"", w.display());
    tail = Some(match tail {
      Some((a, el)) => (format!("{a} & {t}"), el),
      None => (t, false),
    });
  }
  if let Some((t, el)) = tail {
    sys::after_exit(&t, el);
  }
}

// ---------------------------------------------------------------- without a window

pub fn silent(m: Mode, ver: &str, args: &[String]) -> i32 {
  let log = |p: u32, t: &str| logx::log(&format!("  {p}% {t}"));
  match m {
    Mode::Setup => {
      let o = Opts {
        dir: arg_after(args, "--dir").unwrap_or_else(|| default_dir().display().to_string()),
        autostart: !args.iter().any(|a| a == "--no-autostart"),
        desktop: !args.iter().any(|a| a == "--no-desktop"),
        asr: args.iter().any(|a| a == "--asr"),
      };
      match install(ver, &o, &log) {
        Ok(_) => 0,
        Err(e) => {
          logx::log(&format!("setup failed: {e}"));
          1
        }
      }
    }
    Mode::Uninstall => {
      let r = uninstall(args.iter().any(|a| a == "--wipe"), &log);
      finish(None);
      if r.is_ok() {
        0
      } else {
        1
      }
    }
    Mode::App => 0,
  }
}

// ---------------------------------------------------------------- the window

static DONE_EXE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn had_autostart() -> bool {
  sys::reg_get(HKEY_CURRENT_USER, RUN, NAME).is_some()
}

#[tauri::command]
fn setup_info(app: AppHandle) -> serde_json::Value {
  let inst = installed_dir();
  let old = nsis_dir("Retocker Snap");
  let before = inst.is_some() || old.is_some();
  let desk = links().1.map(|d| d.exists()).unwrap_or(false);
  let dir = default_dir();
  json!({
    "version": app.package_info().version.to_string(),
    "dir": dir.display().to_string(),
    "base": sys::local_appdata().join("Programs").display().to_string(),
    "installed": inst.is_some(),
    "old": old.is_some(),
    "autostart": if before { had_autostart() } else { true },
    "desktop": if inst.is_some() { desk } else { true },
    "auto": std::env::var("RA_SETUP_AUTO").map(|v| !v.is_empty()).unwrap_or(false),
  })
}

#[tauri::command]
fn fs_drives() -> Vec<sys::Drive> {
  sys::drives()
}

#[tauri::command]
fn fs_list(path: String) -> Result<serde_json::Value, String> {
  use std::os::windows::fs::MetadataExt;
  let p = PathBuf::from(&path);
  let rd = std::fs::read_dir(&p).map_err(|e| e.to_string())?;
  let mut dirs: Vec<(String, String)> = rd
    .flatten()
    .filter_map(|e| {
      let md = e.metadata().ok()?;
      let name = e.file_name().to_string_lossy().to_string();
      // folders only; no hidden or system ones ($Recycle.Bin, System Volume Information…)
      (md.is_dir() && md.file_attributes() & 0x6 == 0 && !name.starts_with('$') && !name.starts_with('.')).then(|| (name, e.path().display().to_string()))
    })
    .collect();
  dirs.sort_by_key(|d| d.0.to_lowercase());
  Ok(json!({
    "path": p.display().to_string(),
    "parent": p.parent().map(|x| x.display().to_string()),
    "dirs": dirs.into_iter().map(|(n, p)| json!({ "name": n, "path": p })).collect::<Vec<_>>(),
  }))
}

#[tauri::command]
fn fs_mkdir(path: String, name: String) -> Result<String, String> {
  let n = name.trim();
  if n.is_empty() || n.len() > 120 || n.chars().any(|c| "\\/:*?\"<>|".contains(c) || (c as u32) < 32) || n.ends_with('.') {
    return Err("Такое имя папки нельзя".into());
  }
  let p = PathBuf::from(path).join(n);
  if p.exists() {
    return Err("Такая папка уже есть".into());
  }
  std::fs::create_dir(&p).map_err(|e| if e.kind() == std::io::ErrorKind::PermissionDenied { "Здесь нельзя создавать папки".to_string() } else { e.to_string() })?;
  Ok(p.display().to_string())
}

#[tauri::command]
fn fs_check(path: String) -> serde_json::Value {
  let p = PathBuf::from(path.trim());
  json!({ "ok": p.is_absolute() && p.parent().is_some(), "writable": sys::writable(&p), "free": sys::free_space(&p), "exists": p.join(EXE).exists() })
}

#[tauri::command]
async fn setup_run(app: AppHandle, opts: Opts) -> Result<String, String> {
  let ver = app.package_info().version.to_string();
  let a = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let step = |p: u32, t: &str| {
      let _ = a.emit_to("setup", "setup", json!({ "p": p, "t": t }));
    };
    let r = install(&ver, &opts, &step);
    if let Err(e) = &r {
      logx::log(&format!("setup failed: {e}"));
    }
    r.map(|exe| {
      *DONE_EXE.lock().unwrap_or_else(|e| e.into_inner()) = Some(exe.clone());
      exe.display().to_string()
    })
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
fn setup_launch(app: AppHandle) {
  if let Some(exe) = DONE_EXE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
    let _ = std::process::Command::new(&exe).spawn();
  }
  app.exit(0);
}

#[tauri::command]
async fn uninst_run(app: AppHandle, wipe: bool) -> Result<(), String> {
  let a = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let step = |p: u32, t: &str| {
      let _ = a.emit_to("setup", "setup", json!({ "p": p, "t": t }));
    };
    uninstall(wipe, &step)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
fn setup_close(app: AppHandle) {
  app.exit(0);
}

#[tauri::command]
fn setup_min(window: WebviewWindow) {
  let _ = window.minimize();
}

pub fn run_ui(m: Mode, ctx: tauri::Context<tauri::Wry>) {
  let data = std::env::temp_dir().join(format!("retocker-snap-setup-{}", std::process::id()));
  let d2 = data.clone();
  let un = m == Mode::Uninstall;
  let app = tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![setup_info, fs_drives, fs_list, fs_mkdir, fs_check, setup_run, setup_launch, uninst_run, setup_close, setup_min])
    .setup(move |app| {
      let init = format!("window.RA_SETUP = {};", json!({ "mode": if un { "uninstall" } else { "setup" } }));
      WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
        .title(if un { "Удаление Retocker Snap" } else { "Установка Retocker Snap" })
        .inner_size(640.0, 540.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(25, 25, 25, 255))
        .data_directory(d2.clone())
        .initialization_script(&init)
        .build()?;
      if let Some(w) = app.get_webview_window("setup") {
        let _ = w.set_focus();
      }
      Ok(())
    })
    .build(ctx);
  match app {
    Ok(a) => a.run(move |_, e| {
      if let RunEvent::Exit = e {
        finish(Some(&data));
      }
    }),
    Err(e) => {
      logx::log(&format!("setup window failed: {e}"));
      sys::message(&format!("Не получилось открыть окно установки: {e}"), true);
    }
  }
}
