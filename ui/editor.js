'use strict';
// Retocker Snap: the picture editor. A click on the capsule thumbnail and the shot flows out of it into the middle of the screen.
// Two canvases: the picture (blur is baked into it) and the drawings on top. Every change is a step in a list, so undo is exact.
// Nothing inside ever grows piece by piece: every panel gets its final size first and then only fades in as a whole.
(() => {
  const $e = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; if (p) p.appendChild(e); return e; };
  const L = (a, b, t) => a + (b - a) * t;
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const OPT_H = 48, BAR_H = 52, GAP = 14, RAD = 14, THUMB_R = 12;
  const TOOLS = [
    { id: 'brush', i: 'paint-brush', t: 'Кисть', k: 'B' },
    { id: 'marker', i: 'highlighter-circle', t: 'Маркер', k: 'M' },
    { id: 'rect', i: 'square', t: 'Прямоугольник', k: 'R' },
    { id: 'ellipse', i: 'circle', t: 'Овал', k: 'O' },
    { id: 'line', i: 'line-segment', t: 'Линия', k: 'L' },
    { id: 'arrow', i: 'arrow-up-right', t: 'Стрелка', k: 'A' },
    { id: 'text', i: 'text-aa', t: 'Текст', k: 'T' },
    { id: 'blur', i: 'drop-half', t: 'Размытие', k: 'U' },
    { id: 'crop', i: 'crop', t: 'Обрезка', k: 'C' },
    { id: 'eraser', i: 'eraser', t: 'Ластик', k: 'E' },
  ];
  const B_UNDO = { i: 'arrow-counter-clockwise', t: 'Отменить', k: 'Ctrl Z' };
  const B_REDO = { i: 'arrow-clockwise', t: 'Повторить', k: 'Ctrl Y' };
  const B_COPY = { i: 'copy', t: 'Копировать', k: 'Ctrl C' };
  const B_SAVE = { i: 'floppy-disk', t: 'Сохранить', k: 'Ctrl S' };
  const B_DONE = { i: 'check', t: 'Готово' };
  const B_FULL = { i: 'corners-out', t: 'Весь снимок' };
  const B_CROP = { i: 'check', t: 'Обрезать' };
  const B_PEN = { i: 'pencil-simple' };
  const COLORS = ['#ff5a4e', '#ffa63d', '#ffe14d', '#5fcf98', '#4da3ff', '#a77bff', '#ffffff', '#191919'];
  const RING = { brush: 1, marker: 1, eraser: 1, blur: 1 };
  const DRAW = new Set(TOOLS.map(t => t.id).filter(t => t !== 'crop'));
  const FONTS = ['700 12.5px Manrope', '700 11.5px Manrope', '650 12px Manrope', '700 40px Manrope'];
  const fonts = () => document.fonts ? Promise.race([Promise.all(FONTS.map(f => document.fonts.load(f).catch(() => {}))), new Promise(r => setTimeout(r, 600))]) : Promise.resolve();
  fonts();
  const SP_OPEN = RS.spring(520, 14), SP_CLOSE = RS.spring(430, 4), SP_UI = RS.spring(320, 0), SP_HL = RS.spring(300, 12), SP_LAY = RS.spring(460, 8);
  const TFONT = s => `700 ${s}px Manrope, system-ui, sans-serif`;

  let E = null;      // the open editor
  let last = null;   // the last edited picture as PNG (base64), for the capsule buttons after the editor is closed
  const ED = window.ED = {};
  ED.isOpen = () => !!E;
  ED.edited = () => last;
  ED.reset = () => { last = null; };
  ED.put = a => last ? RS.invoke('ed_put', { png: last.png, action: a, hist: false }) : Promise.reject('нет правок');
  ED.abort = () => { if (!E) return; const d = E.done; kill(); d(null); };
  ED.open = o => new Promise(done => {
    if (E) return done(null);
    build(o, done).catch(err => { RS.log('editor failed: ' + (err && err.message || err)); if (E) { kill(); } done(null); });
  });

  // ---------------- helpers for looks
  function fadeIn(el) {
    el.style.visibility = 'visible';
    return RS.anim(el, { opacity: [0, 1], y: [8, 0] }, SP_UI);
  }
  function fadeOut(el) {
    return RS.anim(el, { opacity: 0, y: 6 }, { duration: .14, ease: [.4, 0, 1, 1] });
  }
  function hover(el, on, off) {
    on = on || 'rgba(255,255,255,.08)'; off = off || 'rgba(255,255,255,0)';
    el.style.backgroundColor = off;
    el.addEventListener('pointerenter', () => RS.anim(el, { backgroundColor: on }, { duration: .14 }));
    el.addEventListener('pointerleave', () => RS.anim(el, { backgroundColor: off }, { duration: .22 }));
  }
  function tip(el, b) {
    let t = 0;
    el.addEventListener('pointerenter', () => { clearTimeout(t); t = setTimeout(() => showTip(el, b), 420); });
    el.addEventListener('pointerleave', () => { clearTimeout(t); hideTip(el); });
    el.addEventListener('pointerdown', () => { clearTimeout(t); hideTip(el); });
  }
  function showTip(el, b) {
    if (!E || !E.ui || E.drag) return;
    const tp = E.tip;
    tp.innerHTML = RS.esc(b.t) + (b.k ? `<kbd>${RS.esc(b.k)}</kbd>` : '');
    tp.style.visibility = 'hidden';
    const r = el.getBoundingClientRect(), w = tp.offsetWidth, up = !!el.closest('.edbar');
    tp.style.left = cl(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6) + 'px';
    tp.style.top = (up ? r.top - 28 - 12 : r.bottom + 12) + 'px';
    tp.style.visibility = 'visible'; E.tipFor = el;
    RS.anim(tp, { opacity: [0, 1], y: [up ? 4 : -4, 0] }, { duration: .16 });
  }
  function hideTip(el) {
    if (!E || (el && E.tipFor !== el)) return;
    E.tipFor = null;
    RS.anim(E.tip, { opacity: 0 }, { duration: .1 });
  }
  function toast(msg, ok) {
    if (!E) return;
    const t = E.toast;
    t.innerHTML = `<i class="${ok ? '' : 'bad'}"></i>${RS.esc(msg)}`;
    t.style.visibility = 'hidden';
    const w = t.offsetWidth;
    t.style.left = (E.lay.x + E.lay.w / 2 - w / 2) + 'px'; t.style.top = (E.lay.y + 14) + 'px';
    t.style.visibility = 'visible';
    RS.anim(t, { opacity: [0, 1], y: [-6, 0] }, SP_UI);
    clearTimeout(E.toastT);
    E.toastT = setTimeout(() => E && RS.anim(t, { opacity: 0, y: -4 }, { duration: .2 }), ok ? 1300 : 2600);
  }
  function icBtn(p, b, fn) {
    const el = $e('div', 'eb', p); el.innerHTML = RS.ic(b.i);
    hover(el); tip(el, b);
    el.addEventListener('click', e => { e.stopPropagation(); if (E && E.ui) fn(); });
    return el;
  }
  function txBtn(p, b, fn, pr) {
    const el = $e('div', 'et' + (pr ? ' pr' : ''), p);
    el.innerHTML = RS.ic(b.i) + `<span>${RS.esc(b.t)}</span>`;
    if (pr) hover(el, '#ffffff', '#ebebea'); else hover(el, 'rgba(255,255,255,.1)', 'rgba(255,255,255,.05)');
    el.addEventListener('click', e => { e.stopPropagation(); if (E && E.ui) fn(); });
    return el;
  }

  // ---------------- geometry
  function monitor(o) {
    const cx = o.r.x + o.r.w / 2, cy = o.r.y + o.r.h / 2, ms = o.mons || [];
    return ms.find(m => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) || ms[0] || { x: 0, y: 0, w: innerWidth, h: innerHeight };
  }
  // the picture takes about 70% of the screen, the panels sit above and below it
  function layout(V) {
    const m = E.m, maxW = Math.max(160, m.w * .7), maxH = Math.max(120, m.h * .74 - OPT_H - BAR_H - GAP * 2);
    const k = Math.min(maxW / V.w, maxH / V.h, 2 / (E.o.dpr || 1));
    const w = V.w * k, h = V.h * k;
    const top = m.y + (m.h - (OPT_H + GAP + h + GAP + BAR_H)) / 2;
    return { k, x: m.x + (m.w - w) / 2, y: top + OPT_H + GAP, w, h, oy: top, by: top + OPT_H + GAP + h + GAP, cx: m.x + m.w / 2 };
  }
  function place(V, l) {
    const v = E.view.style, w = E.wrap.style;
    v.left = l.x + 'px'; v.top = l.y + 'px'; v.width = l.w + 'px'; v.height = l.h + 'px';
    w.left = -V.x * l.k + 'px'; w.top = -V.y * l.k + 'px'; w.width = E.iw * l.k + 'px'; w.height = E.ih * l.k + 'px';
    E.opt.style.left = (l.cx - E.optW / 2) + 'px'; E.opt.style.top = l.oy + 'px';
    E.bar.style.left = (l.cx - E.barW / 2) + 'px'; E.bar.style.top = l.by + 'px';
  }
  // the picture covers a moving box (the same way the capsule thumbnail does)
  function cover(el, bw, bh, A) {
    const s = Math.max(bw / A.w, bh / A.h);
    el.style.transform = `translate(${(bw - A.w * s) / 2 - A.x * s}px,${(bh - A.h * s) / 2 - A.y * s}px) scale(${s})`;
  }
  function morph(gh, A, B, ra, rb, sp, fit) {
    const set = p => {
      const x = L(A.x, B.x, p), y = L(A.y, B.y, p), w = Math.max(1, L(A.w, B.w, p)), h = Math.max(1, L(A.h, B.h, p));
      gh.style.left = x + 'px'; gh.style.top = y + 'px'; gh.style.width = w + 'px'; gh.style.height = h + 'px';
      gh.style.borderRadius = Math.max(0, L(ra, rb, cl(p, 0, 1))) + 'px';
      fit(w, h);
    };
    set(0);
    return RS.drive(sp, set);
  }
  const toImg = e => {
    const b = E.view.getBoundingClientRect();
    return [E.V.x + (e.clientX - b.left) / E.lay.k, E.V.y + (e.clientY - b.top) / E.lay.k];
  };
  const viewOf = () => { let V = { x: 0, y: 0, w: E.iw, h: E.ih }; for (const op of E.ops) if (op.t === 'crop') V = { ...op.r }; return V; };
  const same = (a, b) => Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5 && Math.abs(a.w - b.w) < .5 && Math.abs(a.h - b.h) < .5;
  // tool width on screen, px
  const width = t => t === 'marker' ? E.sz * 2.6 : t === 'eraser' ? E.sz * 2.2 : t === 'blur' ? E.sz * 3 : E.sz;

  // ---------------- building
  async function build(o, done) {
    const c = o.cfg || {};
    E = {
      o, done, ops: [], redo: [], ver: 0, copied: 0, saved: false, histVer: 0, busy: false, closing: false, ui: false,
      drag: null, tx: null, hideText: -1, mvLive: null, raf: 0,
      tool: DRAW.has(c.edTool) ? c.edTool : 'brush', prevTool: 'brush',
      color: /^#[0-9a-f]{6}$/i.test(c.edColor || '') ? c.edColor : COLORS[0],
      sz: cl(+c.edSize || 6, 2, 40), fs: cl(+c.edText || 28, 12, 96),
      iw: Math.max(1, Math.round(o.px.w)), ih: Math.max(1, Math.round(o.px.h)),
    };
    E.m = monitor(o);
    E.V = { x: 0, y: 0, w: E.iw, h: E.ih };
    const root = E.root = $e('div', 'ed', document.body);
    root.addEventListener('pointerdown', e => { e.stopPropagation(); if (E && E.tx && !e.target.closest('.edtx')) commitText(); });
    root.addEventListener('contextmenu', e => e.preventDefault());
    root.addEventListener('pointermove', ringMove);
    const bg = E.bg = $e('div', 'edbg', root);
    const bi = $e('img', '', bg); bi.src = o.url; bi.style.width = innerWidth + 'px'; bi.style.height = innerHeight + 'px';
    $e('i', '', bg);
    const v = E.view = $e('div', 'edv', root);
    E.wrap = $e('div', 'edw', v);
    const mk = () => { const x = $e('canvas', '', E.wrap); x.width = E.iw; x.height = E.ih; return x; };
    E.base = mk(); E.ann = mk(); E.live = mk();
    E.crop = $e('div', 'edcrop', v);
    for (const h of ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l']) $e('i', 'ech ech-' + h, E.crop).dataset.h = h;
    $e('b', 'edgrid', E.crop);
    E.cur = $e('div', 'edcur', root);
    buildOpt(root); buildBar(root);
    E.tip = $e('div', 'edtip', root); E.toast = $e('div', 'edtoast', root);
    v.addEventListener('pointerdown', down);
    v.addEventListener('pointermove', move);
    v.addEventListener('pointerup', up);
    v.addEventListener('lostpointercapture', up);
    v.addEventListener('pointerenter', () => { E.inView = true; ringShow(); });
    v.addEventListener('pointerleave', () => { E.inView = false; ringShow(); });
    // the ghost the shot flows in
    const gh = $e('div', 'edgh', root), gi = $e('img', '', gh);
    gi.src = o.url; gi.style.width = innerWidth + 'px'; gi.style.height = innerHeight + 'px';
    gh.style.visibility = 'hidden';
    const load = loadPic(o);
    load.catch(() => {});
    await fonts();
    if (!E) return;
    measure();
    E.lay = layout(E.V);
    place(E.V, E.lay);
    setTool(E.tool, true); setColor(E.color, false, true); setSize(E.tool === 'text' ? E.fs : E.sz, true);
    updUndo(true);
    RS.log(`editor open ${E.iw}x${E.ih}, view ${Math.round(E.lay.x)},${Math.round(E.lay.y)},${Math.round(E.lay.w)},${Math.round(E.lay.h)}`);
    if (o.thumb) o.thumb.style.visibility = 'hidden';
    gh.style.visibility = '';
    RS.anim(bg, { opacity: 1 }, { duration: .3, ease: [.3, 0, .2, 1] });
    await morph(gh, o.T, E.lay, THUMB_R, RAD, SP_OPEN, (w, h) => cover(gi, w, h, o.r));
    await load;
    if (!E) return;
    render();
    // the canvas shows the very same pixels: the swap is invisible
    v.classList.add('on'); gh.remove();
    E.ui = true;
    fadeIn(E.opt);
    setTimeout(() => E && fadeIn(E.bar), 45);
    ringShow();
  }
  async function loadPic(o) {
    const sx = Math.round(o.px.x), sy = Math.round(o.px.y);
    let bmp = null;
    try {
      const res = await fetch(o.url);
      if (!res.ok) throw new Error('frame ' + res.status);
      bmp = await createImageBitmap(await res.blob(), sx, sy, E.iw, E.ih);
    } catch (e) {
      RS.log('editor fetch: ' + (e && e.message || e) + ', trying the image');
      const im = new Image(); im.crossOrigin = 'anonymous'; im.src = o.url;
      await im.decode();
      bmp = await createImageBitmap(im, sx, sy, E.iw, E.ih);
    }
    if (!E) { if (bmp.close) bmp.close(); return; }
    E.src = bmp;
  }
  function measure() {
    const aw = Math.ceil(E.oa.getBoundingClientRect().width), bw = Math.ceil(E.ob.getBoundingClientRect().width);
    E.optW = Math.max(aw, bw);
    E.opt.style.width = E.optW + 'px';
    E.oa.style.left = (E.optW - aw) / 2 + 'px'; E.ob.style.left = (E.optW - bw) / 2 + 'px';
    E.barW = Math.ceil(E.bar.getBoundingClientRect().width);
    E.bar.style.width = E.barW + 'px';
  }
  function buildBar(root) {
    const bar = E.bar = $e('div', 'edpill edbar', root);
    const tg = $e('div', 'edtg', bar);
    E.hl = $e('i', 'edhl', tg);
    E.tb = {};
    for (const t of TOOLS) {
      const b = $e('div', 'eb', tg); b.innerHTML = RS.ic(t.i);
      hover(b); tip(b, t);
      b.addEventListener('click', e => { e.stopPropagation(); if (E && E.ui && !E.anim) setTool(t.id); });
      E.tb[t.id] = b;
    }
    $e('i', 'edsep', bar);
    E.bu = icBtn(bar, B_UNDO, undo);
    E.br = icBtn(bar, B_REDO, redo);
    $e('i', 'edsep', bar);
    icBtn(bar, B_COPY, () => put('copy'));
    icBtn(bar, B_SAVE, () => put('save'));
    txBtn(bar, B_DONE, () => close('done'), true);
  }
  function buildOpt(root) {
    const opt = E.opt = $e('div', 'edpill edopt', root);
    const A = E.oa = $e('div', 'edoa', opt), B = E.ob = $e('div', 'edob', opt);
    const cg = E.cg = $e('div', 'edcg', A);
    E.ring = $e('i', 'edring', cg);
    E.cd = COLORS.map(col => {
      const d = $e('div', 'edcd', cg); $e('i', '', d).style.background = col;
      hover(d);
      d.addEventListener('click', e => { e.stopPropagation(); setColor(col); });
      return d;
    });
    const cu = E.cu = $e('div', 'edcd edcu', cg); $e('i', '', cu);
    hover(cu); tip(cu, { t: 'Свой цвет' });
    const inp = $e('input', '', cu); inp.type = 'color'; inp.tabIndex = -1;
    cu.addEventListener('click', e => { e.stopPropagation(); if (e.target === inp) return; inp.value = E.color; inp.click(); });
    inp.addEventListener('input', () => setColor(inp.value, true));
    inp.addEventListener('change', () => setColor(inp.value));
    $e('i', 'edsep', A);
    const sz = $e('div', 'edsz', A);
    E.szp = $e('div', 'edszp', sz); E.szd = $e('i', '', E.szp);
    const rg = E.rg = $e('input', 'edrg', sz); rg.type = 'range'; rg.tabIndex = -1; rg.min = 2; rg.max = 40; rg.step = 1;
    E.szv = $e('span', 'edszv', sz);
    rg.addEventListener('input', () => setSize(+rg.value));
    rg.addEventListener('change', () => { saveSize(); rg.blur(); });
    $e('span', 'edcl', B).textContent = 'Потяни рамку или её углы';
    txBtn(B, B_FULL, cropFull);
    txBtn(B, B_CROP, cropApply, true);
  }

  // ---------------- tools, colors, sizes
  function setTool(id, instant) {
    if (!E) return;
    if (E.tx) commitText();
    const was = E.tool;
    if (id === 'crop' && was !== 'crop') E.prevTool = was;
    E.tool = id;
    for (const k in E.tb) {
      const on = k === id;
      if (instant) E.tb[k].style.color = on ? '#fff' : 'rgba(255,255,255,.62)';
      else RS.anim(E.tb[k], { color: on ? '#ffffff' : 'rgba(255,255,255,.62)' }, { duration: .16 });
    }
    const left = E.tb[id].offsetLeft + 'px';
    if (instant) E.hl.style.left = left; else RS.anim(E.hl, { left }, SP_HL);
    E.view.dataset.tool = id;
    const tx = id === 'text';
    E.rg.min = tx ? 12 : 2; E.rg.max = tx ? 96 : 40;
    setSize(tx ? E.fs : E.sz, true);
    const colorsOn = id !== 'eraser' && id !== 'blur';
    if (instant) E.cg.style.opacity = colorsOn ? 1 : .3; else RS.anim(E.cg, { opacity: colorsOn ? 1 : .3 }, { duration: .18 });
    E.cg.style.pointerEvents = colorsOn ? '' : 'none';
    if (id === 'crop') cropOn(instant); else cropOff(instant);
    ringShow();
    if (!instant && DRAW.has(id)) { E.o.cfg && (E.o.cfg.edTool = id); RS.set({ edTool: id }); }
  }
  function setColor(col, live, instant) {
    if (!E) return;
    E.color = col;
    if (E.tx) { E.tx.c = col; E.tx.el.style.color = col; }
    const i = COLORS.findIndex(c => c.toLowerCase() === col.toLowerCase());
    const d = i >= 0 ? E.cd[i] : E.cu;
    E.cu.firstChild.style.background = i >= 0 ? '' : col;
    const left = d.offsetLeft + 'px';
    if (instant) E.ring.style.left = left; else RS.anim(E.ring, { left }, SP_HL);
    E.szd.style.background = col;
    if (!instant && !live) { E.o.cfg && (E.o.cfg.edColor = col); RS.set({ edColor: col }); }
  }
  function setSize(v, instant) {
    if (!E) return;
    const tx = E.tool === 'text';
    v = tx ? cl(v, 12, 96) : cl(v, 2, 40);
    if (tx) E.fs = v; else E.sz = v;
    E.rg.value = v;
    const pct = (v - +E.rg.min) / (+E.rg.max - +E.rg.min) * 100;
    E.rg.style.background = `linear-gradient(90deg,#fff ${pct}%,rgba(255,255,255,.16) ${pct}%)`;
    E.szv.textContent = v;
    const dot = tx ? cl(v * .3, 4, 22) : cl(width(E.tool), 3, 22);
    E.szd.style.width = E.szd.style.height = dot + 'px';
    if (E.tx) { E.tx.s = v / E.lay.k; E.tx.el.style.fontSize = v + 'px'; }
    ringShow();
  }
  function saveSize() {
    if (!E) return;
    const p = E.tool === 'text' ? { edText: E.fs } : { edSize: E.sz };
    if (E.o.cfg) Object.assign(E.o.cfg, p);
    RS.set(p);
  }
  // the round cursor shows the real brush size
  function ringShow() {
    if (!E) return;
    const on = E.ui && !E.anim && E.inView && RING[E.tool];
    E.cur.style.display = on ? 'block' : 'none';
    if (on) { const s = Math.max(4, width(E.tool)); E.cur.style.width = E.cur.style.height = s + 'px'; E.ringS = s; ringPos(); }
  }
  function ringMove(e) { if (!E) return; E.mx = e.clientX; E.my = e.clientY; if (E.cur.style.display === 'block') ringPos(); }
  function ringPos() { const s = E.ringS || 4; E.cur.style.left = (E.mx - s / 2) + 'px'; E.cur.style.top = (E.my - s / 2) + 'px'; }

  // ---------------- drawing
  function textState() {
    const s = {};
    E.ops.forEach((op, i) => {
      if (op.t === 'text') s[i] = { dx: 0, dy: 0, txt: null };
      else if (op.t === 'mv' && s[op.i]) { s[op.i].dx += op.dx; s[op.i].dy += op.dy; }
      else if (op.t === 'tx' && s[op.i]) s[op.i].txt = op.txt;
    });
    const m = E.mvLive;
    if (m && s[m.i]) { s[m.i].dx += m.dx; s[m.i].dy += m.dy; }
    return s;
  }
  function pathOf(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { c.lineTo(pts[0][0] + .01, pts[0][1]); return; }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const z = pts[pts.length - 1];
    c.lineTo(z[0], z[1]);
  }
  function shape(c, op) {
    const [x1, y1] = op.a, [x2, y2] = op.b;
    c.save();
    c.strokeStyle = c.fillStyle = op.c; c.lineWidth = op.w; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    if (op.tool === 'rect') {
      const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      const r = Math.min(op.w * 1.2, w / 2, h / 2);
      if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
      c.stroke();
    } else if (op.tool === 'ellipse') {
      c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(.5, Math.abs(x2 - x1) / 2), Math.max(.5, Math.abs(y2 - y1) / 2), 0, 0, Math.PI * 2);
      c.stroke();
    } else if (op.tool === 'line') {
      c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    } else {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) { c.restore(); return; }
      const an = Math.atan2(y2 - y1, x2 - x1), hl = Math.min(len * .6, Math.max(12, op.w * 3.6)), hw = .48;
      const sx = x2 - Math.cos(an) * hl * .7, sy = y2 - Math.sin(an) * hl * .7;
      c.moveTo(x1, y1); c.lineTo(sx, sy); c.stroke();
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 - hl * Math.cos(an - hw), y2 - hl * Math.sin(an - hw));
      c.lineTo(x2 - hl * Math.cos(an + hw), y2 - hl * Math.sin(an + hw));
      c.closePath();
      c.lineWidth = Math.max(1, op.w * .6);
      c.fill(); c.stroke();
    }
    c.restore();
  }
  // text sits exactly where the input field showed it (same font, same line height)
  function text(c, op, s, i) {
    const txt = s && s.txt != null ? s.txt : op.txt;
    const x = op.x + (s ? s.dx : 0), y = op.y + (s ? s.dy : 0);
    if (!txt) { op._box = null; return; }
    const lines = txt.split('\n'), lh = op.s * 1.22;
    c.save();
    c.font = TFONT(op.s); c.textBaseline = 'alphabetic';
    const m = c.measureText('Hg'), A = m.fontBoundingBoxAscent || op.s * .9, D = m.fontBoundingBoxDescent || op.s * .25;
    const off = (lh - (A + D)) / 2 + A;
    let w = 0;
    for (const l of lines) w = Math.max(w, c.measureText(l).width);
    op._box = { x, y, w, h: lines.length * lh };
    if (i === E.hideText) { c.restore(); return; }
    c.fillStyle = op.c; c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = op.s * .12; c.shadowOffsetY = op.s * .03;
    lines.forEach((l, j) => c.fillText(l, x, y + j * lh + off));
    c.restore();
  }
  function drawOp(c, op, i, st) {
    if (op.t === 'path') {
      if (op.tool === 'blur') return;
      c.save();
      if (op.tool === 'eraser') c.globalCompositeOperation = 'destination-out';
      if (op.tool === 'marker') c.globalAlpha = .38;
      c.strokeStyle = op.tool === 'eraser' ? '#000' : op.c; c.lineWidth = op.w; c.lineCap = 'round'; c.lineJoin = 'round';
      pathOf(c, op.pts); c.stroke();
      c.restore();
    } else if (op.t === 'shape') shape(c, op);
    else if (op.t === 'text') text(c, op, st && st[i], i);
  }
  // blur: the picture under the stroke is shrunk, grown back and softened, then kept only under the stroke
  function blurInto(src, op, out) {
    const pad0 = op.w / 2 + 2;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of op.pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    const f = cl(op.w / 3, 5, 26), pad = pad0 + f * 3;
    const S = { x: Math.max(0, Math.floor(x1 - pad)), y: Math.max(0, Math.floor(y1 - pad)) };
    S.w = Math.min(E.iw, Math.ceil(x2 + pad)) - S.x; S.h = Math.min(E.ih, Math.ceil(y2 + pad)) - S.y;
    if (S.w < 1 || S.h < 1) return;
    const sw = Math.max(1, Math.round(S.w / f)), sh = Math.max(1, Math.round(S.h / f));
    const sm = E.cvS || (E.cvS = document.createElement('canvas')); sm.width = sw; sm.height = sh;
    const s = sm.getContext('2d'); s.imageSmoothingQuality = 'high';
    s.drawImage(src, S.x, S.y, S.w, S.h, 0, 0, sw, sh);
    const tm = E.cvT || (E.cvT = document.createElement('canvas')); tm.width = S.w; tm.height = S.h;
    const t = tm.getContext('2d');
    t.filter = `blur(${(f * .5).toFixed(1)}px)`; t.imageSmoothingEnabled = true; t.imageSmoothingQuality = 'high';
    t.drawImage(sm, 0, 0, sw, sh, -f * .5, -f * .5, S.w + f, S.h + f);
    t.filter = 'none';
    const mk = E.cvM || (E.cvM = document.createElement('canvas')); mk.width = S.w; mk.height = S.h;
    const m = mk.getContext('2d');
    m.translate(-S.x, -S.y); m.strokeStyle = '#000'; m.lineWidth = op.w; m.lineCap = 'round'; m.lineJoin = 'round';
    pathOf(m, op.pts); m.stroke();
    t.globalCompositeOperation = 'destination-in'; t.drawImage(mk, 0, 0); t.globalCompositeOperation = 'source-over';
    out.drawImage(tm, S.x, S.y);
  }
  function renderBase() {
    const b = E.base.getContext('2d');
    b.clearRect(0, 0, E.iw, E.ih);
    b.drawImage(E.src, 0, 0);
    for (const op of E.ops) if (op.t === 'path' && op.tool === 'blur') blurInto(E.base, op, b);
  }
  function renderAnn(extra) {
    const a = E.ann.getContext('2d'), st = textState();
    a.clearRect(0, 0, E.iw, E.ih);
    E.ops.forEach((op, i) => drawOp(a, op, i, st));
    if (extra) drawOp(a, extra, -1, st);
  }
  function render() { if (!E || !E.src) return; renderBase(); renderAnn(); }
  function clearLive() { E.live.getContext('2d').clearRect(0, 0, E.iw, E.ih); }
  function liveFrame() { if (E.raf) return; E.raf = requestAnimationFrame(() => { if (!E) return; E.raf = 0; drawLive(); }); }
  function drawLive() {
    const d = E.drag; clearLive();
    if (!d) return;
    const c = E.live.getContext('2d');
    if (d.k === 'path') {
      if (d.op.tool === 'eraser') return renderAnn(d.op);
      if (d.op.tool === 'blur') return blurInto(E.base, d.op, c);
      drawOp(c, d.op);
    } else if (d.k === 'shape') { if (d.moved) drawOp(c, d.op); }
    else if (d.k === 'mvtext') renderAnn();
  }

  // ---------------- steps & undo
  function push(op) {
    E.ops.push(op); E.redo.length = 0;
    E.ver++; updUndo();
  }
  function updUndo(instant) {
    const set = (el, on) => {
      el.style.pointerEvents = on ? '' : 'none';
      if (instant) el.style.opacity = on ? 1 : .32; else RS.anim(el, { opacity: on ? 1 : .32 }, { duration: .16 });
    };
    set(E.bu, E.ops.length > 0); set(E.br, E.redo.length > 0);
  }
  function history(fn) {
    if (!E || !E.ui || E.anim || E.busy) return;
    if (E.tx) commitText();
    if (!fn()) return;
    E.ver++; updUndo();
    const V0 = E.V; E.V = viewOf();
    render();
    if (!same(V0, E.V)) relayout(V0);
  }
  const undo = () => history(() => { if (!E.ops.length) return false; E.redo.push(E.ops.pop()); return true; });
  const redo = () => history(() => { if (!E.redo.length) return false; E.ops.push(E.redo.pop()); return true; });
  // the picture area changes its size smoothly when the crop changes
  function relayout(V0) {
    const a = E.lay, V1 = E.V, b = layout(V1);
    E.lay = b; E.anim = true; ringShow();
    E.crop.style.display = 'none';
    return RS.drive(SP_LAY, p => {
      if (!E) return;
      const k = L(a.k, b.k, p);
      const V = { x: L(V0.x, V1.x, p), y: L(V0.y, V1.y, p), w: Math.max(1, L(V0.w, V1.w, p)), h: Math.max(1, L(V0.h, V1.h, p)) };
      const cx = L(a.x + a.w / 2, b.x + b.w / 2, p), cy = L(a.y + a.h / 2, b.y + b.h / 2, p), w = V.w * k, h = V.h * k;
      place(V, { k, x: cx - w / 2, y: cy - h / 2, w, h, oy: L(a.oy, b.oy, p), by: L(a.by, b.by, p), cx: b.cx });
    }).then(() => {
      if (!E) return;
      place(E.V, E.lay); E.anim = false;
      if (E.tool === 'crop') { E.cr = { ...E.V }; placeCrop(); E.crop.style.display = 'block'; }
      ringShow();
      // Esc / Enter pressed while the picture was still resizing: close right after it settles
      if (E.pend) { const w = E.pend; E.pend = null; close(w); }
    });
  }

  // ---------------- pointer
  function down(e) {
    if (!E || !E.ui || E.anim || E.busy || e.button !== 0) return;
    if (E.tx) { commitText(); if (E.tool === 'text') return; }
    const p = toImg(e), t = E.tool;
    try { E.view.setPointerCapture(e.pointerId); } catch (err) {}
    if (t === 'crop') return cropDown(e, p);
    if (t === 'text') {
      const i = hitText(p);
      E.drag = i >= 0 ? { k: 'mvtext', i, p0: p, moved: false } : { k: 'newtext', p0: p };
      return;
    }
    const w = width(t) / E.lay.k;
    if (RING[t]) {
      E.drag = { k: 'path', op: { t: 'path', tool: t, pts: [p], w, c: E.color } };
      liveFrame();
      return;
    }
    E.drag = { k: 'shape', op: { t: 'shape', tool: t, a: p, b: p, w, c: E.color }, moved: false, e0: [e.clientX, e.clientY] };
  }
  function move(e) {
    if (!E) return;
    const d = E.drag;
    if (!d) {
      if (E.tool === 'text' && E.ui) E.view.classList.toggle('ontx', hitText(toImg(e)) >= 0);
      return;
    }
    if (d.k === 'path') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const q of (evs.length ? evs : [e])) {
        const p = toImg(q), z = d.op.pts[d.op.pts.length - 1];
        if (Math.hypot(p[0] - z[0], p[1] - z[1]) * E.lay.k >= 1.2) d.op.pts.push(p);
      }
      return liveFrame();
    }
    const p = toImg(e);
    if (d.k === 'shape') {
      if (!d.moved && Math.hypot(e.clientX - d.e0[0], e.clientY - d.e0[1]) < 3) return;
      d.moved = true;
      d.op.b = p; if (e.shiftKey) constrain(d.op);
      return liveFrame();
    }
    if (d.k === 'mvtext') {
      const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
      if (!d.moved && Math.hypot(dx, dy) * E.lay.k < 3) return;
      d.moved = true; E.mvLive = { i: d.i, dx, dy };
      return liveFrame();
    }
    if (d.k === 'crop') return cropMove(p);
  }
  function up(e) {
    if (!E) return;
    const d = E.drag; if (!d) return;
    E.drag = null;
    if (E.raf) { cancelAnimationFrame(E.raf); E.raf = 0; }
    if (d.k === 'path') {
      push(d.op); clearLive();
      if (d.op.tool === 'blur') blurInto(E.base, d.op, E.base.getContext('2d')); else renderAnn();
    } else if (d.k === 'shape') {
      clearLive();
      if (d.moved) { push(d.op); renderAnn(); }
    } else if (d.k === 'mvtext') {
      const m = E.mvLive; E.mvLive = null;
      if (d.moved && m) push({ t: 'mv', i: m.i, dx: m.dx, dy: m.dy });
      renderAnn();
      if (!d.moved) openText(null, d.i);
    } else if (d.k === 'newtext') openText(d.p0);
  }
  function constrain(op) {
    const [x1, y1] = op.a, dx = op.b[0] - x1, dy = op.b[1] - y1;
    if (op.tool === 'rect' || op.tool === 'ellipse') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      op.b = [x1 + (dx < 0 ? -m : m), y1 + (dy < 0 ? -m : m)];
    } else {
      const st = Math.PI / 4, an = Math.round(Math.atan2(dy, dx) / st) * st, len = Math.hypot(dx, dy);
      op.b = [x1 + Math.cos(an) * len, y1 + Math.sin(an) * len];
    }
  }
  function hitText(p) {
    for (let i = E.ops.length - 1; i >= 0; i--) {
      const b = E.ops[i].t === 'text' && E.ops[i]._box;
      if (b && p[0] >= b.x - 6 && p[0] <= b.x + b.w + 6 && p[1] >= b.y - 4 && p[1] <= b.y + b.h + 4) return i;
    }
    return -1;
  }

  // ---------------- text
  function openText(p, i) {
    const k = E.lay.k;
    let x, y, s, c, txt = '';
    if (i != null) {
      const op = E.ops[i], st = textState()[i];
      x = op.x + st.dx; y = op.y + st.dy; s = op.s; c = op.c; txt = st.txt != null ? st.txt : op.txt;
      E.hideText = i; renderAnn();
    } else {
      s = E.fs / k; c = E.color; x = p[0]; y = p[1] - s * .61;
    }
    const el = $e('div', 'edtx', E.view);
    try { el.contentEditable = 'plaintext-only'; } catch (err) { el.contentEditable = 'true'; }
    el.spellcheck = false;
    el.style.font = TFONT(s * k); el.style.lineHeight = '1.22'; el.style.color = c;
    el.style.left = (x - E.V.x) * k + 'px'; el.style.top = (y - E.V.y) * k + 'px';
    el.textContent = txt;
    E.tx = { el, x, y, s, c, i };
    el.addEventListener('blur', () => { if (E && E.tx && E.tx.el === el) commitText(); });
    el.focus();
    const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
    RS.anim(el, { opacity: [0, 1] }, { duration: .12 });
  }
  function commitText(cancel) {
    const t = E && E.tx; if (!t) return;
    E.tx = null; E.hideText = -1;
    const txt = (t.el.innerText || '').replace(/\n+$/, '');
    t.el.remove();
    if (!cancel) {
      if (t.i != null) {
        const st = textState()[t.i], cur = st && st.txt != null ? st.txt : E.ops[t.i].txt, op = E.ops[t.i];
        if (txt !== cur || t.c !== op.c || Math.abs(t.s - op.s) > .01) {
          // a changed colour or size makes it a new text in place of the old one
          if (t.c !== op.c || Math.abs(t.s - op.s) > .01) { push({ t: 'tx', i: t.i, txt: '' }); if (txt.trim()) push({ t: 'text', x: t.x, y: t.y, s: t.s, c: t.c, txt }); }
          else push({ t: 'tx', i: t.i, txt: txt.trim() ? txt : '' });
        }
      } else if (txt.trim()) push({ t: 'text', x: t.x, y: t.y, s: t.s, c: t.c, txt });
    }
    renderAnn();
  }

  // ---------------- crop
  function cropOn(instant) {
    E.cr = { ...E.V }; placeCrop();
    E.crop.style.display = 'block';
    if (instant) E.crop.style.opacity = 1; else RS.anim(E.crop, { opacity: [0, 1] }, { duration: .16 });
    showOpt('b', instant);
  }
  function cropOff(instant) {
    E.crop.style.display = 'none'; E.crop.style.opacity = 0;
    showOpt('a', instant);
  }
  function showOpt(m, instant) {
    if (E.optMode === m) return;
    E.optMode = m;
    const on = m === 'a' ? E.oa : E.ob, off = m === 'a' ? E.ob : E.oa;
    on.style.visibility = 'visible'; on.style.pointerEvents = ''; off.style.pointerEvents = 'none';
    if (instant) { on.style.opacity = 1; off.style.opacity = 0; off.style.visibility = 'hidden'; return; }
    RS.anim(on, { opacity: 1 }, { duration: .18, ease: [.3, 0, .2, 1] });
    RS.anim(off, { opacity: 0 }, { duration: .12 }).then(() => { if (E && E.optMode !== (m === 'a' ? 'b' : 'a')) off.style.visibility = 'hidden'; });
  }
  function placeCrop() {
    const k = E.lay.k, r = E.cr, s = E.crop.style;
    s.left = (r.x - E.V.x) * k + 'px'; s.top = (r.y - E.V.y) * k + 'px'; s.width = r.w * k + 'px'; s.height = r.h * k + 'px';
  }
  function cropDown(e, p) {
    const h = e.target.dataset && e.target.dataset.h, r = E.cr;
    const inside = p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
    E.drag = { k: 'crop', h: h || (inside ? 'move' : 'new'), r0: { ...r }, p0: p };
  }
  function cropMove(p) {
    const d = E.drag, V = E.V, r0 = d.r0, mn = 16 / E.lay.k;
    const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
    if (d.h === 'move') {
      E.cr = { x: cl(r0.x + dx, V.x, V.x + V.w - r0.w), y: cl(r0.y + dy, V.y, V.y + V.h - r0.h), w: r0.w, h: r0.h };
    } else if (d.h === 'new') {
      const x1 = cl(Math.min(d.p0[0], p[0]), V.x, V.x + V.w), x2 = cl(Math.max(d.p0[0], p[0]), V.x, V.x + V.w);
      const y1 = cl(Math.min(d.p0[1], p[1]), V.y, V.y + V.h), y2 = cl(Math.max(d.p0[1], p[1]), V.y, V.y + V.h);
      if (x2 - x1 < mn || y2 - y1 < mn) return;
      E.cr = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    } else {
      let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
      if (d.h.includes('l')) x1 = cl(x1 + dx, V.x, x2 - mn);
      if (d.h.includes('r')) x2 = cl(x2 + dx, x1 + mn, V.x + V.w);
      if (d.h.includes('t')) y1 = cl(y1 + dy, V.y, y2 - mn);
      if (d.h.includes('b')) y2 = cl(y2 + dy, y1 + mn, V.y + V.h);
      E.cr = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    placeCrop();
  }
  function cropTo(r) {
    r = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
    r.w = Math.min(r.w, E.iw - r.x); r.h = Math.min(r.h, E.ih - r.y);
    if (same(r, E.V)) return Promise.resolve(false);
    push({ t: 'crop', r });
    const V0 = E.V; E.V = viewOf();
    return relayout(V0).then(() => true);
  }
  function cropApply() {
    if (!E || E.anim) return;
    cropTo(E.cr).then(() => { if (E && E.tool === 'crop') setTool(E.prevTool || 'brush'); });
  }
  function cropFull() {
    if (!E || E.anim) return;
    cropTo({ x: 0, y: 0, w: E.iw, h: E.ih }).then(ch => { if (E && !ch) { E.cr = { ...E.V }; placeCrop(); } });
  }

  // ---------------- keys: while the editor is open, the overlay never sees them
  addEventListener('keydown', e => {
    if (!E) return;
    e.stopImmediatePropagation();
    const k = e.key, c = e.code, ctrl = e.ctrlKey || e.metaKey;
    if (E.tx) {
      if (k === 'Escape' || (k === 'Enter' && !e.shiftKey)) { e.preventDefault(); commitText(); }
      return;
    }
    if (e.target && e.target.tagName === 'INPUT' && !k.startsWith('Esc') && !ctrl) return;
    if (!E.ui || E.closing) { e.preventDefault(); return; }
    if (k === 'Escape') { e.preventDefault(); return E.tool === 'crop' && !E.anim ? setTool(E.prevTool || 'brush') : close('esc'); }
    if (k === 'Enter') { e.preventDefault(); return E.tool === 'crop' && !E.anim ? cropApply() : close('enter'); }
    if (ctrl && c === 'KeyZ') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (ctrl && c === 'KeyY') { e.preventDefault(); return redo(); }
    if (ctrl && c === 'KeyC') { e.preventDefault(); return put('copy'); }
    if (ctrl && c === 'KeyS') { e.preventDefault(); return put('save'); }
    if (ctrl || e.altKey || E.anim) return;
    if (c === 'BracketLeft' || c === 'BracketRight') {
      e.preventDefault();
      const v = (E.tool === 'text' ? E.fs : E.sz) + (c === 'BracketLeft' ? -1 : 1) * (E.tool === 'text' ? 4 : 2);
      setSize(v); saveSize(); return;
    }
    const t = TOOLS.find(t => 'Key' + t.k === c);
    if (t) { e.preventDefault(); setTool(t.id); }
  }, true);
  addEventListener('keyup', e => { if (E) e.stopImmediatePropagation(); }, true);

  // ---------------- giving the picture back
  function compose() {
    const V = E.V, c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(V.w)); c.height = Math.max(1, Math.round(V.h));
    const x = c.getContext('2d');
    x.drawImage(E.base, V.x, V.y, c.width, c.height, 0, 0, c.width, c.height);
    x.drawImage(E.ann, V.x, V.y, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }
  const png = c => new Promise((res, rej) => c.toBlob(b => {
    if (!b) return rej(new Error('PNG не получился'));
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  }, 'image/png'));
  async function put(a) {
    if (!E || E.busy || !E.src) return false;
    if (E.tx) commitText();
    E.busy = true;
    try {
      const c = compose(), data = await png(c);
      const hist = E.ops.length > 0 && E.histVer !== E.ver;
      await RS.invoke('ed_put', { png: data, action: a, hist });
      if (hist) E.histVer = E.ver;
      if (E.ops.length) last = { png: data, w: c.width, h: c.height };
      if (a === 'copy') E.copied = E.ver; else E.saved = true;
      if (E.ui) toast(a === 'copy' ? 'Скопировано' : 'Сохранено', true);
      return true;
    } catch (err) {
      const m = String(err && err.message || err || 'Не получилось');
      RS.log('editor ' + a + ': ' + m);
      if (E) toast(m.slice(0, 60), false);
      return false;
    } finally { if (E) E.busy = false; }
  }
  async function close(why) {
    if (!E || E.closing || E.busy) return;
    if (E.anim) { E.pend = why; return; }
    if (E.tx) commitText();
    if (E.drag) return;
    const edited = E.ops.length > 0;
    // edited: the changed picture goes to the clipboard straight away
    if (edited && E.copied !== E.ver && !(await put('copy'))) return;
    if (!E || E.closing) return;
    const o = E.o;
    E.closing = true; E.ui = false;
    hideTip(); ringShow();
    RS.log('editor closed: ' + why + (edited ? ` (edited, ${E.ops.length} steps)` : ''));
    const c = compose(), A = { x: 0, y: 0, w: c.width, h: c.height };
    const gh = $e('div', 'edgh', E.root); gh.appendChild(c);
    c.style.width = c.width + 'px'; c.style.height = c.height + 'px';
    cover(c, E.lay.w, E.lay.h, A);
    gh.style.left = E.lay.x + 'px'; gh.style.top = E.lay.y + 'px'; gh.style.width = E.lay.w + 'px'; gh.style.height = E.lay.h + 'px';
    E.view.classList.remove('on');
    fadeOut(E.opt); fadeOut(E.bar); RS.anim(E.toast, { opacity: 0 }, { duration: .12 });
    RS.anim(E.bg, { opacity: 0 }, { duration: .34, ease: [.3, 0, .2, 1] });
    await morph(gh, E.lay, o.T, RAD, THUMB_R, SP_CLOSE, (w, h) => cover(c, w, h, A));
    if (!E) return;
    // the capsule thumbnail shows the edited picture from now on
    if (edited && o.thumb) {
      for (const ch of o.thumb.children) if (ch.tagName === 'IMG' || ch.classList.contains('edth')) ch.style.display = 'none';
      const old = o.thumb.querySelector('canvas.edth'); if (old) old.remove();
      const th = document.createElement('canvas'); th.className = 'edth';
      const s = Math.min(1, 240 / Math.max(c.width, c.height));
      th.width = Math.max(1, Math.round(c.width * s)); th.height = Math.max(1, Math.round(c.height * s));
      th.getContext('2d').drawImage(c, 0, 0, th.width, th.height);
      th.style.width = th.width + 'px'; th.style.height = th.height + 'px';
      cover(th, o.T.w, o.T.h, { x: 0, y: 0, w: th.width, h: th.height });
      o.thumb.insertBefore(th, o.thumb.firstChild);
    }
    const res = { changed: edited, copied: edited && E.copied === E.ver, saved: E.saved, w: c.width, h: c.height };
    const done = E.done;
    kill();
    done(res);
  }
  function kill() {
    if (!E) return;
    if (E.raf) cancelAnimationFrame(E.raf);
    clearTimeout(E.toastT);
    if (E.o.thumb) E.o.thumb.style.visibility = '';
    E.root.remove();
    if (E.src && E.src.close) E.src.close();
    E = null;
  }

  // ---------------- for the build check: real pointer events on the canvas
  ED.test = async cmd => {
    if (!E) return RS.log('test_ed: editor is not open');
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const b = E.view.getBoundingClientRect();
    const fire = (type, x, y, extra) => E.view.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: b.left + x * b.width, clientY: b.top + y * b.height, ...extra }));
    const drag = async (pts, ms) => {
      fire('pointerdown', pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) { fire('pointermove', pts[i][0], pts[i][1]); await wait(ms || 12); }
      fire('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]);
      await wait(60);
    };
    const wave = (y0, n) => Array.from({ length: n }, (_, i) => [.12 + .5 * i / (n - 1), y0 + .06 * Math.sin(i / 3)]);
    if (cmd === 'draw') {
      setTool('brush'); setColor(COLORS[0]); await wait(250); await drag(wave(.3, 30));
      setTool('marker'); setColor(COLORS[2]); await wait(250); await drag([[.15, .55], [.35, .55], [.55, .56]]);
      setTool('rect'); setColor(COLORS[4]); await wait(250); await drag([[.6, .2], [.7, .3], [.85, .45]]);
      setTool('arrow'); setColor(COLORS[3]); await wait(250); await drag([[.2, .8], [.4, .75], [.62, .66]]);
      setTool('blur'); await wait(250); await drag([[.65, .7], [.75, .72], [.88, .74]]);
      setTool('text'); setColor(COLORS[6]); await wait(250);
      fire('pointerdown', .62, .12); fire('pointerup', .62, .12); await wait(80);
      if (E.tx) { E.tx.el.textContent = 'Snap'; commitText(); }
      setTool('brush');
      RS.log(`test_ed draw: ${E.ops.length} steps`);
    } else if (cmd === 'crop') {
      setTool('crop'); await wait(300);
      E.cr = { x: E.iw * .08, y: E.ih * .1, w: E.iw * .84, h: E.ih * .62 }; placeCrop(); await wait(300);
      cropApply(); await wait(900);
      RS.log(`test_ed crop: view ${Math.round(E.V.w)}x${Math.round(E.V.h)}`);
    } else if (cmd === 'undo') { undo(); await wait(700); RS.log(`test_ed undo: ${E.ops.length} steps`); }
    else if (cmd === 'redo') { redo(); await wait(700); RS.log(`test_ed redo: ${E.ops.length} steps`); }
    else if (cmd === 'close') close('test');
    else if (cmd === 'pen') RS.log('test_ed pen icon ' + !!RS.ic(B_PEN.i));
    else if (cmd === 'state') RS.log('test_ed state ' + JSON.stringify({ ui: E.ui, anim: E.anim, busy: E.busy, drag: E.drag && E.drag.k, closing: E.closing, tool: E.tool, tx: !!E.tx }));
  };
  ED.penIcon = () => RS.ic(B_PEN.i);
})();
