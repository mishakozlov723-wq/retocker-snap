//! Win32 bits: the overlay window's styles and click-through, the work area, the app in front,
//! focus hand-over, autostart in the registry, opening links.
use std::sync::atomic::{AtomicIsize, Ordering};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Registry::*;
use windows::Win32::System::Threading::{
  AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
  PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn wide(s: &str) -> Vec<u16> {
  s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// the window that had the keyboard before we took it (review editing)
static PREV: AtomicIsize = AtomicIsize::new(0);

pub fn hwnd_of(h: isize) -> HWND {
  HWND(h as *mut _)
}

unsafe extern "system" fn no_activate(h: HWND, m: u32, wp: WPARAM, lp: LPARAM, _id: usize, data: usize) -> LRESULT {
  // clicks on the capsule must not take the keyboard away from the text the user is writing in
  if m == WM_MOUSEACTIVATE && data == 0 {
    return LRESULT(MA_NOACTIVATE as isize);
  }
  DefSubclassProc(h, m, wp, lp)
}

/// overlay: never in Alt+Tab or the taskbar, never activated by a click, starts click-through
pub fn overlay_styles(h: HWND) {
  unsafe {
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    let ex = (ex | (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOPMOST.0 | WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) as isize)
      & !(WS_EX_APPWINDOW.0 as isize);
    SetWindowLongPtrW(h, GWL_EXSTYLE, ex);
    let _ = SetWindowSubclass(h, Some(no_activate), 0x5241, 0);
  }
}

/// click-through on/off (the same window styles Electron uses; nothing else about the window changes)
pub fn set_clickthrough(h: HWND, on: bool) {
  unsafe {
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    let t = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
    let nx = if on { ex | t } else { (ex & !(WS_EX_TRANSPARENT.0 as isize)) | WS_EX_LAYERED.0 as isize };
    if nx != ex {
      SetWindowLongPtrW(h, GWL_EXSTYLE, nx);
    }
  }
}

/// keep the overlay above other always-on-top windows (the taskbar sometimes jumps over it)
pub fn keep_on_top(h: HWND) {
  unsafe {
    let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  }
}

pub fn place(h: HWND, r: RECT) {
  unsafe {
    let _ = SetWindowPos(
      h,
      Some(HWND_TOPMOST),
      r.left,
      r.top,
      r.right - r.left,
      r.bottom - r.top,
      SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
    );
  }
}

/// work area (screen minus the taskbar) of the main monitor, in physical pixels
pub fn work_area() -> RECT {
  let mut r = RECT::default();
  unsafe {
    let _ = SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut r as *mut RECT as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
  }
  r
}

pub fn cursor() -> (i32, i32) {
  let mut p = POINT::default();
  unsafe {
    let _ = GetCursorPos(&mut p);
  }
  (p.x, p.y)
}

pub fn lbutton() -> bool {
  unsafe { GetAsyncKeyState(0x01) as u16 & 0x8000 != 0 }
}

fn pid_of(h: HWND) -> u32 {
  let mut pid = 0u32;
  unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
  pid
}

pub fn own(h: HWND) -> bool {
  !h.0.is_null() && pid_of(h) == unsafe { GetCurrentProcessId() }
}

/// is the window in front covering its whole monitor (a game, a video, F11 in a browser)?
/// The second string says what was seen — for the log.
/// (Windows' own answer, SHQueryUserNotificationState, said «busy» almost all the time — not used.)
pub fn fullscreen_front() -> (bool, String) {
  unsafe {
    let h = GetForegroundWindow();
    if h.0.is_null() || own(h) {
      return (false, String::new());
    }
    let mut cls = [0u16; 64];
    let n = GetClassNameW(h, &mut cls);
    let c = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
    // the desktop, the taskbars, Alt+Tab / task view and the Start menu cover the screen too — they are not fullscreen apps
    const SHELL: [&str; 9] = [
      "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow", "ForegroundStaging",
      "Windows.UI.Core.CoreWindow", "MultitaskingViewFrame", "TaskSwitcherWnd",
    ];
    if SHELL.contains(&c.as_str()) {
      return (false, String::new());
    }
    // a maximized window has a title bar and reaches past the screen edges (-8 px);
    // real fullscreen has no title bar and is exactly the monitor. Browsers stay «maximized» in F11 — that's fine.
    let st = GetWindowLongW(h, GWL_STYLE) as u32;
    let cap = st & WS_CAPTION.0 == WS_CAPTION.0;
    let mut r = RECT::default();
    let _ = GetWindowRect(h, &mut r);
    let m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !GetMonitorInfoW(m, &mut mi).as_bool() {
      return (false, String::new());
    }
    let s = mi.rcMonitor;
    let f = !cap && r.left <= s.left && r.top <= s.top && r.right >= s.right && r.bottom >= s.bottom;
    let info = format!(
      "fullscreen {f}: class {c} caption {cap} zoomed {} win {},{} {}x{} monitor {},{} {}x{}",
      IsZoomed(h).as_bool(), r.left, r.top, r.right - r.left, r.bottom - r.top, s.left, s.top, s.right - s.left, s.bottom - s.top
    );
    (f, info)
  }
}

fn exe_path(pid: u32) -> Option<String> {
  unsafe {
    let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 1024];
    let mut n = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut n).is_ok();
    let _ = CloseHandle(p);
    if ok {
      Some(String::from_utf16_lossy(&buf[..n as usize]))
    } else {
      None
    }
  }
}

/// the program's own name ("Telegram Desktop", "Google Chrome") from its version info
fn description(path: &str) -> Option<String> {
  unsafe {
    let wp = wide(path);
    let size = GetFileVersionInfoSizeW(PCWSTR(wp.as_ptr()), None);
    if size == 0 {
      return None;
    }
    let mut data = vec![0u8; size as usize];
    GetFileVersionInfoW(PCWSTR(wp.as_ptr()), None, size, data.as_mut_ptr() as *mut _).ok()?;
    let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut n = 0u32;
    // first translation (language + code page)
    if !VerQueryValueW(data.as_ptr() as *const _, w!("\\VarFileInfo\\Translation"), &mut p, &mut n).as_bool() || n < 4 {
      return None;
    }
    let tr = std::slice::from_raw_parts(p as *const u16, 2);
    for q in [format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", tr[0], tr[1]), "\\StringFileInfo\\040904b0\\FileDescription".to_string()] {
      let wq = wide(&q);
      let mut p2: *mut core::ffi::c_void = std::ptr::null_mut();
      let mut n2 = 0u32;
      if VerQueryValueW(data.as_ptr() as *const _, PCWSTR(wq.as_ptr()), &mut p2, &mut n2).as_bool() && n2 > 1 {
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p2 as *const u16, n2 as usize - 1));
        let s = s.trim_matches(char::from(0)).trim().to_string();
        if !s.is_empty() {
          return Some(s);
        }
      }
    }
    None
  }
}

#[derive(serde::Serialize, Clone, Default)]
pub struct FgApp {
  pub exe: String,
  pub name: String,
  pub title: String,
}

pub fn fg_app() -> FgApp {
  unsafe {
    let h = GetForegroundWindow();
    if h.0.is_null() || own(h) {
      return FgApp::default();
    }
    let mut t = [0u16; 512];
    let n = GetWindowTextW(h, &mut t);
    let title = String::from_utf16_lossy(&t[..n.max(0) as usize]);
    let path = exe_path(pid_of(h)).unwrap_or_default();
    let exe = path.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    let name = description(&path).unwrap_or_else(|| exe.trim_end_matches(".exe").to_string());
    FgApp { exe, name, title }
  }
}

/// bring a window to the front even if Windows' focus rules say no (attach to the current front thread)
pub fn force_front(h: HWND) {
  unsafe {
    let fg = GetForegroundWindow();
    let me = GetCurrentThreadId();
    let other = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
    let attach = other != 0 && other != me;
    if attach {
      let _ = AttachThreadInput(me, other, true);
    }
    let _ = ShowWindow(h, SW_SHOW);
    let _ = SetForegroundWindow(h);
    let _ = BringWindowToTop(h);
    if attach {
      let _ = AttachThreadInput(me, other, false);
    }
  }
}

/// let the overlay take the keyboard (editing the text in review) — remembers who had it
pub fn take_focus(h: HWND) {
  unsafe {
    let fg = GetForegroundWindow();
    if !fg.0.is_null() && !own(fg) {
      PREV.store(fg.0 as isize, Ordering::SeqCst);
    }
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    SetWindowLongPtrW(h, GWL_EXSTYLE, ex & !(WS_EX_NOACTIVATE.0 as isize));
    let _ = SetWindowSubclass(h, Some(no_activate), 0x5241, 1);
  }
  force_front(h);
}

/// review: a click on the panel itself gives the overlay the keyboard (Windows always allows a click),
/// instead of asking for it after the click (Windows may refuse that). Off: never activated again,
/// and if the overlay has the keyboard, it goes back to the window the user was writing in.
pub fn click_focus(h: HWND, on: bool) {
  unsafe {
    let fg = GetForegroundWindow();
    if on && !fg.0.is_null() && !own(fg) {
      PREV.store(fg.0 as isize, Ordering::SeqCst);
    }
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    let n = if on { ex & !(WS_EX_NOACTIVATE.0 as isize) } else { ex | WS_EX_NOACTIVATE.0 as isize };
    SetWindowLongPtrW(h, GWL_EXSTYLE, n);
    let _ = SetWindowSubclass(h, Some(no_activate), 0x5241, on as usize);
    if !on && fg == h {
      let p = PREV.load(Ordering::SeqCst);
      let ph = hwnd_of(p);
      if p != 0 && IsWindow(Some(ph)).as_bool() {
        let _ = SetForegroundWindow(ph);
      }
    }
  }
}

pub fn is_front(h: HWND) -> bool {
  unsafe { GetForegroundWindow() == h }
}

/// give the keyboard back to the window the user was writing in
pub fn give_focus_back(h: HWND) {
  unsafe {
    let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    SetWindowLongPtrW(h, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
    let _ = SetWindowSubclass(h, Some(no_activate), 0x5241, 0);
    let p = PREV.swap(0, Ordering::SeqCst);
    let fg = GetForegroundWindow();
    if p != 0 && (fg.0.is_null() || own(fg)) {
      let ph = hwnd_of(p);
      if IsWindow(Some(ph)).as_bool() {
        let _ = SetForegroundWindow(ph);
      }
    }
  }
}

/// remember the window in front (called when a dictation starts)
pub fn note_front() {
  unsafe {
    let fg = GetForegroundWindow();
    if !fg.0.is_null() && !own(fg) {
      PREV.store(fg.0 as isize, Ordering::SeqCst);
    }
  }
}

pub fn open_url(url: &str) {
  let u = wide(url);
  unsafe {
    ShellExecuteW(None, w!("open"), PCWSTR(u.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
  }
}

const RUN: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const NAME: PCWSTR = w!("Retocker Snap");
pub fn autostart_get() -> bool {
  unsafe {
    let mut n = 0u32;
    RegGetValueW(HKEY_CURRENT_USER, RUN, NAME, RRF_RT_REG_SZ, None, None, Some(&mut n)).is_ok()
  }
}

pub fn autostart_set(on: bool) -> bool {
  unsafe {
    let mut k = HKEY::default();
    if RegCreateKeyExW(HKEY_CURRENT_USER, RUN, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut k, None).is_err() {
      return false;
    }
    let ok = if on {
      let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
      let v = wide(&format!("\"{exe}\" --autostart"));
      let b = std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 2);
      RegSetValueExW(k, NAME, None, REG_SZ, Some(b)).is_ok()
    } else {
      let r = RegDeleteValueW(k, NAME);
      r.is_ok() || r == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND
    };
    let _ = RegCloseKey(k);
    ok
  }
}
