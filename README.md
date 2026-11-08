# Retocker Snap

Минималистичный скриншотер для Windows в стиле Retocker. Tauri 2 + Rust + WebView2.

- **PrintScreen** — выделить область, **Shift+PrintScreen** — весь экран, **Alt+PrintScreen** — окно, **Ctrl+PrintScreen** — текст со скрина.
- В выделении: Enter/Ctrl+C — копировать, Ctrl+S — сохранить, T — текст (Windows OCR), Shift+T — текст через Groq, стрелки двигают, Alt+стрелки меняют размер, Esc — отмена.
- Настройки: рамка, ручки, затемнение/размытие фона, подсказки, анимация после снимка, сохранение, текст, горячие клавиши, история.

Сборка: `npm install`, `node scripts/prepare.mjs`, `npx tauri icon app-icon.svg -o src-tauri/icons`, `npx tauri build --no-bundle`.
CI собирает на каждый push в main; с `[release]` в сообщении коммита публикует в retocker-snap-download (нужны секреты `UPDATE_KEY` и `DL_TOKEN`).
