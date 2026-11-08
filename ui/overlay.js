'use strict';
// The full-screen overlay. The program sends the frozen screen, this page lets you choose a part of it.
(() => {
  const root = document.getElementById('root');
  const st = FX.make(root);
  let D = null, dpr = 1, state = 'off', busy = false;
  let a0 = null, r = null, drag = null, hov = null, mx = 0, my = 0;
  const P = v => Math.round(v * dpr);

  RS.listen('shot', e => start(e.payload).catch(err => { RS.log('ovl start ' + err); RS.invoke('ovl_ready', { n: e.payload.n }).catch(() => {}); }));
  RS.listen('force', () => { root.classList.add('ready'); });
  RS.listen('test_sel', e => {
    const [x, y, w, h, act] = String(e.payload || '').split(',');
    r = { x: +x / dpr, y: +y / dpr, w: +w / dpr, h: +h / dpr };
    adjust();
    if (act) setTimeout(() => act_(act.trim()), 700);
  });

  async function start(d) {
    D = d; busy = false;
    const c = { ...RS.DEF, ...(d.cfg || {}) };
    dpr = window.devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    st.ai = !!(c.groqKey || '').trim();
    st.reset();
    root.classList.remove('ready');
    await st.frame('http://snap.localhost/frame?n=' + d.n, W, H, dpr);
    st.cfg(c);
    a0 = null; r = null; drag = null; hov = null; state = 'idle';
    document.body.className = '';
    mx = (d.cur ? d.cur[0] : W * dpr / 2) / dpr; my = (d.cur ? d.cur[1] : H * dpr / 2) / dpr;
    root.classList.add('ready');
    st.intro(mx, my);
    if (d.mode === 'text') st.hint(`${RS.ic('text-t')} Выдели текст — он сразу окажется в буфере <kbd>Esc</kbd>`);
    idleMove();
    await RS.invoke('ovl_ready', { n: d.n });
    window.focus();
  }

  const C = () => st.c;
  const sc = v => v / dpr;
  const inR = (x, y, q) => q && x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h;
  function under(x, y) {
    if (!D) return null;
    const px = x * dpr, py = y * dpr;
    if (C().snapWin) for (const w of D.wins || []) if (inR(px, py, w)) return { x: sc(w.x), y: sc(w.y), w: sc(w.w), h: sc(w.h) };
    for (const m of D.mons || []) if (inR(px, py, m)) return { x: sc(m.x), y: sc(m.y), w: sc(m.w), h: sc(m.h) };
    return { x: 0, y: 0, w: innerWidth, h: innerHeight };
  }
  function clip(q) {
    const W = innerWidth, H = innerHeight;
    let x = Math.max(0, q.x), y = Math.max(0, q.y);
    return { x, y, w: Math.max(0, Math.min(W, q.x + q.w) - x), h: Math.max(0, Math.min(H, q.y + q.h) - y) };
  }
  function idleMove() {
    hov = under(mx, my);
    st.hover(C().snapWin ? hov : null);
    st.cursor(mx, my, true);
  }
  function adjust() {
    state = 'adjust';
    st.hint('');
    st.select(r, true);
    st.cursor(0, 0, false);
    if (D && D.mode === 'text') return act_('ocr');
    if (C().toolbar === 'instant') return act_(C().instantAction || 'copy');
    st.bar(true);
  }

  root.addEventListener('pointerdown', e => {
    if (state === 'off' || busy) return;
    if (e.button === 2) { e.preventDefault(); return state === 'adjust' ? backToIdle() : close(); }
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
    if (state === 'off' || busy) return;
    const k = e.key;
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
    state = 'off'; busy = false;
    RS.invoke('ovl_hide').catch(() => {});
    setTimeout(() => { st.reset(); root.classList.remove('ready'); }, 30);
  }
})();
