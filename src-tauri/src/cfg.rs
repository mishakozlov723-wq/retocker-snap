//! Settings: one JSON object in %LOCALAPPDATA%\com.retocker.snap\settings.json. The UI owns the defaults
//! (ui/defaults.js); Rust only reads the few values it needs, with its own fallbacks.
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

static CFG: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

pub fn dir() -> PathBuf {
  crate::sys::local_appdata().join("com.retocker.snap")
}
fn path() -> PathBuf {
  dir().join("settings.json")
}

fn with<T>(f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
  let mut g = CFG.lock().unwrap_or_else(|e| e.into_inner());
  if g.is_none() {
    let m = std::fs::read_to_string(path())
      .ok()
      .and_then(|s| serde_json::from_str::<Value>(&s).ok())
      .and_then(|v| v.as_object().cloned())
      .unwrap_or_default();
    *g = Some(m);
  }
  f(g.as_mut().unwrap())
}

pub fn all() -> Value {
  with(|m| Value::Object(m.clone()))
}

/// merge the given keys in and write the file
pub fn merge(v: &Value) {
  let Some(o) = v.as_object() else { return };
  let text = with(|m| {
    for (k, x) in o {
      m.insert(k.clone(), x.clone());
    }
    serde_json::to_string_pretty(&Value::Object(m.clone())).unwrap_or_default()
  });
  let _ = std::fs::create_dir_all(dir());
  let tmp = path().with_extension("tmp");
  if std::fs::write(&tmp, text).is_ok() {
    let _ = std::fs::rename(&tmp, path());
  }
}

pub fn str_(k: &str, d: &str) -> String {
  with(|m| m.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_else(|| d.to_string())
}
pub fn num(k: &str, d: f64) -> f64 {
  with(|m| m.get(k).and_then(|v| v.as_f64())).unwrap_or(d)
}
pub fn bool_(k: &str, d: bool) -> bool {
  with(|m| m.get(k).and_then(|v| v.as_bool())).unwrap_or(d)
}

/// the hotkeys as (id, combo); missing ones get the defaults
pub fn hotkeys() -> Vec<(String, String)> {
  [("area", "PrintScreen"), ("full", "Shift+PrintScreen"), ("window", "Alt+PrintScreen"), ("text", "Ctrl+PrintScreen"), ("last", "")]
    .iter()
    .map(|(id, d)| (id.to_string(), str_(&format!("hk_{id}"), d)))
    .collect()
}
