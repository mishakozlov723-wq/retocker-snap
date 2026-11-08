//! Updates inside the app: a small signed manifest (latest.json) says which version is out; the new exe is
//! downloaded, checked (SHA-256 + an Ed25519 signature that only our build machine can make), put in place of the
//! running one (a running exe can be renamed, not overwritten), and started; the old copy quits.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::{logx, setup, sys};

/// the public half of the signing key (the private half is a secret of the build machine)
const PUBKEY: [u8; 32] = [
  0x82, 0x41, 0xab, 0xdf, 0x61, 0x8f, 0xca, 0x90, 0xaf, 0x60, 0xd4, 0xb3, 0xbc, 0xc7, 0xff, 0xcc, 0xa9, 0xbb, 0xb3, 0xf2, 0xeb, 0xa3, 0xd4, 0xf6, 0x0b,
  0x91, 0x21, 0x74, 0x62, 0x18, 0xf9, 0x84,
];
const MANIFESTS: [&str; 1] = ["https://github.com/mishakozlov723-wq/retocker-snap-download/releases/latest/download/latest.json"];

#[derive(serde::Deserialize, serde::Serialize, Clone, Default, Debug)]
pub struct Manifest {
  pub version: String,
  #[serde(default)]
  pub notes: String,
  #[serde(default)]
  pub size: String,
  #[serde(default)]
  pub bytes: u64,
  #[serde(default)]
  pub url: String,
  #[serde(default)]
  pub sha256: String,
  #[serde(default)]
  pub sig: String,
}

static MAN: Mutex<Option<Manifest>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

pub(crate) fn agent() -> ureq::Agent {
  let mut b = ureq::AgentBuilder::new()
    .timeout_connect(Duration::from_secs(15))
    .timeout_read(Duration::from_secs(30))
    .user_agent("retocker-snap")
    .try_proxy_from_env(true);
  if let Ok(t) = native_tls::TlsConnector::new() {
    b = b.tls_connector(std::sync::Arc::new(t));
  }
  b.build()
}

/// GET a URL (or read a local file — used by the build check) with progress (bytes so far, total or 0)
pub fn fetch(url: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<Vec<u8>, String> {
  let local = url.strip_prefix("file:///").or_else(|| url.strip_prefix("file://")).map(|s| s.to_string()).or_else(|| {
    let b = url.as_bytes();
    (b.len() > 2 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')).then(|| url.to_string())
  });
  if let Some(p) = local {
    let d = std::fs::read(p.replace('/', "\\")).map_err(|e| e.to_string())?;
    progress(d.len() as u64, d.len() as u64);
    return Ok(d);
  }
  let r = agent().get(url).call().map_err(|e| match e {
    ureq::Error::Status(c, _) => format!("сервер ответил {c}"),
    ureq::Error::Transport(t) => t.to_string(),
  })?;
  let total: u64 = r.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
  let mut rd = r.into_reader().take(200 * 1024 * 1024);
  let mut out = Vec::with_capacity(total as usize);
  let mut buf = vec![0u8; 64 * 1024];
  loop {
    let n = rd.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    out.extend_from_slice(&buf[..n]);
    progress(out.len() as u64, total);
  }
  Ok(out)
}

fn manifest_urls() -> Vec<String> {
  match std::env::var("RA_UPDATE_URL") {
    Ok(u) if !u.is_empty() => vec![u],
    _ => MANIFESTS.iter().map(|s| s.to_string()).collect(),
  }
}

/// a.b.c newer than x.y.z?
pub fn newer(a: &str, b: &str) -> bool {
  let p = |s: &str| s.trim().trim_start_matches('v').split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
  let (x, y) = (p(a), p(b));
  for i in 0..3 {
    let (m, n) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
    if m != n {
      return m > n;
    }
  }
  false
}

pub fn check() -> Result<Manifest, String> {
  let mut last = String::from("нет связи");
  for u in manifest_urls() {
    let sep = if u.contains('?') { '&' } else { '?' };
    let url = if u.starts_with("http") { format!("{u}{sep}t={}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)) } else { u.clone() };
    match fetch(&url, &mut |_, _| {}).and_then(|b| serde_json::from_slice::<Manifest>(&b).map_err(|e| e.to_string())) {
      Ok(m) if !m.version.is_empty() => {
        *MAN.lock().unwrap_or_else(|e| e.into_inner()) = Some(m.clone());
        return Ok(m);
      }
      Ok(_) => last = "пустой ответ".into(),
      Err(e) => {
        logx::log(&format!("update check {u}: {e}"));
        last = e;
      }
    }
  }
  Err(last)
}

fn hex(b: &[u8]) -> String {
  b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
  let s = s.trim();
  if s.len() % 2 != 0 {
    return None;
  }
  (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// the file is exactly what our build machine signed for this version
pub fn verify(m: &Manifest, data: &[u8]) -> Result<(), String> {
  let sum = hex(&Sha256::digest(data));
  if !sum.eq_ignore_ascii_case(m.sha256.trim()) {
    return Err("файл скачался с ошибкой (контрольная сумма не совпала)".into());
  }
  if data.len() < 2 || &data[..2] != b"MZ" {
    return Err("скачался не тот файл".into());
  }
  let key = VerifyingKey::from_bytes(&PUBKEY).map_err(|_| "ключ проверки повреждён".to_string())?;
  let sig = unhex(&m.sig).and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok()).ok_or("нет подписи")?;
  let msg = format!("retocker-snap:{}:{}", m.version.trim(), sum);
  key.verify_strict(msg.as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| "подпись не совпала — файл не от Retocker".to_string())
}

/// put `src` where `target` is: the running target is renamed to retocker-snap.old.exe, the new one is copied in
pub fn swap(src: &Path, target: &Path) -> std::io::Result<PathBuf> {
  let mut old = target.with_file_name("retocker-snap.old.exe");
  if old.exists() && std::fs::remove_file(&old).is_err() {
    old = target.with_file_name(format!("retocker-snap.old{}.exe", std::process::id()));
  }
  std::fs::rename(target, &old)?;
  if let Err(e) = std::fs::copy(src, target) {
    let _ = std::fs::rename(&old, target);
    return Err(e);
  }
  Ok(old)
}

/// `--apply-update <target>`: the elevated helper (the downloaded exe itself) for folders like Program Files
pub fn apply_elevated(target: &str) -> i32 {
  let Ok(me) = std::env::current_exe() else { return 2 };
  let t = PathBuf::from(target);
  for _ in 0..30 {
    match swap(&me, &t) {
      Ok(old) => {
        if std::fs::remove_file(&old).is_err() {
          sys::delete_at_reboot(&old);
        }
        return 0;
      }
      Err(_) => std::thread::sleep(Duration::from_millis(200)),
    }
  }
  1
}

/// leftovers of the previous update next to the exe
pub fn cleanup_old() {
  let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) else { return };
  if let Ok(rd) = std::fs::read_dir(&dir) {
    for e in rd.flatten() {
      let n = e.file_name().to_string_lossy().to_lowercase();
      if n.starts_with("retocker-snap.old") && n.ends_with(".exe") {
        for _ in 0..10 {
          if std::fs::remove_file(e.path()).is_ok() {
            break;
          }
          std::thread::sleep(Duration::from_millis(300));
        }
      }
    }
  }
  if let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) {
    for e in rd.flatten() {
      let n = e.file_name().to_string_lossy().to_lowercase();
      if n.starts_with("retocker-snap-update-") {
        let _ = std::fs::remove_file(e.path());
      }
    }
  }
}

fn emit(app: &AppHandle, v: serde_json::Value) {
  let _ = app.emit_to("main", "upd", v);
}

/// download → check → swap → start the new one → quit. Progress goes to the settings window as «upd» events.
pub fn install(app: AppHandle) -> Result<(), String> {
  {
    let mut b = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    if *b {
      return Ok(());
    }
    *b = true;
  }
  let r = install_inner(&app);
  *BUSY.lock().unwrap_or_else(|e| e.into_inner()) = false;
  if let Err(e) = &r {
    logx::log(&format!("update failed: {e}"));
    emit(&app, json!({ "stage": "error", "msg": e }));
  }
  r
}

fn install_inner(app: &AppHandle) -> Result<(), String> {
  let cur = app.package_info().version.to_string();
  let m = match MAN.lock().unwrap_or_else(|e| e.into_inner()).clone() {
    Some(m) => m,
    None => check()?,
  };
  if !newer(&m.version, &cur) {
    return Err("у тебя уже последняя версия".into());
  }
  if m.url.is_empty() {
    return Err("нет адреса для скачивания".into());
  }
  logx::log(&format!("update: {cur} -> {} from {}", m.version, m.url));
  emit(app, json!({ "stage": "down", "p": 0.0 }));
  let mut last = Instant::now() - Duration::from_secs(1);
  let hint = m.bytes;
  let data = fetch(&m.url, &mut |got, total| {
    let total = if total > 0 { total } else { hint };
    if last.elapsed() > Duration::from_millis(80) || (total > 0 && got >= total) {
      last = Instant::now();
      emit(app, json!({ "stage": "down", "p": if total > 0 { got as f64 / total as f64 } else { 0.0 }, "got": got, "total": total }));
    }
  })?;
  emit(app, json!({ "stage": "check" }));
  verify(&m, &data)?;
  let tmp = std::env::temp_dir().join(format!("retocker-snap-update-{}.exe", m.version.trim()));
  std::fs::write(&tmp, &data).map_err(|e| format!("не получилось сохранить файл: {e}"))?;
  let target = std::env::current_exe().map_err(|e| e.to_string())?;
  emit(app, json!({ "stage": "apply" }));
  match swap(&tmp, &target) {
    Ok(_) => {}
    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
      // a folder only an administrator may change (Program Files): one UAC prompt for the helper
      logx::log("update: the folder needs admin rights");
      match sys::run_elevated(&tmp, &format!("--apply-update \"{}\"", target.display())) {
        Ok(0) => {}
        Ok(c) => return Err(format!("не получилось заменить файл (код {c})")),
        Err(true) => return Err("нужно разрешение Windows — обновление отменено".into()),
        Err(false) => return Err("не получилось получить права администратора".into()),
      }
    }
    Err(e) => return Err(format!("не получилось заменить файл: {e}")),
  }
  let _ = std::fs::remove_file(&tmp);
  setup::note_version(&target, m.version.trim());
  logx::log(&format!("update: applied {}, restarting", m.version));
  emit(app, json!({ "stage": "restart" }));
  restart(app, &target, m.version.trim())
}

/// start the new exe (it waits until this process is gone) and quit
pub fn restart(app: &AppHandle, exe: &Path, ver: &str) -> Result<(), String> {
  let pid = std::process::id().to_string();
  std::process::Command::new(exe)
    .args(["--wait-pid", &pid, "--updated", ver])
    .spawn()
    .map_err(|e| format!("новая версия не запустилась: {e}. Перезапусти программу сам"))?;
  std::thread::spawn(|| {
    std::thread::sleep(Duration::from_secs(6));
    std::process::exit(0);
  });
  app.exit(0);
  Ok(())
}
