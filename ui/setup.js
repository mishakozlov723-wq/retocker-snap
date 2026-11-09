'use strict';
// The installer and the uninstaller window. It is the same exe as the app (see src-tauri/src/setup.rs):
// named «…Setup….exe» it installs itself, started with --uninstall it removes itself.
// In a plain browser (no Tauri) it runs on made-up data, so the look can be checked anywhere:
// setup.html?mode=uninstall · ?old · ?fail · ?auto
(() => {
const RA = window.RS, { esc } = RA;
const $ = s => document.querySelector(s);
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const Q = new URLSearchParams(location.search);
const UN = ((window.RA_SETUP && window.RA_SETUP.mode) || Q.get('mode')) === 'uninstall';
const NAME = 'Retocker Snap';
const IC = {
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.2h4.2l1.4 1.5H14v6.9H2z"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5"/></svg>',
  drive: '<svg viewBox="0 0 16 16"><rect x="1.8" y="4.6" width="12.4" height="6.8" rx="1.6"/><path d="M11.2 8h.01M4.5 8h3"/></svg>',
  usb: '<svg viewBox="0 0 16 16"><rect x="5.4" y="1.8" width="5.2" height="4.6" rx=".8"/><rect x="3.8" y="6.4" width="8.4" height="7.8" rx="1.8"/></svg>',
};

// no reloading, zooming or the browser menu in this window
addEventListener('keydown', e => { if ((e.ctrlKey && /^[rpfgjsu]$/i.test(e.key)) || /^F(5|7)$/.test(e.key)) e.preventDefault(); }, true);
addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
addEventListener('contextmenu', e => { if (!e.target.closest('input')) e.preventDefault(); });

/* ---------------- Windows paths */
const trim = p => (p.length > 3 ? p.replace(/[\\/]+$/, '') : p);
const parentOf = p => { p = trim(p); if (/^[A-Za-z]:\\?$/.test(p)) return null; const i = p.lastIndexOf('\\'); if (i < 0) return null; const r = p.slice(0, i); return /^[A-Za-z]:$/.test(r) ? r + '\\' : r; };
const join = (a, b) => (a.endsWith('\\') ? a + b : a + '\\' + b);
const lastName = p => trim(p).split('\\').pop();
const resOf = p => (lastName(p).toLowerCase() === NAME.toLowerCase() ? trim(p) : join(trim(p), NAME));
const gb = n => (n >= 1e12 ? (n / 1e12).toFixed(1).replace('.', ',') + ' ТБ' : n >= 1e10 ? Math.round(n / 1e9) + ' ГБ' : (n / 1e9).toFixed(1).replace('.', ',') + ' ГБ');

/* ---------------- talking to the exe (or to made-up data in a browser) */
const FAKE = {
  'C:\\': ['Program Files', 'Program Files (x86)', 'Users', 'Windows', 'Games'],
  'C:\\Users': ['Public', 'Миша'],
  'C:\\Users\\Миша': ['AppData', 'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'],
  'C:\\Users\\Миша\\AppData': ['Local', 'LocalLow', 'Roaming'],
  'C:\\Users\\Миша\\AppData\\Local': ['Google', 'Microsoft', 'Programs', 'Temp', 'Telegram Desktop'],
  'C:\\Users\\Миша\\AppData\\Local\\Programs': ['Microsoft VS Code', 'Python', 'TradingView'],
  'D:\\': ['Games', 'Trading', 'Видео'],
  'C:\\Program Files': ['Common Files', 'Google', 'Microsoft Office', 'Windows Defender'], 'C:\\Games': [],
};
const MOCK = {
  setup_info: () => ({ version: '1.0.21', dir: 'C:\\Users\\Миша\\AppData\\Local\\Programs\\Retocker Snap', base: 'C:\\Users\\Миша\\AppData\\Local\\Programs', installed: false, old: Q.has('old'), autostart: true, desktop: true, auto: Q.has('auto') }),
  fs_drives: () => [{ path: 'C:\\', label: 'Windows', free: 87.4e9, total: 476.3e9, removable: false }, { path: 'D:\\', label: 'Данные', free: 1.21e12, total: 2e12, removable: false }, { path: 'E:\\', label: '', free: 0.6e9, total: 31.9e9, removable: true }],
  fs_list: ({ path }) => { const k = trim(path), d = FAKE[k]; if (!d && !FAKE.hasOwnProperty(k)) throw 'Папка не найдена'; return { path: k, parent: parentOf(k), dirs: d.map(n => ({ name: n, path: join(k, n) })) }; },
  fs_mkdir: ({ path, name }) => { const k = trim(path), p = join(k, name); if (FAKE[p]) throw 'Такая папка уже есть'; FAKE[k].push(name); FAKE[p] = []; return p; },
  fs_check: ({ path }) => ({ ok: /^[A-Z]:\\./i.test(path), writable: !/^C:\\(Program Files|Windows)|^C:\\[^\\]+$/i.test(path), free: 87.4e9, exists: false }),
  setup_run: async ({ opts }) => {
    for (const [p, t] of [[6, 'Закрываю Retocker Snap…'], [18, 'Убираю прошлую версию…'], [45, 'Копирую программу…'], [70, 'Создаю ярлыки…'], [86, 'За��исываю в Windows…'], [100, 'Готово']]) { prog({ p, t }); await sleep(Q.has('slow') ? 1200 : 450); }
    if (Q.has('fail')) throw 'Не получилось скопировать программу: Отказано в доступе. (os error 5)';
    return join(opts.dir, 'retocker-snap.exe');
  },
  uninst_run: async () => { for (const [p, t] of [[10, 'Закрываю Retocker Snap…'], [30, 'Убираю автозапуск и ярлыки…'], [50, 'Убираю из списка программ…'], [100, 'Готово']]) { prog({ p, t }); await sleep(450); } },
  setup_launch: () => toast('Здесь бы запустилась программа'), setup_close: () => toast('Здесь бы окно закрылось'), setup_min: () => {},
};
const call = (cmd, args) => (RA.tauri ? RA.invoke(cmd, args) : Promise.resolve().then(() => MOCK[cmd](args || {})));
const msg = e => String((e && e.message) || e || 'ошибка');

const toastEl = $('#toast');
function toast(t, ms = 2600) { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('on'), ms); }

/* ---------------- the live example on top: the real selection, the same as in the settings */
let dm = null;
function demo(on) {
  if (!on) { if (dm) { dm.stop(); dm = null; } return; }
  if (dm || !window.FX) return;
  try { dm = FX.demo($('#pv'), () => RA.S, { outro: true }); } catch (e) { dm = null; }
}

/* ---------------- screens */
let cur = '', busy = false, info = null;
const opts = { dir: '', autostart: true, desktop: true };
function show(id) {
  if (cur === id) return;
  cur = id; busy = id === 'prog';
  document.querySelectorAll('.scr').forEach(s => s.classList.toggle('on', s.id === 's-' + id));
  $('#wClose').style.opacity = busy ? '.35' : '';
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}
function prog(e) {
  if (!e) return;
  $('#gBar').style.width = Math.max(2, Math.min(100, +e.p || 0)) + '%';
  if (e.t) $('#gStep').textContent = e.t;
}

/* install: the first screen */
async function paintDir() {
  const d = opts.dir, el = $('#wDir');
  el.textContent = d; el.title = d;
  const c = await call('fs_check', { path: d }).catch(() => null);
  if (opts.dir !== d) return;
  $('#wNote').textContent = !c ? '' : !c.ok ? 'Выбери папку на диске' : c.free && c.free < 60e6 ? 'На этом диске почти нет места' : !c.writable ? 'Для этой папки Windows спросит разрешение' : '';
  $('#wGo').disabled = !!c && !c.ok;
}
async function install() {
  if (busy) return;
  opts.autostart = $('#wAuto').checked; opts.desktop = $('#wDesk').checked;
  $('#gTitle').textContent = 'Устанавливаю…'; prog({ p: 2, t: 'Готовлюсь…' }); show('prog');
  try {
    const exe = await call('setup_run', { opts: { ...opts } });
    prog({ p: 100, t: 'Готово' }); await sleep(380);
    $('#dTxt').innerHTML = info.installed || info.old
      ? 'Retocker Snap обновлена. Настройки и ключ Groq на месте — всё как раньше.'
      : 'Retocker Snap установлена. Нажми <kbd>PrintScreen</kbd> и выдели область — снимок сразу окажется в буфере.';
    $('#dSub').textContent = 'Папка: ' + (parentOf(String(exe || '')) || opts.dir);
    show('done');
  } catch (e) {
    $('#eTitle').textContent = 'Не получилось установить'; $('#eTxt').textContent = msg(e); show('err');
  }
}

/* install: choosing a folder */
const pk = { path: '', parent: null, dirs: [], drives: [], wait: Promise.resolve() };
async function openPick() {
  show('pick');
  pk.drives = await call('fs_drives').catch(() => []);
  const D = $('#pDrives'); D.innerHTML = '';
  pk.drives.forEach(d => {
    const used = d.total ? 1 - d.free / d.total : 0;
    const b = h('button', 'drv' + (d.free < 1e9 ? ' low' : ''), (d.removable ? IC.usb : IC.drive) +
      `<span class="dt"><span>${esc(d.path.slice(0, 2))}${d.label ? ' · ' + esc(d.label) : ''}</span><small>${gb(d.free)} свободно</small><span class="du"><b style="width:${(used * 100).toFixed(1)}%"></b></span></span>`);
    b._p = d.path; b.title = d.path; b.onclick = () => go(d.path);
    D.append(b);
  });
  pk.path = '';
  let p = parentOf(resOf(opts.dir));
  for (let i = 0; i < 16 && p && !pk.path; i++) { if (!(await go(p, true))) p = parentOf(p); }
  if (!pk.path) await go((pk.drives[0] || {}).path || 'C:\\');
}
async function go(p, quiet) {
  try {
    const r = await call('fs_list', { path: p });
    Object.assign(pk, { path: r.path, parent: r.parent, dirs: r.dirs || [] });
    paintPick(); return true;
  } catch (e) { if (!quiet) toast('Не открывается: ' + msg(e)); return false; }
}
function paintPick() {
  [...$('#pDrives').children].forEach(b => b.classList.toggle('on', pk.path.toUpperCase().startsWith(b._p.toUpperCase())));
  const parts = trim(pk.path).split('\\').filter(Boolean), C = $('#pCrumbs'); C.innerHTML = '';
  const from = Math.max(0, parts.length - 4);
  if (from > 0) C.append(h('i', '', '…'));
  for (let i = from; i < parts.length; i++) {
    if (i > 0) C.append(h('i', '', '›'));
    const to = i === 0 ? parts[0] + '\\' : parts.slice(0, i + 1).join('\\');
    const b = h('button', i === parts.length - 1 ? 'last' : '', esc(parts[i])); b.title = to; b.onclick = () => go(to);
    C.append(b);
  }
  const L = $('#pList'); L.innerHTML = ''; L.scrollTop = 0;
  if (pk.parent) { const u = h('div', 'fi up', IC.up + '<span>На уровень выше</span>'); u.onclick = () => go(pk.parent); L.append(u); }
  pk.dirs.forEach(d => { const r = h('div', 'fi', IC.folder + `<span>${esc(d.name)}</span>`); r.title = d.path; r.onclick = () => go(d.path); L.append(r); });
  if (!pk.dirs.length) L.append(h('div', 'fempty', 'Здесь пока пусто'));
  paintRes();
}
async function paintRes() {
  const res = resOf(pk.path), el = $('#pRes');
  el.textContent = res; el.title = res;
  const c = await call('fs_check', { path: res }).catch(() => null);
  if (resOf(pk.path) !== res) return;
  $('#pWarn').hidden = !c || !c.ok || c.writable;
  $('#pOk').disabled = !c || !c.ok;
}
function newFolder() {
  const L = $('#pList'), was = L.querySelector('.fi.new');
  if (was) { was.querySelector('input').focus(); return; }
  const r = h('div', 'fi new', IC.folder), i = h('input'); i.value = 'Новая папка'; i.maxLength = 120; i.spellcheck = false; r.append(i);
  const e0 = L.querySelector('.fempty'); if (e0) e0.remove();
  const up = L.querySelector('.fi.up'); if (up) up.after(r); else L.prepend(r);
  r.scrollIntoView({ block: 'nearest' }); i.focus(); i.select();
  let done = false;
  const fin = ok => {
    if (done) return pk.wait; done = true;
    const name = i.value.trim();
    if (!ok || !name) { r.remove(); if (!pk.dirs.length) paintPick(); return pk.wait; }
    pk.wait = call('fs_mkdir', { path: pk.path, name }).then(p => go(p)).catch(e => { toast(msg(e)); r.remove(); if (!pk.dirs.length) paintPick(); });
    return pk.wait;
  };
  i.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); fin(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); }
  };
  // like Explorer: clicking elsewhere keeps the typed name
  i.onblur = () => fin(true);
}
async function pickOk() {
  await pk.wait;
  if ($('#pOk').disabled) return;
  opts.dir = resOf(pk.path); paintDir(); show('welcome');
}

/* uninstall */
async function uninstall() {
  if (busy) return;
  const wipe = $('#uWipe').checked;
  $('#gTitle').textContent = 'Удаляю…'; prog({ p: 3, t: 'Готовлюсь…' }); show('prog');
  try {
    await call('uninst_run', { wipe });
    prog({ p: 100, t: 'Готово' }); await sleep(380);
    $('#udTxt').textContent = wipe ? 'Программа, настройки и ключ удалены.' : 'Программа удалена. Настройки и ключ Groq остались — если установишь снова, всё будет как было.';
    show('undone');
    // the example goes away too
    demo(false);
  } catch (e) {
    $('#eTitle').textContent = 'Не получилось удалить'; $('#eTxt').textContent = msg(e); show('err');
  }
}

/* ---------------- buttons, keys */
$('#wMin').onclick = () => call('setup_min').catch(() => {});
$('#wClose').onclick = () => { if (busy) { toast('Секунду — ещё не закончил'); return; } call('setup_close').catch(() => {}); };
$('#wPick').onclick = openPick;
$('#wGo').onclick = install;
$('#pNew').onclick = newFolder;
$('#pCancel').onclick = () => show('welcome');
$('#pOk').onclick = pickOk;
$('#dRun').onclick = () => call('setup_launch').catch(() => {});
$('#dClose').onclick = $('#eClose').onclick = $('#udClose').onclick = $('#uCancel').onclick = () => call('setup_close').catch(() => {});
// after a failed install: back to the first screen (another folder, or just «Установить» again)
$('#eRetry').onclick = () => (UN ? uninstall() : show('welcome'));
$('#uGo').onclick = uninstall;
addEventListener('keydown', e => {
  if (e.key === 'Escape' && cur === 'pick' && !e.target.closest('input')) { e.preventDefault(); show('welcome'); }
  if (e.key === 'Backspace' && cur === 'pick' && !e.target.closest('input') && pk.parent) { e.preventDefault(); go(pk.parent); }
});
if (RA.tauri) RA.listen('setup', e => prog(e.payload));

/* the build check (RA_SETUP_AUTO): walk through the screens by itself, so the screenshots show each one */
async function auto() {
  await sleep(3500);
  if (UN) { await uninstall(); await sleep(3500); call('setup_close').catch(() => {}); return; }
  await openPick(); await sleep(3000);
  show('welcome'); await sleep(1200);
  await install(); await sleep(3500);
  call('setup_close').catch(() => {});
}

(async () => {
  info = await call('setup_info').catch(() => null) || { version: '', dir: 'C:\\' + NAME, base: '', installed: false, old: false, autostart: true, desktop: true, auto: false };
  $('#ttl').textContent = document.title = UN ? 'Удаление Retocker Snap' : 'Установка Retocker Snap';
  if (UN) show('un');
  else {
    $('#wVer').textContent = info.version ? 'v' + info.version : '';
    Object.assign(opts, { dir: info.dir, autostart: !!info.autostart, desktop: !!info.desktop });
    $('#wAuto').checked = opts.autostart; $('#wDesk').checked = opts.desktop;
    if (info.installed || info.old) {
      const w = $('#wWas'); w.hidden = false;
      w.lastChild.textContent = info.installed ? 'Уже установлена — обновлю, настройки и ключ Groq останутся' : 'Нашёл прошлую версию — заменю её, настройки и ключ Groq останутся';
    }
    paintDir();
    show('welcome');
  }
  requestAnimationFrame(() => demo(!UN));
  if (info.auto) auto();
})();
})();
