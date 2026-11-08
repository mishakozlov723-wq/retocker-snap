//! The clipboard: a picture (CF_DIB plus the "PNG" format browsers, Telegram and Discord prefer) or text.
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;

fn open(owner: HWND) -> bool {
  for _ in 0..30 {
    if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
      return true;
    }
    std::thread::sleep(Duration::from_millis(15));
  }
  false
}

fn put(f: u32, bytes: &[u8]) {
  unsafe {
    let Ok(g) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) else { return };
    let p = GlobalLock(g) as *mut u8;
    if p.is_null() {
      let _ = GlobalFree(Some(g));
      return;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
    let _ = GlobalUnlock(g);
    if SetClipboardData(f, Some(HANDLE(g.0))).is_err() {
      let _ = GlobalFree(Some(g));
    }
  }
}

/// bottom-up 32-bit DIB from top-down BGRA
fn dib(w: u32, h: u32, bgra: &[u8]) -> Vec<u8> {
  let mut b = Vec::with_capacity(40 + bgra.len());
  b.extend_from_slice(&40u32.to_le_bytes());
  b.extend_from_slice(&(w as i32).to_le_bytes());
  b.extend_from_slice(&(h as i32).to_le_bytes());
  b.extend_from_slice(&1u16.to_le_bytes());
  b.extend_from_slice(&32u16.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&(bgra.len() as u32).to_le_bytes());
  b.extend_from_slice(&2835u32.to_le_bytes());
  b.extend_from_slice(&2835u32.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  let row = w as usize * 4;
  for y in (0..h as usize).rev() {
    b.extend_from_slice(&bgra[y * row..y * row + row]);
  }
  b
}

pub fn set_image(owner: HWND, w: u32, h: u32, bgra: &[u8], png: &[u8]) -> bool {
  if !open(owner) {
    return false;
  }
  unsafe {
    let _ = EmptyClipboard();
    put(CF_DIB, &dib(w, h, bgra));
    if !png.is_empty() {
      put(RegisterClipboardFormatW(w!("PNG")), png);
    }
    let _ = CloseClipboard();
  }
  true
}

pub fn set_text(owner: HWND, text: &str) -> bool {
  if !open(owner) {
    return false;
  }
  unsafe {
    let _ = EmptyClipboard();
    let mut w16: Vec<u16> = text.encode_utf16().collect();
    w16.push(0);
    let bytes = std::slice::from_raw_parts(w16.as_ptr() as *const u8, w16.len() * 2);
    put(CF_UNICODETEXT, bytes);
    let _ = CloseClipboard();
  }
  true
}
