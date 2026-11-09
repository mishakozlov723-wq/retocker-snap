'use strict';
// Shared by every window: the settings (kept by the program, not by the page), helpers, icons.
(() => {
  const DEF = {
    // hotkeys
    hk_area: 'PrintScreen', hk_full: 'Shift+PrintScreen', hk_window: 'Alt+PrintScreen', hk_text: 'Ctrl+PrintScreen', hk_last: '',
    delay: 0, trayClick: 'snap',
    // the selection frame
    frame: 'solid', frameColor: '#ffffff', frameW: 1.5, frameR: 4, frameGlow: 0, frameShadow: true,
    handles: 'circle', handleSize: 9,
    // the background while you choose
    dim: 45, dimColor: '#000000', blur: 0, gray: false, appear: 'fade', appearMs: 160,
    // helpers
    cross: true, crossStyle: 'line', mag: true, magZoom: 8, magSize: 120, magShape: 'circle', hex: true,
    sizeLabel: 'corner', snapWin: true,
    // toolbar & after the shot
    toolbar: 'auto', instantAction: 'copy', barStyle: 'pill', barLabels: false,
    radAct: 'copy', radSize: 132, radSec: 3, radLabels: false, radThumb: true, radSpin: 'fan',
    post: 'fly', postMs: 460, bounce: 25, flash: false,
    cardOn: true, cardPos: 'br', cardSec: 4, quickAction: 'copy', saveAlsoCopy: true, copyAlsoSave: false,
    // saving
    saveDir: '', saveFmt: 'png', saveQ: 92, saveName: 'Snap {date} {time}',
    // text
    ocrLang: '', ocrFallback: true, groqKey: '', groqModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    groqPrompt: 'Перепиши весь текст с картинки точно как есть, сохраняя строки, абзацы и списки. Таблицы — в Markdown. Без комментариев, только текст.',
    groqProxy: '',
    // history & program
    histOn: true, histLimit: 200, startHidden: true, iconW: 'regular', accent: '#ebebea'
  };
  const T = window.__TAURI__;
  const invoke = (cmd, args) => T ? T.core.invoke(cmd, args) : Promise.reject(new Error('no tauri'));
  const listen = (ev, fn) => T ? T.event.listen(ev, fn) : Promise.resolve(() => {});
  const log = m => { try { invoke('log', { msg: String(m) }).catch(() => {}); } catch (e) {} };
  const LS = 'rs.cfg';
  let S = { ...DEF };
  async function load() {
    let v = null;
    try { v = await invoke('cfg_get'); } catch (e) { try { v = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e2) {} }
    S = { ...DEF, ...(v || {}) };
    return S;
  }
  function set(part) {
    Object.assign(S, part);
    if (T) invoke('cfg_set', { v: part }).catch(e => log('cfg_set ' + e));
    else try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {}
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KN = { PrintScreen: 'PrtSc', Escape: 'Esc', Return: 'Enter' };
  const hkLabel = hk => String(hk || '').split('+').filter(Boolean).map(p => KN[p] || p).join(' + ');
  const hkKbd = hk => hk ? String(hk).split('+').filter(Boolean).map(p => `<kbd>${esc(KN[p] || p)}</kbd>`).join('<span>+</span>') : '<span>не задана</span>';
  function rgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  const hexA = (h, a) => `rgba(${rgb(h).join(',')},${a})`;
  const pl = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };

  // Phosphor icons (ui/icons.js is built from @phosphor-icons/core); a plain square when one is missing
  function ic(name, w) {
    const set = window.PH || {}, wt = w || S.iconW || 'regular';
    const d = (set[wt] && set[wt][name]) || (set.regular && set.regular[name]);
    return d || '<svg viewBox="0 0 256 256"><rect x="48" y="48" width="160" height="160" rx="24" fill="none" stroke="currentColor" stroke-width="16"/></svg>';
  }
  // the animation helper: Motion when it is there, the browser's own otherwise
  function anim(el, kf, o = {}) {
    const M = window.Motion;
    if (M && M.animate) {
      const c = M.animate(el, kf, o);
      return c && c.finished ? c.finished : Promise.resolve(c);
    }
    const keys = {};
    for (const k in kf) keys[k] = kf[k];
    const a = el.animate ? el.animate(toWaapi(kf), { duration: (o.duration || o.visualDuration || .3) * 1000, easing: 'cubic-bezier(.3,1.25,.5,1)', fill: 'forwards' }) : null;
    return a ? a.finished.catch(() => {}) : Promise.resolve();
  }
  function toWaapi(kf) {
    const n = Math.max(...Object.values(kf).map(v => Array.isArray(v) ? v.length : 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = {}, tr = [];
      for (const k in kf) {
        const v = Array.isArray(kf[k]) ? kf[k][Math.min(i, kf[k].length - 1)] : kf[k];
        if (k === 'x') tr.push(`translateX(${typeof v === 'number' ? v + 'px' : v})`);
        else if (k === 'y') tr.push(`translateY(${typeof v === 'number' ? v + 'px' : v})`);
        else if (k === 'scale') tr.push(`scale(${v})`);
        else if (k === 'rotate') tr.push(`rotate(${typeof v === 'number' ? v + 'deg' : v})`);
        else f[k] = v;
      }
      if (tr.length) f.transform = tr.join(' ');
      out.push(f);
    }
    return out;
  }
  const spring = (ms, bounce) => ({ type: 'spring', visualDuration: Math.max(.05, (ms || 400) / 1000), bounce: Math.max(0, Math.min(.7, (bounce == null ? 25 : bounce) / 100)) });

  window.RS = { DEF, get S() { return S; }, load, set, invoke, listen, log, esc, hkLabel, hkKbd, rgb, hexA, pl, ic, anim, spring, tauri: !!T };
})();
