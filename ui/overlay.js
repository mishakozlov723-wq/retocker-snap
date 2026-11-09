'use strict';
// The full-screen overlay. The program sends the frozen screen, this page lets you choose a part of it.
(() => {
  const root = document.getElementById('root');
  const st = FX.make(root);
  let D = null, dpr = 1, state = 'off', busy = false;
  let a0 = null, r = null, drag = null, hov = null, mx = 0, my = 0;
  const P = v => Math.round(v * dpr);

  // a page that cannot draw the frame closes itself instead of showing an empty window over the screen
  RS.listen('shot', e => start(e.payload).catch(err => { RS.log('ovl start ' + err); state = 'off'; RS.invoke('ovl_hide').catch(() => {}); }));
  RS.listen('abort', () => { if (window.ED) ED.abort(); if (state === 'off') return; state = 'off'; busy = false; clearTimeout(radT); clearTimeout(capT); st.reset(); root.classList.remove('ready'); });
  setInterval(() => { if (state !== 'off') RS.invoke('ovl_alive').catch(() => {}); }, 1000);
  RS.listen('force', () => { root.classList.add('ready'); if (state === 'idle') st.intro(mx, my); });
  RS.listen('test_sel', e => {
    const [x, y, w, h, act] = String(e.payload || '').split(',');
    r = { x: +x / dpr, y: +y / dpr, w: +w / dpr, h: +h / dpr };
    adjust();
    if (act) setTimeout(() => act_(act.trim()), 700);
  });

  RS.listen('test_ed', e => {
    const c = String(e.payload || '').trim();
    RS.log('test_ed ' + c);
    if (c === 'open') openEd(); else if (window.ED) ED.test(c);
  });

  async function start(d) {
    D = d; busy = false;
    if (window.ED) { ED.abort(); ED.reset(); }
    const c = { ...RS.DEF, ...(d.cfg || {}) };
    dpr = window.devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    st.ai = !!(c.groqKey || '').trim();
    st.reset();
    root.classList.remove('ready');
    const t0 = performance.now();
    await Promise.race([st.frame('http://snap.localhost/frame?n=' + d.n, W, H, dpr), new Promise(res => setTimeout(res, 1500))]);
    const dt = Math.round(performance.now() - t0);
    if (dt > 600) RS.log(`ovl frame ${d.n} took ${dt} ms`);
    st.cfg(c);
    a0 = null; r = null; drag = null; hov = null; state = 'idle';
    document.body.className = '';
    mx = (d.cur ? d.cur[0] : W * dpr / 2) / dpr; my = (d.cur ? d.cur[1] : H * dpr / 2) / dpr;
    const full = d.mode === 'full';
    // the dim is ready before the window shows and plays once it is really on screen
    if (full) st.shadeOff(); else st.introPrep(mx, my);
    root.classList.add('ready');
    if (d.mode === 'text') st.hint(`${RS.ic('text-t')} Выдели текст — он сразу окажется в буфере <kbd>Esc</kbd>`);
    if (!full) idleMove();
    try { await RS.invoke('ovl_ready', { n: d.n }); }
    finally {
      window.focus();
      if (full) fullShot(); else st.intro(mx, my);
    }
  }
  // the whole screen with the capsule or the round menu: the monitor under the mouse flows into it
  function fullShot() {
    const px = mx * dpr, py = my * dpr;
    const m = (D.mons || []).find(q => inR(px, py, q));
    r = m ? clip({ x: sc(m.x), y: sc(m.y), w: sc(m.w), h: sc(m.h) }) : { x: 0, y: 0, w: innerWidth, h: innerHeight };
    adjust();
  }

  const C = () => st.c;
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const sc = v => v / dpr;
  const inR = (x, y, q) => q && x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h;
  function under(x, y) {
    if (!D) return null;
    const px = x * dpr, py = y * dpr;
    if (C().snapWin) for (const w of D.wins || []) if (inR(px, py, w)) return { x: sc(w.x), y: sc(w.y), w: sc(w.w), h: sc(w.h) };
    for (const m of D.mons || []) if (inR(px, py, m)) return { x: sc(m.x), y: sc(m.y), w: sc(m.w), h: sc(m.h), mon: true };
    return { x: 0, y: 0, w: innerWidth, h: innerHeight, mon: true };
  }
  function clip(q) {
    const W = innerWidth, H = innerHeight;
    let x = Math.max(0, q.x), y = Math.max(0, q.y);
    return { x, y, w: Math.max(0, Math.min(W, q.x + q.w) - x), h: Math.max(0, Math.min(H, q.y + q.h) - y) };
  }
  const monsCss = () => (D && D.mons || []).map(m => ({ x: sc(m.x), y: sc(m.y), w: sc(m.w), h: sc(m.h) }));
  // a window that fills its monitor is not lit up: the whole screen stays dimmed
  const big = q => monsCss().some(m => q.w * q.h >= m.w * m.h * .9 && q.x < m.x + m.w && q.x + q.w > m.x && q.y < m.y + m.h && q.y + q.h > m.y);
  function idleMove() {
    hov = under(mx, my);
    st.hover(C().snapWin && hov && !hov.mon && !big(hov) ? hov : null);
    st.cursor(mx, my, true);
  }
  function adjust() {
    state = 'adjust';
    st.hint('');
    st.select(r, true);
    st.cursor(0, 0, false);
    if (D && D.mode === 'text') return act_('ocr');
    if (C().toolbar === 'instant') return act_(C().instantAction || 'copy');
    if (C().toolbar === 'capsule') return capsule();
    if (C().toolbar === 'radial') return radial();
    st.bar(true);
  }

  // ---------------- the capsule
  let capT = 0, capHov = false;
  async function capsule() {
    state = 'capsule'; busy = true; capHov = false;
    st.cursor(0, 0, false);
    const c = C(), a = c.capAct || 'copy';
    const job = a !== 'none' ? RS.invoke('shot_do', { r: rpx(), action: a, card: false }).then(() => '', e => String(e || 'Не получилось')) : Promise.resolve('');
    await st.capOpen(c.capPos || 'place', monsCss(), a);
    const R = st._cap;
    if (R && R.gh && window.ED) edHook(R);
    if (R && state === 'capsule') RS.log('capsule up for ' + (+C().capSec || 0) + ' s');
    const err = await job;
    if (err) { RS.log('shot_do ' + err); st.capDone(a, false, err.slice(0, 40)); }
    busy = false;
    armCap();
  }
  function armCap() {
    clearTimeout(capT);
    const s = +C().capSec || 0;
    if (s > 0 && !capHov && state === 'capsule') capT = setTimeout(() => capEnd('timer'), s * 1000);
  }
  async function capDo(a) {
    if (busy || state !== 'capsule' || !r) return;
    busy = true; clearTimeout(capT);
    st.capBusy(a);
    let ok = true, txt = '';
    // after the editor the capsule buttons work with the edited picture
    const ed = window.ED && ED.edited() && (a === 'copy' || a === 'save');
    try { if (ed) await ED.put(a); else await RS.invoke('shot_do', { r: rpx(), action: a, card: false }); }
    catch (e) { ok = false; txt = String(e || '').slice(0, 40); RS.log('shot_do ' + e); }
    st.capDone(a, ok, ok ? '' : txt || 'Не получилось');
    busy = false;
    armCap();
  }
  async function capEnd(why) {
    if (state !== 'capsule') return;
    RS.log('capsule closed: ' + (why || '?'));
    state = 'closing'; clearTimeout(capT);
    try { await Promise.race([st.capClose(), wait(900)]); } finally { close(); }
  }
  st.onCap = a => a === 'close' ? capEnd('cross') : capDo(a);
  st.onCapHover = on => { capHov = on; if (on) clearTimeout(capT); else armCap(); };
  // ---------------- the editor: a click on the capsule thumbnail
  function edHook(R) {
    const g = R.gh; if (g._ed) return; g._ed = 1;
    g.classList.add('edok');
    const b = document.createElement('div'); b.className = 'edp'; b.innerHTML = ED.penIcon(); g.appendChild(b);
    g.addEventListener('pointerdown', e => e.stopPropagation());
    g.addEventListener('pointerenter', () => st.onCapHover(true));
    g.addEventListener('pointerleave', () => st.onCapHover(false));
    g.addEventListener('click', e => { e.stopPropagation(); openEd(); });
  }
  async function openEd() {
    const R = st._cap;
    if (state !== 'capsule' || busy || !r || !R || !window.ED) return;
    state = 'editor'; clearTimeout(capT);
    let res = null;
    try { res = await ED.open({ url: st.url, r, px: rpx(), T: R.T, mons: monsCss(), cfg: C(), dpr, thumb: R.gh }); }
    catch (e) { RS.log('editor ' + e); }
    if (state !== 'editor') return;
    state = 'capsule';
    capHov = !!((R.p && R.p.matches(':hover')) || R.gh.matches(':hover'));
    if (res && res.changed && st._cap === R) {
      st.capDone(res.copied ? 'copy' : 'save', true, res.copied ? 'Правки скопированы' : 'Правки сохранены');
      const sm = R.inner && R.inner.querySelector('.ct small'); if (sm) sm.textContent = `${res.w} × ${res.h}`;
    }
    armCap();
  }

  // ---------------- the round menu
  let radT = 0, radHov = false;
  const rpx = () => ({ x: P(r.x), y: P(r.y), w: Math.max(1, P(r.x + r.w) - P(r.x)), h: Math.max(1, P(r.y + r.h) - P(r.y)) });
  async function radial() {
    state = 'radial'; busy = true; radHov = false;
    st.cursor(0, 0, false);
    await st.radOpen();
    busy = false;
    const a = C().radAct;
    if (a && a !== 'none') await radDo(a); else armRad();
  }
  function armRad() {
    clearTimeout(radT);
    const s = +C().radSec || 0;
    if (s > 0 && !radHov && state === 'radial') radT = setTimeout(radEnd, s * 1000);
  }
  async function radDo(a) {
    if (busy || state !== 'radial' || !r) return;
    busy = true; clearTimeout(radT);
    st.radBusy(a);
    let ok = true, txt = '';
    try { await RS.invoke('shot_do', { r: rpx(), action: a, card: false }); }
    catch (e) { ok = false; txt = String(e || '').slice(0, 40); RS.log('shot_do ' + e); }
    st.radDone(a, ok, ok ? '' : txt || 'Не получилось');
    busy = false;
    armRad();
  }
  async function radEnd() {
    if (state !== 'radial') return;
    state = 'closing'; clearTimeout(radT);
    try { await Promise.race([st.radClose(), wait(900)]); } finally { close(); }
  }
  st.onRad = a => a === 'close' ? radEnd() : radDo(a);
  st.onRadHover = on => { radHov = on; if (on) clearTimeout(radT); else armRad(); };

  root.addEventListener('pointerdown', e => {
    if (state === 'off' || state === 'editor' || busy) return;
    if (e.button === 2 && state !== 'radial' && state !== 'capsule') { e.preventDefault(); return state === 'adjust' ? backToIdle() : close(); }
    if (state === 'radial') { e.preventDefault(); return radEnd(); }
    if (state === 'capsule') { e.preventDefault(); return capEnd('click beside'); }
    if (e.button !== 0) return;
    root.setPointerCapture(e.pointerId);
    const x = e.clientX, y = e.clientY;
    const h = st.handleAt(e.target);
    if (state === 'adjust' && h) { drag = { k: h, r0: { ...r }, x, y }; return; }
    if (state === 'adjust' && inR(x, y, r)) { drag = { k: 'move', r0: { ...r }, x, y }; document.body.classList.add('mv'); return; }
    state = 'drag'; st.bar(false); a0 = { x, y }; drag = { k: 'new', moved: false };
  });
  root.addEventListener('pointermove', e => {
    mx = e.clientX; my = e.clientY;
    if (state === 'off' || busy) return;
    if (state === 'idle') return idleMove();
    if (state === 'drag' && drag) {
      if (Math.abs(mx - a0.x) + Math.abs(my - a0.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      const x = Math.min(a0.x, mx), y = Math.min(a0.y, my);
      r = clip({ x, y, w: Math.abs(mx - a0.x), h: Math.abs(my - a0.y) });
      st.select(r, false);
      st.cursor(mx, my, true);
      return;
    }
    if (state === 'adjust' && drag) {
      const dx = mx - drag.x, dy = my - drag.y, o = drag.r0, k = drag.k;
      if (k === 'move') r = { x: Math.max(0, Math.min(innerWidth - o.w, o.x + dx)), y: Math.max(0, Math.min(innerHeight - o.h, o.y + dy)), w: o.w, h: o.h };
      else {
        let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
        if (k.includes('l')) x1 += dx; if (k.includes('r')) x2 += dx;
        if (k.includes('t')) y1 += dy; if (k.includes('b')) y2 += dy;
        r = clip({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
        st.cursor(mx, my, true);
      }
      st.select(r, true); st.bar(true);
    }
  });
  root.addEventListener('pointerup', () => {
    if (state === 'off' || busy) return;
    document.body.classList.remove('mv');
    if (state === 'drag' && drag) {
      const moved = drag.moved; drag = null;
      if (!moved || !r || r.w < 3 || r.h < 3) { r = clip(hov || under(mx, my)); }
      return adjust();
    }
    if (state === 'adjust' && drag) { drag = null; st.cursor(0, 0, false); }
  });
  root.addEventListener('dblclick', () => { if (state === 'adjust' && !busy) act_(C().instantAction || 'copy'); });
  addEventListener('contextmenu', e => e.preventDefault());

  addEventListener('keydown', e => {
    if (state === 'off' || state === 'editor') return;
    const k = e.key;
    // a hung close must never leave the dark screen behind
    if (state === 'closing') { if (k === 'Escape') close(); return; }
    if (busy && k !== 'Escape') return;
    if (state === 'capsule') {
      if (k === 'Escape' || k === 'Enter') { e.preventDefault(); return capEnd('key ' + k); }
      if (e.ctrlKey && (k === 'c' || k === 'с')) { e.preventDefault(); return capDo('copy'); }
      if (e.ctrlKey && (k === 's' || k === 'ы')) { e.preventDefault(); return capDo('save'); }
      if (k === 't' || k === 'T' || k === 'е' || k === 'Е') { e.preventDefault(); return capDo(e.shiftKey && st.ai ? 'ai' : 'ocr'); }
      return;
    }
    if (state === 'radial') {
      if (k === 'Escape' || k === 'Enter') { e.preventDefault(); return radEnd(); }
      if (e.ctrlKey && (k === 'c' || k === 'с')) { e.preventDefault(); return radDo('copy'); }
      if (e.ctrlKey && (k === 's' || k === 'ы')) { e.preventDefault(); return radDo('save'); }
      if (k === 't' || k === 'T' || k === 'е' || k === 'Е') { e.preventDefault(); return radDo(e.shiftKey && st.ai ? 'ai' : 'ocr'); }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); return state === 'adjust' && e.shiftKey ? backToIdle() : close(); }
    if (state === 'idle' && (k === ' ' || k === 'Enter')) { r = clip(hov || under(mx, my)); return adjust(); }
    if (state === 'idle' && k.toLowerCase() === 'a' && e.ctrlKey) { e.preventDefault(); r = { x: 0, y: 0, w: innerWidth, h: innerHeight }; return adjust(); }
    if (state === 'idle' && (k === 'l' || k === 'д') && D && D.last) { r = clip({ x: sc(D.last.x), y: sc(D.last.y), w: sc(D.last.w), h: sc(D.last.h) }); return adjust(); }
    if (state !== 'adjust') return;
    if (k === 'Enter' || (e.ctrlKey && (k === 'c' || k === 'с'))) { e.preventDefault(); return act_('copy'); }
    if (e.ctrlKey && (k === 's' || k === 'ы')) { e.preventDefault(); return act_('save'); }
    if (k === 't' || k === 'T' || k === 'е' || k === 'Е') { e.preventDefault(); return act_(e.shiftKey && st.ai ? 'ai' : 'ocr'); }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const s = (e.shiftKey ? 10 : 1) / dpr, q = { ...r };
      const ddx = k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, ddy = k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0;
      if (e.altKey) { q.w = Math.max(1, q.w + ddx); q.h = Math.max(1, q.h + ddy); } else { q.x += ddx; q.y += ddy; }
      r = clip(q); st.select(r, true); st.bar(true);
    }
  });

  st.onAct = a => a === 'close' ? close() : act_(a);

  function backToIdle() { state = 'idle'; r = null; st.select({ x: 0, y: 0, w: 0, h: 0 }, false); st.bar(false); idleMove(); }

  async function act_(action) {
    if (state === 'radial') return radDo(action);
    if (state === 'capsule') return capDo(action);
    if (busy || !r || r.w < 1 || r.h < 1) return;
    busy = true; document.body.classList.add('busy');
    const c = C();
    const R = { x: P(r.x), y: P(r.y), w: Math.max(1, P(r.x + r.w) - P(r.x)), h: Math.max(1, P(r.y + r.h) - P(r.y)) };
    const job = RS.invoke('shot_do', { r: R, action }).catch(e => RS.log('shot_do ' + e));
    // where the corner card appears (the main monitor)
    let tgt = null;
    const pm = (D.mons || []).find(m => m.p) || (D.mons || [])[0];
    if (pm) {
      const pos = c.cardPos || 'br', L = sc(pm.x), T = sc(pm.y), Wm = sc(pm.w), Hm = sc(pm.h);
      tgt = { x: pos.includes('l') ? L + 200 : L + Wm - 200, y: pos.includes('t') ? T + 160 : T + Hm - 200 };
    }
    await st.outro(c.cardOn ? c.post : (c.post === 'fly' ? 'shrink' : c.post), tgt);
    await job;
    close();
  }

  function close() {
    if (window.ED) ED.abort();
    state = 'off'; busy = false; clearTimeout(radT); clearTimeout(capT);
    RS.invoke('ovl_hide').catch(() => {});
    setTimeout(() => { st.reset(); root.classList.remove('ready'); }, 30);
  }
})();
