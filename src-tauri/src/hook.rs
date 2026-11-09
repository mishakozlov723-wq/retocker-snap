//! Global keyboard hook (WH_KEYBOARD_LL) on its own thread.
//! Knows several hotkeys at once (area, full screen, window, text, repeat last), swallows their main key so
//! the app in front (and Windows' own Print Screen tool) never sees it, and can record a new hotkey for the
//! settings window (then every key goes only to us, so Win never opens Start).
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// dwExtraInfo of every key event we inject ourselves — the hook lets them through.
pub const MARK: usize = 0x5241_4253;

const LCTRL: u8 = 1;
const RCTRL: u8 = 2;
const LALT: u8 = 4;
const RALT: u8 = 8;
const LSHIFT: u8 = 16;
const RSHIFT: u8 = 32;
const LWIN: u8 = 64;
const RWIN: u8 = 128;

#[derive(Debug)]
pub enum Ev {
  /// a hotkey was pressed: its id ("area", "full", "window", "text", "last")
  Hk(String),
  /// a key while recording a new hotkey
  Rec { name: String, down: bool, m: bool },
  Dbg(String),
}

static DEBUG: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct Combo {
  id: String,
  req: [u8; 4],
  key: u32,
}

#[derive(Default)]
struct St {
  combos: Vec<Combo>,
  held: u8,
  swallow: Vec<u32>,
  rec_until: Option<Instant>,
  paused: bool,
  async_ok: bool,
}

static ST: OnceLock<Mutex<St>> = OnceLock::new();
static TX: OnceLock<Mutex<Sender<Ev>>> = OnceLock::new();

fn st() -> std::sync::MutexGuard<'static, St> {
  ST.get_or_init(|| Mutex::new(St::default())).lock().unwrap_or_else(|e| e.into_inner())
}
fn send(e: Ev) {
  if let Some(tx) = TX.get() {
    let _ = tx.lock().map(|t| t.send(e));
  }
}

fn mod_bit(vk: u32, scan: u32) -> u8 {
  match vk {
    0xA2 => {
      if scan == 0x21D {
        0
      } else {
        LCTRL
      }
    }
    0xA3 => RCTRL,
    0xA4 => LALT,
    0xA5 => RALT,
    0xA0 => LSHIFT,
    0xA1 => RSHIFT,
    0x5B => LWIN,
    0x5C => RWIN,
    0x11 => LCTRL,
    0x12 => LALT,
    0x10 => LSHIFT,
    _ => 0,
  }
}

fn mods_match(held: u8, req: &[u8; 4]) -> bool {
  let pairs = [(LCTRL, RCTRL), (LALT, RALT), (LSHIFT, RSHIFT), (LWIN, RWIN)];
  for (i, (lb, rb)) in pairs.iter().enumerate() {
    let l = held & lb != 0;
    let r = held & rb != 0;
    let ok = match req[i] {
      0 => !l && !r,
      1 => l && !r,
      2 => r && !l,
      _ => l || r,
    };
    if !ok {
      return false;
    }
  }
  true
}

/// "Ctrl+Shift+S", "PrintScreen", "Alt+PrintScreen" -> (mods, key). A hotkey here always has a main key.
pub fn parse(combo: &str) -> Option<([u8; 4], u32)> {
  let mut req = [0u8; 4];
  let mut key = 0u32;
  for p in combo.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()) {
    let (i, side) = match p {
      "Ctrl" => (0, 3),
      "LCtrl" => (0, 1),
      "RCtrl" => (0, 2),
      "Alt" => (1, 3),
      "LAlt" => (1, 1),
      "RAlt" => (1, 2),
      "Shift" => (2, 3),
      "LShift" => (2, 1),
      "RShift" => (2, 2),
      "Win" => (3, 3),
      "LWin" => (3, 1),
      "RWin" => (3, 2),
      _ => {
        key = name_vk(p)?;
        continue;
      }
    };
    req[i] = side;
  }
  if key == 0 {
    return None;
  }
  Some((req, key))
}

const NAMES: &[(u32, &str)] = &[
  (0x20, "Space"), (0xC0, "`"), (0xBD, "-"), (0xBB, "="), (0xDB, "["), (0xDD, "]"), (0xDC, "\\"), (0xBA, ";"),
  (0xDE, "'"), (0xBC, ","), (0xBE, "."), (0xBF, "/"), (0x14, "CapsLock"), (0x2D, "Insert"), (0x2E, "Delete"),
  (0x24, "Home"), (0x23, "End"), (0x21, "PageUp"), (0x22, "PageDown"), (0x26, "↑"), (0x28, "↓"), (0x25, "←"),
  (0x27, "→"), (0x13, "Pause"), (0x91, "ScrollLock"), (0x0D, "Enter"), (0x09, "Tab"), (0x08, "Backspace"),
  (0x1B, "Esc"), (0x5D, "Menu"), (0x2C, "PrintScreen"), (0x6A, "Num*"), (0x6B, "Num+"), (0x6D, "Num-"),
  (0x6E, "Num."), (0x6F, "Num/"), (0x90, "NumLock"),
];

pub fn vk_name(vk: u32) -> String {
  match vk {
    0x41..=0x5A | 0x30..=0x39 => char::from_u32(vk).map(|c| c.to_string()).unwrap_or_default(),
    0x60..=0x69 => format!("Num{}", vk - 0x60),
    0x70..=0x87 => format!("F{}", vk - 0x6F),
    0xA2 | 0x11 => "Ctrl".into(),
    0xA3 => "Ctrl".into(),
    0xA4 | 0x12 => "Alt".into(),
    0xA5 => "Alt".into(),
    0xA0 | 0x10 => "Shift".into(),
    0xA1 => "Shift".into(),
    0x5B | 0x5C => "Win".into(),
    _ => NAMES.iter().find(|(v, _)| *v == vk).map(|(_, n)| n.to_string()).unwrap_or_else(|| format!("VK{:02X}", vk)),
  }
}

fn name_vk(n: &str) -> Option<u32> {
  let b = n.as_bytes();
  if b.len() == 1 && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit()) {
    return Some(b[0] as u32);
  }
  if let Some(d) = n.strip_prefix("Num") {
    if let Ok(x) = d.parse::<u32>() {
      if x <= 9 {
        return Some(0x60 + x);
      }
    }
  }
  if let Some(d) = n.strip_prefix('F') {
    if let Ok(x) = d.parse::<u32>() {
      if (1..=24).contains(&x) {
        return Some(0x6F + x);
      }
    }
  }
  if let Some(h) = n.strip_prefix("VK") {
    return u32::from_str_radix(h, 16).ok();
  }
  NAMES.iter().find(|(_, s)| *s == n).map(|(v, _)| *v)
}

/// all hotkeys at once: (id, combo). Empty or unknown combos are skipped. Returns the ids that were understood.
pub fn set_hotkeys(list: &[(String, String)]) -> Vec<String> {
  let mut v = Vec::new();
  for (id, c) in list {
    if let Some((req, key)) = parse(c) {
      v.push(Combo { id: id.clone(), req, key });
    }
  }
  let ids = v.iter().map(|c| c.id.clone()).collect();
  st().combos = v;
  ids
}
pub fn set_record(on: bool) {
  st().rec_until = if on { Some(Instant::now() + Duration::from_secs(20)) } else { None };
}
pub fn set_paused(on: bool) {
  st().paused = on;
}

fn key_in(vk: u16, up: bool) -> INPUT {
  let mut flags = KEYBD_EVENT_FLAGS(0);
  if up {
    flags |= KEYEVENTF_KEYUP;
  }
  INPUT {
    r#type: INPUT_KEYBOARD,
    Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: MARK } },
  }
}
/// a harmless unassigned key: pressed while Win or Alt is held it keeps Start / the menu bar from opening
fn tap_mask() {
  let v = [key_in(0xE8, false), key_in(0xE8, true)];
  unsafe {
    SendInput(&v, std::mem::size_of::<INPUT>() as i32);
  }
}

unsafe extern "system" fn proc_(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
  if code == HC_ACTION as i32 {
    LAST_KEY.store(now_ms(), Ordering::Relaxed);
    let kb = &*(lp.0 as *const KBDLLHOOKSTRUCT);
    if !(kb.flags.0 & LLKHF_INJECTED.0 != 0 && kb.dwExtraInfo == MARK) {
      let msg = wp.0 as u32;
      let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      if handle(down, kb) {
        return LRESULT(1);
      }
    }
  }
  CallNextHookEx(None, code, wp, lp)
}

pub fn debug() -> bool {
  DEBUG.load(Ordering::Relaxed)
}

/// true = swallow the event
fn handle(down: bool, kb: &KBDLLHOOKSTRUCT) -> bool {
  let vk = kb.vkCode;
  let bit = mod_bit(vk, kb.scanCode | if kb.flags.0 & LLKHF_EXTENDED.0 != 0 { 0x200 } else { 0 });
  let mut s = st();
  if s.swallow.contains(&vk) {
    if !down {
      s.swallow.retain(|v| *v != vk);
      if bit != 0 {
        s.held &= !bit;
      }
      if s.rec_until.map(|t| std::time::Instant::now() < t).unwrap_or(false) {
        drop(s);
        send(Ev::Rec { name: vk_name(vk), down: false, m: bit != 0 });
      }
    }
    return true;
  }
  let repeat = down && bit != 0 && s.held & bit != 0;
  sync_held(&mut s, bit);
  if debug() && down && !repeat {
    send(Ev::Dbg(format!("key {} held {:02X}", vk_name(vk), s.held | bit)));
  }
  if bit != 0 {
    if down {
      s.held |= bit
    } else {
      s.held &= !bit
    }
  }
  if let Some(t) = s.rec_until {
    if Instant::now() < t {
      if down {
        s.swallow.push(vk);
        drop(s);
        if !repeat {
          send(Ev::Rec { name: vk_name(vk), down: true, m: bit != 0 });
        }
        return true;
      }
      drop(s);
      send(Ev::Rec { name: vk_name(vk), down: false, m: bit != 0 });
      return false;
    }
    s.rec_until = None;
  }
  if s.paused || !down || bit != 0 {
    return false;
  }
  let held = s.held;
  let hit = s.combos.iter().find(|c| c.key == vk && mods_match(held, &c.req)).cloned();
  if let Some(c) = hit {
    s.swallow.push(vk);
    drop(s);
    if c.req[1] != 0 || c.req[3] != 0 {
      std::thread::spawn(tap_mask);
    }
    if debug() {
      send(Ev::Dbg(format!("hotkey {}", c.id)));
    }
    send(Ev::Hk(c.id));
    return true;
  }
  false
}

/// The hook can miss releases (Ctrl+Alt+Del, UAC, Win+L), so a modifier could look held forever: the system state fixes that.
fn sync_held(s: &mut St, cur: u8) {
  let mut sys = 0u8;
  for (vk, b) in [(0xA2, LCTRL), (0xA3, RCTRL), (0xA4, LALT), (0xA5, RALT), (0xA0, LSHIFT), (0xA1, RSHIFT), (0x5B, LWIN), (0x5C, RWIN)] {
    if b != cur && unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000 != 0 {
      sys |= b;
    }
  }
  if sys & s.held & !cur != 0 {
    s.async_ok = true;
  }
  if s.async_ok {
    s.held = (s.held & cur) | sys;
  }
}

static T0: OnceLock<Instant> = OnceLock::new();
fn now_ms() -> u64 {
  T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}
static LAST_KEY: AtomicU64 = AtomicU64::new(0);
static HOOK_TID: AtomicU32 = AtomicU32::new(0);
static REHOOK_AT: AtomicU64 = AtomicU64::new(0);
static REFRESH_AT: AtomicU64 = AtomicU64::new(0);
static STARTED: AtomicBool = AtomicBool::new(false);
const WM_REHOOK: u32 = WM_APP + 1;

fn rehook(now: u64) -> bool {
  let last = REHOOK_AT.load(Ordering::Relaxed);
  if last != 0 && now < last + 5000 {
    return false;
  }
  REHOOK_AT.store(now.max(1), Ordering::Relaxed);
  let tid = HOOK_TID.load(Ordering::Relaxed);
  if tid != 0 {
    unsafe {
      let _ = PostThreadMessageW(tid, WM_REHOOK, WPARAM(0), LPARAM(0));
    }
  }
  true
}

/// Windows can drop a keyboard hook without a word: a key the system sees pressed that the hook never
/// heard of means the hook is gone, so it is set up again. Ticked from a watcher thread.
fn watch_loop() {
  let mut was = false;
  let mut press: Option<u64> = None;
  loop {
    std::thread::sleep(Duration::from_millis(40));
    let now = now_ms();
    let down = [0x2C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C].iter().any(|v| unsafe { GetAsyncKeyState(*v) } as u16 & 0x8000 != 0);
    if down && !was {
      press = Some(now);
    }
    was = down;
    // a hook that has heard nothing for a while is quietly set up again (cheap, and it may be silently gone)
    let quiet = now.saturating_sub(LAST_KEY.load(Ordering::Relaxed).max(REFRESH_AT.load(Ordering::Relaxed)));
    let first = !STARTED.load(Ordering::Relaxed) && now > 4000;
    if (first || quiet > 20_000) && !down {
      STARTED.store(true, Ordering::Relaxed);
      REFRESH_AT.store(now, Ordering::Relaxed);
      let tid = HOOK_TID.load(Ordering::Relaxed);
      if tid != 0 {
        unsafe {
          let _ = PostThreadMessageW(tid, WM_REHOOK, WPARAM(1), LPARAM(0));
        }
      }
    }
    let Some(p) = press else { continue };
    if now < p + 300 {
      continue;
    }
    press = None;
    if LAST_KEY.load(Ordering::Relaxed) + 250 < p && rehook(now) {
      crate::logx::log("keyboard hook missed a key: setting it up again");
    }
  }
}

/// Starts the hook thread; `on_ev` runs on a separate dispatcher thread (never inside the hook).
pub fn start(on_ev: impl Fn(Ev) + Send + 'static) {
  DEBUG.store(std::env::var("RA_DEBUG").map(|v| v == "1").unwrap_or(false), Ordering::Relaxed);
  let _ = now_ms();
  let (tx, rx) = channel::<Ev>();
  let _ = TX.set(Mutex::new(tx));
  std::thread::spawn(move || {
    while let Ok(e) = rx.recv() {
      match e {
        Ev::Dbg(m) => crate::logx::log(&m),
        e => on_ev(e),
      }
    }
  });
  std::thread::spawn(|| unsafe {
    let hmod: HINSTANCE = GetModuleHandleW(None).map(|h| h.into()).unwrap_or_default();
    let _ = windows::Win32::System::Threading::SetThreadPriority(
      windows::Win32::System::Threading::GetCurrentThread(),
      windows::Win32::System::Threading::THREAD_PRIORITY_TIME_CRITICAL,
    );
    let tid = windows::Win32::System::Threading::GetCurrentThreadId();
    HOOK_TID.store(tid, Ordering::Relaxed);
    let install = |quiet: bool| match SetWindowsHookExW(WH_KEYBOARD_LL, Some(proc_), Some(hmod), 0) {
      Ok(h) => {
        if !quiet {
          crate::logx::log(&format!("keyboard hook on (thread {tid})"));
        }
        Some(h)
      }
      Err(e) => {
        crate::logx::log(&format!("keyboard hook failed: {e}"));
        None
      }
    };
    let mut hook = install(false);
    let _ = SetTimer(None, 0, 5000, None);
    let mut m = MSG::default();
    loop {
      let r = GetMessageW(&mut m, None, 0, 0);
      if r.0 == 0 || r.0 == -1 {
        break;
      }
      if m.hwnd.0.is_null() && m.message == WM_REHOOK {
        if let Some(h) = hook.take() {
          let _ = UnhookWindowsHookEx(h);
        }
        hook = install(m.wParam.0 == 1);
        continue;
      }
      let _ = TranslateMessage(&m);
      DispatchMessageW(&m);
    }
  });
  std::thread::spawn(watch_loop);
}

/// RA_DEBUG only (the build check): fire a hotkey by id as if it was pressed
pub fn test_fire(id: &str) {
  send(Ev::Hk(id.to_string()));
}
