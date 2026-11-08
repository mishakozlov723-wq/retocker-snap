//! History: every snapshot as a PNG plus a small JPEG preview in %LOCALAPPDATA%\com.retocker.snap\history,
//! newest first, trimmed to the limit from the settings.
use std::path::PathBuf;

use serde::Serialize;

pub fn dir() -> PathBuf {
  crate::cfg::dir().join("history")
}

#[derive(Serialize)]
pub struct Item {
  pub id: String,
  pub w: u32,
  pub h: u32,
  pub t: u64,
  pub text: String,
}

fn now() -> u64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// returns the id (also the file stem)
pub fn add(w: u32, h: u32, png: &[u8], thumb: &[u8]) -> Option<String> {
  let d = dir();
  std::fs::create_dir_all(&d).ok()?;
  let id = format!("{}_{}x{}", now(), w, h);
  std::fs::write(d.join(format!("{id}.png")), png).ok()?;
  let _ = std::fs::write(d.join(format!("{id}.jpg")), thumb);
  trim();
  Some(id)
}

pub fn set_text(id: &str, text: &str) {
  if valid(id) {
    let _ = std::fs::write(dir().join(format!("{id}.txt")), text);
  }
}

pub fn valid(id: &str) -> bool {
  !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn ids() -> Vec<String> {
  let mut v: Vec<String> = std::fs::read_dir(dir())
    .map(|rd| {
      rd.flatten()
        .filter_map(|e| {
          let n = e.file_name().to_string_lossy().to_string();
          n.strip_suffix(".png").map(|s| s.to_string())
        })
        .filter(|s| valid(s))
        .collect()
    })
    .unwrap_or_default();
  v.sort_by(|a, b| b.cmp(a));
  v
}

fn trim() {
  let keep = crate::cfg::num("histLimit", 200.0).max(0.0) as usize;
  for id in ids().into_iter().skip(keep) {
    remove(&id);
  }
}

pub fn remove(id: &str) {
  if !valid(id) {
    return;
  }
  for ext in ["png", "jpg", "txt"] {
    let _ = std::fs::remove_file(dir().join(format!("{id}.{ext}")));
  }
}

pub fn clear() {
  for id in ids() {
    remove(&id);
  }
}

pub fn list(limit: usize) -> Vec<Item> {
  ids()
    .into_iter()
    .take(limit)
    .map(|id| {
      let mut p = id.split('_');
      let t = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
      let (w, h) = p.next().and_then(|s| s.split_once('x')).map(|(a, b)| (a.parse().unwrap_or(0), b.parse().unwrap_or(0))).unwrap_or((0, 0));
      let text = std::fs::read_to_string(dir().join(format!("{id}.txt"))).unwrap_or_default();
      Item { id, w, h, t, text }
    })
    .collect()
}

pub fn png_path(id: &str) -> Option<PathBuf> {
  valid(id).then(|| dir().join(format!("{id}.png")))
}
pub fn read(id: &str, ext: &str) -> Option<Vec<u8>> {
  if !valid(id) {
    return None;
  }
  std::fs::read(dir().join(format!("{id}.{ext}"))).ok()
}
