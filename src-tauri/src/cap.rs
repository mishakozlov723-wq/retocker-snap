//! The screen picture: one GDI BitBlt of the whole virtual screen (all monitors) into memory, the frozen
//! frame the overlay shows (as a BMP, decoded almost for free), crops, the window rectangles for snapping,
//! and encoding to PNG / JPEG / WebP.
use std::sync::Mutex;

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub struct Frame {
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
  /// top-down BGRA, alpha forced to 255
  pub bgra: Vec<u8>,
}

/// the current frozen frame and a number that changes with every new one
pub static FRAME: Mutex<Option<(u64, Frame)>> = Mutex::new(None);

#[derive(Serialize, Clone, Copy, Debug)]
pub struct R {
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
}

pub fn virtual_screen() -> R {
  unsafe {
    R {
      x: GetSystemMetrics(SM_XVIRTUALSCREEN),
      y: GetSystemMetrics(SM_YVIRTUALSCREEN),
      w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
      h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
    }
  }
}

pub fn grab() -> Result<Frame, String> {
  let v = virtual_screen();
  if v.w <= 0 || v.h <= 0 {
    return Err("no screen".into());
  }
  unsafe {
    let sdc = GetDC(None);
    if sdc.is_invalid() {
      return Err("GetDC failed".into());
    }
    let mdc = CreateCompatibleDC(Some(sdc));
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
      biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: v.w,
      biHeight: -v.h,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB.0,
      ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = match CreateDIBSection(Some(mdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
      Ok(b) => b,
      Err(e) => {
        let _ = DeleteDC(mdc);
        ReleaseDC(None, sdc);
        return Err(format!("CreateDIBSection: {e}"));
      }
    };
    let old = SelectObject(mdc, HGDIOBJ(bmp.0));
    let r = BitBlt(mdc, 0, 0, v.w, v.h, Some(sdc), v.x, v.y, SRCCOPY | CAPTUREBLT);
    let n = (v.w as usize) * (v.h as usize) * 4;
    let mut out = Vec::with_capacity(n);
    if r.is_ok() && !bits.is_null() {
      out.extend_from_slice(std::slice::from_raw_parts(bits as *const u8, n));
    }
    SelectObject(mdc, old);
    let _ = DeleteObject(HGDIOBJ(bmp.0));
    let _ = DeleteDC(mdc);
    ReleaseDC(None, sdc);
    if let Err(e) = r {
      return Err(format!("BitBlt: {e}"));
    }
    if out.len() != n {
      return Err("empty frame".into());
    }
    for px in out.chunks_exact_mut(4) {
      px[3] = 255;
    }
    Ok(Frame { x: v.x, y: v.y, w: v.w, h: v.h, bgra: out })
  }
}

/// the frame as a 32-bit top-down BMP (what the overlay's <img> loads)
pub fn bmp(f: &Frame) -> Vec<u8> {
  let data = f.bgra.len() as u32;
  let mut b = Vec::with_capacity(54 + f.bgra.len());
  b.extend_from_slice(b"BM");
  b.extend_from_slice(&(54 + data).to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&54u32.to_le_bytes());
  b.extend_from_slice(&40u32.to_le_bytes());
  b.extend_from_slice(&f.w.to_le_bytes());
  b.extend_from_slice(&(-f.h).to_le_bytes());
  b.extend_from_slice(&1u16.to_le_bytes());
  b.extend_from_slice(&32u16.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&data.to_le_bytes());
  b.extend_from_slice(&2835u32.to_le_bytes());
  b.extend_from_slice(&2835u32.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&0u32.to_le_bytes());
  b.extend_from_slice(&f.bgra);
  b
}

/// a piece of the frame (rect in frame pixels), clamped to the frame
pub fn crop(f: &Frame, r: R) -> Option<(u32, u32, Vec<u8>)> {
  let x0 = r.x.clamp(0, f.w);
  let y0 = r.y.clamp(0, f.h);
  let x1 = (r.x + r.w).clamp(0, f.w);
  let y1 = (r.y + r.h).clamp(0, f.h);
  if x1 - x0 < 1 || y1 - y0 < 1 {
    return None;
  }
  let (w, h) = ((x1 - x0) as usize, (y1 - y0) as usize);
  let mut out = Vec::with_capacity(w * h * 4);
  for y in y0 as usize..y1 as usize {
    let s = (y * f.w as usize + x0 as usize) * 4;
    out.extend_from_slice(&f.bgra[s..s + w * 4]);
  }
  Some((w as u32, h as u32, out))
}

pub fn to_rgba(bgra: &[u8]) -> Vec<u8> {
  let mut v = bgra.to_vec();
  for p in v.chunks_exact_mut(4) {
    p.swap(0, 2);
  }
  v
}

/// "png" | "jpg" | "webp" bytes (BGRA input)
pub fn encode(w: u32, h: u32, bgra: &[u8], fmt: &str, quality: u8) -> Result<Vec<u8>, String> {
  use image::ImageEncoder;
  let rgba = to_rgba(bgra);
  let mut out = Vec::new();
  match fmt {
    "jpg" | "jpeg" => {
      let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("bad size")?;
      let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
      image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 100))
        .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    }
    "webp" => {
      image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    }
    _ => {
      image::codecs::png::PngEncoder::new_with_quality(
        &mut out,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
      )
      .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
      .map_err(|e| e.to_string())?;
    }
  }
  Ok(out)
}

/// a small JPEG preview for the corner card and history (longest side `max`)
pub fn thumb(w: u32, h: u32, bgra: &[u8], max: u32) -> Vec<u8> {
  let Some(img) = image::RgbaImage::from_raw(w, h, to_rgba(bgra)) else { return Vec::new() };
  let k = (max as f32 / w.max(h) as f32).min(1.0);
  let (tw, th) = (((w as f32 * k) as u32).max(1), ((h as f32 * k) as u32).max(1));
  let small = image::imageops::resize(&img, tw, th, image::imageops::FilterType::Triangle);
  let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
  let mut out = Vec::new();
  use image::ImageEncoder;
  let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86).write_image(rgb.as_raw(), tw, th, image::ExtendedColorType::Rgb8);
  out
}

#[derive(Serialize, Clone)]
pub struct Win {
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
  pub title: String,
}

struct Acc {
  v: Vec<Win>,
  skip: Vec<isize>,
}

unsafe extern "system" fn enum_cb(h: HWND, l: LPARAM) -> BOOL {
  let acc = &mut *(l.0 as *mut Acc);
  if acc.skip.contains(&(h.0 as isize)) || !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
    return BOOL(1);
  }
  let mut cloaked: u32 = 0;
  let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
  if cloaked != 0 {
    return BOOL(1);
  }
  let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
  if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
    return BOOL(1);
  }
  let mut r = RECT::default();
  if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
    let _ = GetWindowRect(h, &mut r);
  }
  if r.right - r.left < 24 || r.bottom - r.top < 24 {
    return BOOL(1);
  }
  let mut buf = [0u16; 256];
  let n = GetWindowTextW(h, &mut buf);
  let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
  // the desktop itself (Progman / WorkerW) has no title: whole-screen snapping covers it
  if title.is_empty() {
    return BOOL(1);
  }
  acc.v.push(Win { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, title });
  if acc.v.len() > 120 {
    return BOOL(0);
  }
  BOOL(1)
}

/// visible top-level windows, front to back, in screen pixels (our own windows skipped)
pub fn windows(skip: &[isize]) -> Vec<Win> {
  let mut acc = Acc { v: Vec::new(), skip: skip.to_vec() };
  unsafe {
    let _ = EnumWindows(Some(enum_cb), LPARAM(&mut acc as *mut Acc as isize));
  }
  acc.v
}

#[derive(Serialize, Clone)]
pub struct Mon {
  pub x: i32,
  pub y: i32,
  pub w: i32,
  pub h: i32,
  pub primary: bool,
}

unsafe extern "system" fn mon_cb(hm: HMONITOR, _dc: HDC, _r: *mut RECT, l: LPARAM) -> BOOL {
  let v = &mut *(l.0 as *mut Vec<Mon>);
  let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
  if GetMonitorInfoW(hm, &mut mi).as_bool() {
    let r = mi.rcMonitor;
    v.push(Mon { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, primary: mi.dwFlags & 1 != 0 });
  }
  BOOL(1)
}

pub fn monitors() -> Vec<Mon> {
  let mut v: Vec<Mon> = Vec::new();
  unsafe {
    let _ = EnumDisplayMonitors(None, None, Some(mon_cb), LPARAM(&mut v as *mut Vec<Mon> as isize));
  }
  v
}
