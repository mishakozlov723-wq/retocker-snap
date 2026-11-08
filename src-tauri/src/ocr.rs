//! Text from a picture: Windows' own offline OCR (fast, no internet) or a Groq vision model (smarter:
//! tables, handwriting, any language). Groq can go straight or through the user's Google Apps Script proxy.
use base64::Engine;
use windows::core::HSTRING;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// Windows OCR. `lang` like "ru" / "en-US"; empty = the user's languages.
pub fn windows(w: u32, h: u32, bgra: &[u8], lang: &str) -> Result<String, String> {
  let lang = lang.to_string();
  let data = bgra.to_vec();
  // WinRT wants an MTA thread of its own
  std::thread::spawn(move || -> Result<String, String> {
    unsafe {
      let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let e = |x: windows::core::Error| x.message().to_string();
    // tiny pictures read badly: the engine wants letters of about 20+ px
    let (w, h, data) = upscale(w, h, data);
    let max = OcrEngine::MaxImageDimension().map_err(e)?;
    let (w, h, data) = if w > max || h > max { shrink(w, h, data, max) } else { (w, h, data) };
    let engine = if lang.is_empty() {
      OcrEngine::TryCreateFromUserProfileLanguages()
    } else {
      Language::CreateLanguage(&HSTRING::from(lang.as_str())).and_then(|l| OcrEngine::TryCreateFromLanguage(&l))
    }
    .map_err(|_| "В Windows нет пакета распознавания для этого языка".to_string())?;
    let dw = DataWriter::new().map_err(e)?;
    dw.WriteBytes(&data).map_err(e)?;
    let buf = dw.DetachBuffer().map_err(e)?;
    let bmp = SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Bgra8, w as i32, h as i32).map_err(e)?;
    let res = engine.RecognizeAsync(&bmp).map_err(e)?.get().map_err(e)?;
    let lines = res.Lines().map_err(e)?;
    let mut out = Vec::new();
    for i in 0..lines.Size().map_err(e)? {
      out.push(lines.GetAt(i).map_err(e)?.Text().map_err(e)?.to_string());
    }
    Ok(out.join("\n"))
  })
  .join()
  .map_err(|_| "OCR упал".to_string())?
}

fn upscale(w: u32, h: u32, data: Vec<u8>) -> (u32, u32, Vec<u8>) {
  if h >= 60 || w * 3 > 9000 {
    return (w, h, data);
  }
  let k = if h < 30 { 3 } else { 2 };
  resize(w, h, data, w * k, h * k)
}
fn shrink(w: u32, h: u32, data: Vec<u8>, max: u32) -> (u32, u32, Vec<u8>) {
  let k = max as f32 / w.max(h) as f32;
  resize(w, h, data, ((w as f32 * k) as u32).max(1), ((h as f32 * k) as u32).max(1))
}
fn resize(w: u32, h: u32, data: Vec<u8>, tw: u32, th: u32) -> (u32, u32, Vec<u8>) {
  match image::RgbaImage::from_raw(w, h, data.clone()) {
    Some(img) => (tw, th, image::imageops::resize(&img, tw, th, image::imageops::FilterType::CatmullRom).into_raw()),
    None => (w, h, data),
  }
}

pub struct GroqOpts {
  pub key: String,
  pub model: String,
  pub prompt: String,
  pub proxy: String,
}

/// Groq vision: the picture goes as a JPEG data URL
pub fn groq(jpeg: &[u8], o: &GroqOpts) -> Result<String, String> {
  if o.key.trim().is_empty() {
    return Err("Нужен ключ Groq — вставь его в настройках, раздел «Текст»".into());
  }
  let b64 = base64::engine::general_purpose::STANDARD.encode(jpeg);
  let chat = serde_json::json!({
    "model": if o.model.is_empty() { "meta-llama/llama-4-scout-17b-16e-instruct" } else { o.model.as_str() },
    "temperature": 0,
    "max_completion_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": o.prompt },
        { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{b64}") } }
      ]
    }]
  });
  let agent = crate::upd::agent();
  let proxy = o.proxy.trim();
  if !proxy.is_empty() {
    let r = agent
      .post(proxy)
      .set("Content-Type", "application/json")
      .send_string(&serde_json::json!({ "key": o.key.trim(), "chat": chat }).to_string())
      .map_err(|e| format!("Прокси не ответил: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let err = v["error"].as_str().unwrap_or("");
    if !err.is_empty() {
      return Err(format!("Groq: {err}"));
    }
    return Ok(clean(v["text"].as_str().unwrap_or("")));
  }
  let r = agent
    .post("https://api.groq.com/openai/v1/chat/completions")
    .set("Authorization", &format!("Bearer {}", o.key.trim()))
    .set("Content-Type", "application/json")
    .send_string(&chat.to_string());
  let body = match r {
    Ok(r) => r.into_string().map_err(|e| e.to_string())?,
    Err(ureq::Error::Status(code, r)) => {
      let t = r.into_string().unwrap_or_default();
      let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
      let m = v["error"]["message"].as_str().unwrap_or(&t).to_string();
      return Err(match code {
        401 => "Groq не принял ключ — проверь его в настройках".into(),
        403 => "Groq закрыт из твоей страны — включи прокси в настройках".into(),
        429 => "Groq: слишком много запросов, подожди минуту".into(),
        _ => format!("Groq {code}: {}", m.chars().take(200).collect::<String>()),
      });
    }
    Err(e) => return Err(format!("Нет связи с Groq: {e}")),
  };
  let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
  Ok(clean(v["choices"][0]["message"]["content"].as_str().unwrap_or("")))
}

/// models like to wrap the answer in ``` fences: drop them
fn clean(s: &str) -> String {
  let t = s.trim();
  if let Some(rest) = t.strip_prefix("```") {
    let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
    return rest.trim_end().trim_end_matches("```").trim().to_string();
  }
  t.to_string()
}

pub fn groq_ping(key: &str, proxy: &str) -> Result<(), String> {
  let agent = crate::upd::agent();
  if !proxy.trim().is_empty() {
    let r = agent
      .post(proxy.trim())
      .set("Content-Type", "application/json")
      .send_string(&serde_json::json!({ "key": key.trim(), "ping": true }).to_string())
      .map_err(|e| format!("Прокси не ответил: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or_default();
    return if v["ok"].as_bool() == Some(true) { Ok(()) } else { Err(format!("Ключ не подошёл (код {})", v["code"])) };
  }
  match agent.get("https://api.groq.com/openai/v1/models").set("Authorization", &format!("Bearer {}", key.trim())).call() {
    Ok(_) => Ok(()),
    Err(ureq::Error::Status(401, _)) => Err("Ключ не подошёл".into()),
    Err(ureq::Error::Status(403, _)) => Err("Groq закрыт из твоей страны — нужен прокси".into()),
    Err(e) => Err(format!("Нет связи: {e}")),
  }
}
