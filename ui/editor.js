'use strict';
// Retocker Snap: the picture editor. A click on the capsule thumbnail and the shot flows out of it into the middle of the screen.
// Two canvases: the picture (blur is baked into it) and the drawings on top. Every change is a step in a list, so undo is exact.
// Nothing inside ever grows piece by piece: every panel gets its final size first and then only fades in as a whole.
(() => {
  const $e = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; if (p) p.appendChild(e); return e; };
  const L = (a, b, t) => a + (b - a) * t;
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const OPT_H = 48, BAR_H = 52, GAP = 14, RAD = 14, THUMB_R = 12;
  const SHAPES = new Set(['rect', 'ellipse', 'line', 'arrow']), LPN = 11, LPZ = 10, BH = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
  const TOOLS = [
    { id: 'select', i: 'cursor', t: 'Выбор', k: 'V' },
    { id: 'brush', i: 'paint-brush', t: 'Кисть', k: 'B' },
    { id: 'marker', i: 'highlighter-circle', t: 'Маркер', k: 'M' },
    { id: 'rect', i: 'square', t: 'Прямоугольник', k: 'R' },
    { id: 'ellipse', i: 'circle', t: 'Овал', k: 'O' },
    { id: 'line', i: 'line-segment', t: 'Линия', k: 'L' },
    { id: 'arrow', i: 'arrow-up-right', t: 'Стрелка', k: 'A' },
    { id: 'text', i: 'text-aa', t: 'Текст', k: 'T' },
    { id: 'blur', i: 'drop-half', t: 'Размытие', k: 'U' },
    { id: 'pick', i: 'eyedropper', t: 'Пипетка', k: 'I' },
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
      drag: null, tx: null, hideText: -1, pv: null, seli: -1, raf: 0, bc: new Map(),
      tool: DRAW.has(c.edTool) && c.edTool !== 'pick' ? c.edTool : 'brush', prevTool: 'brush',
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
    E.sel = $e('div', 'edsel', v); E.selb = $e('i', 'edsb', E.sel);
    E.selh = [...BH, 'p1', 'p2'].map(h => { const x = $e('i', 'esh esh-' + h + (h[0] === 'p' ? ' pt' : ''), E.sel); x.dataset.sh = h; return x; });
    E.cur = $e('div', 'edcur', root);
    E.lp = $e('div', 'edlp', root); E.lpz = $e('canvas', '', E.lp); E.lpz.width = E.lpz.height = LPN * LPZ; $e('b', '', E.lp);
    { const lr = $e('div', '', E.lp); E.lpw = $e('i', '', lr); E.lpt = $e('span', '', lr); }
    E.lps = document.createElement('canvas'); E.lps.width = E.lps.height = LPN;
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
    // from the history the picture is its own file, from a capture it is a piece of the frozen screen
    const PA = o.src ? { x: 0, y: 0, w: E.iw, h: E.ih } : o.r;
    if (o.src) { gi.src = o.src; gi.style.width = E.iw + 'px'; gi.style.height = E.ih + 'px'; }
    else { gi.src = o.url; gi.style.width = innerWidth + 'px'; gi.style.height = innerHeight + 'px'; }
    gh.style.visibility = 'hidden';
    const load = loadPic(o);
    load.catch(() => {});
    await fonts();
    if (!E) return;
    if (o.src) { await Promise.race([gi.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]); if (!E) return; }
    measure();
    E.lay = layout(E.V);
    place(E.V, E.lay);
    setTool(E.tool, true); setColor(E.color, false, true); setSize(E.tool === 'text' ? E.fs : E.sz, true);
    updUndo(true);
    RS.log(`editor open ${E.iw}x${E.ih}, view ${Math.round(E.lay.x)},${Math.round(E.lay.y)},${Math.round(E.lay.w)},${Math.round(E.lay.h)}`);
    if (o.thumb) o.thumb.style.visibility = 'hidden';
    gh.style.visibility = '';
    RS.anim(bg, { opacity: 1 }, { duration: .3, ease: [.3, 0, .2, 1] });
    await morph(gh, o.T, E.lay, THUMB_R, RAD, SP_OPEN, (w, h) => cover(gi, w, h, PA));
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
      const res = await fetch(o.src || o.url);
      if (!res.ok) throw new Error('frame ' + res.status);
      bmp = await createImageBitmap(await res.blob(), sx, sy, E.iw, E.ih);
    } catch (e) {
      RS.log('editor fetch: ' + (e && e.message || e) + ', trying the image');
      const im = new Image(); im.crossOrigin = 'anonymous'; im.src = o.src || o.url;
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
    if (E.pv) commitPv();
    if (id !== 'select') select(-1);
    E.view.classList.remove('onmv', 'ontx');
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
    rgRange();
    setSize(isTx() ? E.fs : E.sz, true);
    const colorsOn = id !== 'eraser' && id !== 'blur';
    if (instant) E.cg.style.opacity = colorsOn ? 1 : .3; else RS.anim(E.cg, { opacity: colorsOn ? 1 : .3 }, { duration: .18 });
    E.cg.style.pointerEvents = colorsOn ? '' : 'none';
    if (id === 'crop') cropOn(instant); else cropOff(instant);
    ringShow();
    if (id === 'blur') warmBlur();
    if (!instant && DRAW.has(id) && id !== 'pick') { E.o.cfg && (E.o.cfg.edTool = id); RS.set({ edTool: id }); }
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
    if (!instant && !E.sync && E.seli >= 0) applySel({ c: col }, live);
    if (!instant && !live) { E.o.cfg && (E.o.cfg.edColor = col); RS.set({ edColor: col }); }
  }
  function setSize(v, instant) {
    if (!E) return;
    const tx = isTx();
    v = tx ? cl(v, 12, 96) : cl(v, 2, 40);
    if (tx) E.fs = v; else E.sz = v;
    E.rg.value = v;
    const pct = (v - +E.rg.min) / (+E.rg.max - +E.rg.min) * 100;
    E.rg.style.background = `linear-gradient(90deg,#fff ${pct}%,rgba(255,255,255,.16) ${pct}%)`;
    E.szv.textContent = v;
    const dot = tx ? cl(v * .3, 4, 22) : cl(width(E.tool), 3, 22);
    E.szd.style.width = E.szd.style.height = dot + 'px';
    if (E.tx) { E.tx.s = v / E.lay.k; E.tx.el.style.fontSize = v + 'px'; }
    if (!instant && !E.sync && E.seli >= 0) applySel(sizeProp(v), true);
    if (!instant && E.tool === 'blur') warmBlur();
    ringShow();
  }
  function saveSize() {
    if (!E) return;
    if (E.pv) commitPv();
    const p = isTx() ? { edText: E.fs } : { edSize: E.sz };
    if (E.o.cfg) Object.assign(E.o.cfg, p);
    RS.set(p);
  }
  // the round cursor shows the real brush size
  function ringShow() {
    if (!E) return;
    const on = E.ui && !E.anim && E.inView && RING[E.tool];
    E.cur.style.display = on ? 'block' : 'none';
    if (on) { const s = Math.max(4, width(E.tool)); E.cur.style.width = E.cur.style.height = s + 'px'; E.ringS = s; ringPos(); }
    lpShow();
  }
  function ringMove(e) { if (!E) return; E.mx = e.clientX; E.my = e.clientY; if (E.cur.style.display === 'block') ringPos(); if (E.lpOn) lpFrame(); }
  function ringPos() { const s = E.ringS || 4; E.cur.style.left = (E.mx - s / 2) + 'px'; E.cur.style.top = (E.my - s / 2) + 'px'; }

  // ---------------- drawing
  // what every step looks like now: later steps move, restyle, retext or remove an earlier one, so undo stays exact
  function state() {
    const s = {};
    E.ops.forEach((op, i) => {
      if (op.t === 'set') { if (s[op.i]) Object.assign(s[op.i], op.p); }
      else s[i] = {};
    });
    const v = E.pv; if (v && s[v.i]) Object.assign(s[v.i], v.p);
    return s;
  }
  const look = (op, p) => p && Object.keys(p).length ? { ...op, ...p } : op;
  const lookAt = i => look(E.ops[i], state()[i]);
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
  function text(c, op, lk, i) {
    const txt = lk.txt, x = lk.x, y = lk.y, s = lk.s;
    if (!txt) { op._box = null; return; }
    const lines = txt.split('\n'), lh = s * 1.22;
    c.save();
    c.font = TFONT(s); c.textBaseline = 'alphabetic';
    const m = c.measureText('Hg'), A = m.fontBoundingBoxAscent || s * .9, D = m.fontBoundingBoxDescent || s * .25;
    const off = (lh - (A + D)) / 2 + A;
    let w = 0;
    for (const l of lines) w = Math.max(w, c.measureText(l).width);
    op._box = { x, y, w, h: lines.length * lh };
    if (i === E.hideText) { c.restore(); return; }
    c.fillStyle = lk.c; c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = s * .12; c.shadowOffsetY = s * .03;
    lines.forEach((l, j) => c.fillText(l, x, y + j * lh + off));
    c.restore();
  }
  function drawOp(c, op, i, st) {
    const lk = st && st[i] ? look(op, st[i]) : op;
    if (lk.del) { op._box = null; return; }
    if (op.t === 'path') {
      if (op.tool === 'blur') return;
      c.save();
      if (lk.dx || lk.dy) c.translate(lk.dx || 0, lk.dy || 0);
      if (op.tool === 'eraser') c.globalCompositeOperation = 'destination-out';
      if (op.tool === 'marker') c.globalAlpha = .38;
      c.strokeStyle = op.tool === 'eraser' ? '#000' : lk.c; c.lineWidth = lk.w; c.lineCap = 'round'; c.lineJoin = 'round';
      pathOf(c, op.pts); c.stroke();
      c.restore();
    } else if (op.t === 'shape') shape(c, lk);
    else if (op.t === 'text') text(c, op, lk, i);
  }
  // blur: the whole picture is blurred once per strength and a stroke paints exactly those pixels,
  // so the stroke looks the same while drawing and after it, nothing is rebuilt piece by piece
  const bstr = w => Math.round(cl(w / 3, 5, 26));
  function blurred(f) {
    let c = E.bc.get(f);
    if (c) { E.bc.delete(f); E.bc.set(f, c); return c; }
    const sw = Math.max(1, Math.round(E.iw / f)), sh = Math.max(1, Math.round(E.ih / f));
    const sm = document.createElement('canvas'); sm.width = sw; sm.height = sh;
    const s = sm.getContext('2d'); s.imageSmoothingEnabled = true; s.imageSmoothingQuality = 'high';
    s.drawImage(E.src, 0, 0, sw, sh);
    c = document.createElement('canvas'); c.width = E.iw; c.height = E.ih;
    const t = c.getContext('2d'); t.imageSmoothingEnabled = true; t.imageSmoothingQuality = 'high';
    t.drawImage(sm, 0, 0, E.iw, E.ih); // solid edges under the soft layer
    t.filter = `blur(${(f * .5).toFixed(1)}px)`;
    t.drawImage(sm, 0, 0, sw, sh, -f * .5, -f * .5, E.iw + f, E.ih + f);
    t.filter = 'none';
    E.bc.set(f, c);
    while (E.bc.size > 2) E.bc.delete(E.bc.keys().next().value);
    return c;
  }
  function blurStroke(c, op) {
    if (!E.src) return;
    c.save();
    c.strokeStyle = c.createPattern(blurred(bstr(op.w)), 'no-repeat');
    c.lineWidth = op.w; c.lineCap = 'round'; c.lineJoin = 'round';
    pathOf(c, op.pts); c.stroke();
    c.restore();
  }
  function warmBlur() {
    clearTimeout(E.bwT);
    E.bwT = setTimeout(() => { if (E && E.src && E.tool === 'blur' && !E.drag && E.lay) blurred(bstr(width('blur') / E.lay.k)); }, 60);
  }
  function renderBase() {
    const b = E.base.getContext('2d');
    b.clearRect(0, 0, E.iw, E.ih);
    b.drawImage(E.src, 0, 0);
    for (const op of E.ops) if (op.t === 'path' && op.tool === 'blur') blurStroke(b, op);
  }
  function renderAnn(extra) {
    const a = E.ann.getContext('2d'), st = state();
    a.clearRect(0, 0, E.iw, E.ih);
    E.ops.forEach((op, i) => drawOp(a, op, i, st));
    if (extra) drawOp(a, extra, -1, null);
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
      if (d.op.tool === 'blur') return blurStroke(c, d.op);
      drawOp(c, d.op);
    } else if (d.k === 'shape') { if (d.moved) drawOp(c, d.op); }
    else if (d.k === 'mvtext' || d.k === 'selmv' || d.k === 'selh') { renderAnn(); placeSel(); }
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
    E.pv = null; select(-1);
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

  // ---------------- picking and changing what is already drawn
  const canSel = op => !!op && (op.t === 'shape' || op.t === 'text' || (op.t === 'path' && (op.tool === 'brush' || op.tool === 'marker')));
  const isLn = op => op.t === 'shape' && (op.tool === 'line' || op.tool === 'arrow');
  function bounds(op, lk) {
    if (op.t === 'text') return op._box;
    if (op.t === 'shape') { const p = lk.w / 2; return { x: Math.min(lk.a[0], lk.b[0]) - p, y: Math.min(lk.a[1], lk.b[1]) - p, w: Math.abs(lk.b[0] - lk.a[0]) + 2 * p, h: Math.abs(lk.b[1] - lk.a[1]) + 2 * p }; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of op.pts) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    const p = lk.w / 2, dx = lk.dx || 0, dy = lk.dy || 0;
    return { x: x1 - p + dx, y: y1 - p + dy, w: x2 - x1 + 2 * p, h: y2 - y1 + 2 * p };
  }
  function segD(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], l = vx * vx + vy * vy;
    const t = l ? cl(((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l, 0, 1) : 0;
    return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t);
  }
  function hitOp(op, lk, p, tol) {
    if (op.t === 'text') { const b = op._box; return !!b && p[0] >= b.x - tol && p[0] <= b.x + b.w + tol && p[1] >= b.y - tol && p[1] <= b.y + b.h + tol; }
    const r = lk.w / 2 + tol;
    if (op.t === 'path') {
      const q = [p[0] - (lk.dx || 0), p[1] - (lk.dy || 0)], P = op.pts;
      if (P.length === 1) return Math.hypot(q[0] - P[0][0], q[1] - P[0][1]) <= r;
      for (let j = 1; j < P.length; j++) if (segD(q, P[j - 1], P[j]) <= r) return true;
      return false;
    }
    if (isLn(op)) return segD(p, lk.a, lk.b) <= r;
    const x1 = Math.min(lk.a[0], lk.b[0]), x2 = Math.max(lk.a[0], lk.b[0]), y1 = Math.min(lk.a[1], lk.b[1]), y2 = Math.max(lk.a[1], lk.b[1]);
    if (op.tool === 'rect') {
      const out = p[0] >= x1 - r && p[0] <= x2 + r && p[1] >= y1 - r && p[1] <= y2 + r;
      const inn = p[0] > x1 + r && p[0] < x2 - r && p[1] > y1 + r && p[1] < y2 - r;
      return out && !inn;
    }
    const rx = Math.max(.5, (x2 - x1) / 2), ry = Math.max(.5, (y2 - y1) / 2), cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    return Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1) * Math.min(rx, ry) <= r;
  }
  // the top-most thing under the pointer; shape tools only pick shapes
  function pickAt(p, onlyShapes) {
    const st = state(), tol = 6 / E.lay.k;
    for (let i = E.ops.length - 1; i >= 0; i--) {
      const op = E.ops[i];
      if (!canSel(op) || (onlyShapes && op.t !== 'shape')) continue;
      const lk = look(op, st[i]);
      if (!lk.del && hitOp(op, lk, p, tol)) return i;
    }
    return -1;
  }
  function inSel(p) {
    if (E.seli < 0) return false;
    const op = E.ops[E.seli], lk = lookAt(E.seli), t = 6 / E.lay.k;
    if (lk.del) return false;
    if (isLn(op)) return hitOp(op, lk, p, t * 2);
    const b = bounds(op, lk);
    return !!b && p[0] >= b.x - t && p[0] <= b.x + b.w + t && p[1] >= b.y - t && p[1] <= b.y + b.h + t;
  }
  const isTx = () => E.seli >= 0 ? E.ops[E.seli].t === 'text' : E.tool === 'text';
  function rgRange() { const tx = isTx(); E.rg.min = tx ? 12 : 2; E.rg.max = tx ? 96 : 40; }
  function sizeProp(v) {
    const op = E.ops[E.seli], k = E.lay.k;
    return op.t === 'text' ? { s: v / k } : { w: (op.tool === 'marker' ? v * 2.6 : v) / k };
  }
  function select(i) {
    if (!E) return;
    if (i >= 0 && !canSel(E.ops[i])) i = -1;
    if (i === E.seli) { if (i >= 0) placeSel(); return; }
    if (E.pv) commitPv();
    E.seli = i;
    if (i < 0) {
      E.selOn = false;
      Promise.resolve(RS.anim(E.sel, { opacity: 0 }, { duration: .12 })).then(() => { if (E && E.seli < 0) E.sel.style.display = 'none'; });
      rgRange(); setSize(isTx() ? E.fs : E.sz, true);
      return;
    }
    placeSel();
    if (!E.selOn) { E.selOn = true; E.sel.style.display = 'block'; RS.anim(E.sel, { opacity: [0, 1] }, { duration: .14 }); }
    // the panel shows the colour and the size of the picked thing
    const op = E.ops[i], lk = lookAt(i), k = E.lay.k;
    E.sync = true;
    if (lk.c) setColor(lk.c, true);
    rgRange();
    if (op.t === 'text') { E.fs = cl(Math.round(lk.s * k), 12, 96); setSize(E.fs, true); }
    else { E.sz = cl(Math.round(op.tool === 'marker' ? lk.w * k / 2.6 : lk.w * k), 2, 40); setSize(E.sz, true); }
    E.sync = false;
  }
  function placeSel() {
    const i = E.seli; if (i < 0) return;
    const op = E.ops[i], lk = lookAt(i), k = E.lay.k, vx = x => (x - E.V.x) * k, vy = y => (y - E.V.y) * k;
    const ln = isLn(op);
    let b = null;
    if (!ln && !lk.del) {
      const p = 5 / k;
      if (op.t === 'shape') { const q = lk.w / 2 + p; b = { x: Math.min(lk.a[0], lk.b[0]) - q, y: Math.min(lk.a[1], lk.b[1]) - q, w: Math.abs(lk.b[0] - lk.a[0]) + 2 * q, h: Math.abs(lk.b[1] - lk.a[1]) + 2 * q }; }
      else { const o = bounds(op, lk); if (o) b = { x: o.x - p, y: o.y - p, w: o.w + 2 * p, h: o.h + 2 * p }; }
    }
    const S = E.selb.style;
    S.display = b ? 'block' : 'none';
    if (b) { S.left = vx(b.x) + 'px'; S.top = vy(b.y) + 'px'; S.width = b.w * k + 'px'; S.height = b.h * k + 'px'; }
    const hs = !!b && op.t === 'shape';
    for (const h of E.selh) {
      const n = h.dataset.sh; let x = null, y = null;
      if (hs && n[0] !== 'p') { x = b.x + (n.includes('l') ? 0 : n.includes('r') ? b.w : b.w / 2); y = b.y + (n.includes('t') ? 0 : n.includes('b') ? b.h : b.h / 2); }
      else if (ln && !lk.del && n[0] === 'p') [x, y] = n === 'p1' ? lk.a : lk.b;
      h.style.display = x == null ? 'none' : 'block';
      if (x != null) { h.style.left = vx(x) + 'px'; h.style.top = vy(y) + 'px'; }
    }
  }
  function applySel(p, live) {
    const i = E.seli; if (i < 0) return;
    if (live) { E.pv = { i, p: { ...(E.pv && E.pv.i === i ? E.pv.p : {}), ...p } }; renderAnn(); placeSel(); return; }
    E.pv = null; push({ t: 'set', i, p }); renderAnn(); placeSel();
  }
  function commitPv() {
    const v = E.pv; if (!v) return;
    E.pv = null; push({ t: 'set', i: v.i, p: v.p }); renderAnn();
    if (E.seli >= 0) placeSel();
  }
  function delSel() {
    const i = E.seli; if (i < 0) return;
    if (E.pv) commitPv();
    push({ t: 'set', i, p: { del: true } });
    select(-1); renderAnn();
  }
  function moved(op, lk, dx, dy) {
    if (op.t === 'shape') return { a: [lk.a[0] + dx, lk.a[1] + dy], b: [lk.b[0] + dx, lk.b[1] + dy] };
    if (op.t === 'text') return { x: lk.x + dx, y: lk.y + dy };
    return { dx: (lk.dx || 0) + dx, dy: (lk.dy || 0) + dy };
  }
  function resize(d, dx, dy, shift) {
    const lk = d.L0, h = d.h;
    if (h === 'p1' || h === 'p2') {
      const me = h === 'p1' ? lk.a : lk.b, o = { tool: E.ops[d.i].tool, a: h === 'p1' ? lk.b : lk.a, b: [me[0] + dx, me[1] + dy] };
      if (shift) constrain(o);
      return h === 'p1' ? { a: o.b } : { b: o.b };
    }
    let x1 = Math.min(lk.a[0], lk.b[0]), x2 = Math.max(lk.a[0], lk.b[0]), y1 = Math.min(lk.a[1], lk.b[1]), y2 = Math.max(lk.a[1], lk.b[1]);
    if (h.includes('l')) x1 += dx;
    if (h.includes('r')) x2 += dx;
    if (h.includes('t')) y1 += dy;
    if (h.includes('b')) y2 += dy;
    return { a: [x1, y1], b: [x2, y2] };
  }

  // ---------------- pointer
  function down(e) {
    if (!E || !E.ui || E.anim || E.busy || e.button !== 0) return;
    if (E.tx) { commitText(); if (E.tool === 'text') return; }
    const p = toImg(e), t = E.tool;
    try { E.view.setPointerCapture(e.pointerId); } catch (err) {}
    if (t === 'crop') return cropDown(e, p);
    if (t === 'pick') return pickColor();
    const sh = e.target && e.target.dataset ? e.target.dataset.sh : null;
    if (sh && E.seli >= 0) { E.drag = { k: 'selh', h: sh, i: E.seli, p0: p, L0: lookAt(E.seli), moved: false }; return; }
    if (t === 'select' || SHAPES.has(t)) {
      const i = t === 'select' && inSel(p) ? E.seli : pickAt(p, t !== 'select');
      if (i >= 0) { select(i); E.drag = { k: 'selmv', i, p0: p, L0: lookAt(i), moved: false }; return; }
      select(-1);
      if (t === 'select') return;
    }
    if (t === 'text') {
      const i = hitText(p);
      E.drag = i >= 0 ? { k: 'mvtext', i, p0: p, L0: lookAt(i), moved: false } : { k: 'newtext', p0: p };
      return;
    }
    const w = width(t) / E.lay.k;
    if (RING[t]) {
      // a blur stroke is drawn under the annotations right away, like it will be after release
      if (t === 'blur') { E.live.style.zIndex = '1'; E.ann.style.zIndex = '2'; }
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
      if (!E.ui || E.anim) return;
      const t = E.tool;
      if (t === 'text') E.view.classList.toggle('ontx', hitText(toImg(e)) >= 0);
      else if (t === 'select' || SHAPES.has(t)) {
        const p = toImg(e), on = (t === 'select' && inSel(p)) || pickAt(p, t !== 'select') >= 0;
        E.view.classList.toggle('onmv', on);
      }
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
    if (d.k === 'mvtext' || d.k === 'selmv' || d.k === 'selh') {
      const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
      if (!d.moved && Math.hypot(dx, dy) * E.lay.k < 3) return;
      d.moved = true;
      E.pv = { i: d.i, p: d.k === 'selh' ? resize(d, dx, dy, e.shiftKey) : moved(E.ops[d.i], d.L0, dx, dy) };
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
      push(d.op);
      if (d.op.tool === 'blur') { blurStroke(E.base.getContext('2d'), d.op); clearLive(); E.live.style.zIndex = ''; E.ann.style.zIndex = ''; }
      else { clearLive(); renderAnn(); }
    } else if (d.k === 'shape') {
      clearLive();
      if (d.moved) { push(d.op); renderAnn(); select(E.ops.length - 1); }
    } else if (d.k === 'mvtext' || d.k === 'selmv' || d.k === 'selh') {
      const v = E.pv; E.pv = null;
      if (d.moved && v) push({ t: 'set', i: v.i, p: v.p });
      renderAnn(); placeSel();
      if (d.k === 'mvtext' && !d.moved) openText(null, d.i);
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
      const lk = lookAt(i);
      x = lk.x; y = lk.y; s = lk.s; c = lk.c; txt = lk.txt || '';
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
        // an edited text stays the same object: only what changed is written down
        const lk = lookAt(t.i), p = {};
        if (!txt.trim()) p.del = true;
        else {
          if (txt !== lk.txt) p.txt = txt;
          if (t.c !== lk.c) p.c = t.c;
          if (Math.abs(t.s - lk.s) > .01) p.s = t.s;
        }
        if (Object.keys(p).length) push({ t: 'set', i: t.i, p });
      } else if (txt.trim()) push({ t: 'text', x: t.x, y: t.y, s: t.s, c: t.c, txt });
    }
    renderAnn();
  }

  // ---------------- eyedropper
  function lpShow() {
    if (!E || !E.lp) return;
    const on = !!(E.ui && !E.anim && E.inView && E.tool === 'pick');
    if (on === !!E.lpOn) return;
    E.lpOn = on;
    if (on) { lpUpd(); E.lp.style.display = 'block'; RS.anim(E.lp, { opacity: [0, 1] }, { duration: .12 }); }
    else Promise.resolve(RS.anim(E.lp, { opacity: 0 }, { duration: .1 })).then(() => { if (E && !E.lpOn) E.lp.style.display = 'none'; });
  }
  function lpFrame() {
    if (E.lpRaf) return;
    E.lpRaf = requestAnimationFrame(() => { if (!E) return; E.lpRaf = 0; if (E.lpOn) lpUpd(); });
  }
  function lpUpd() {
    if (E.mx == null || !E.lay) return;
    const b = E.view.getBoundingClientRect(), k = E.lay.k, h = LPN >> 1, V = E.V;
    const x = Math.floor(cl(V.x + (E.mx - b.left) / k, V.x, V.x + V.w - 1)), y = Math.floor(cl(V.y + (E.my - b.top) / k, V.y, V.y + V.h - 1));
    const c = E.lpc || (E.lpc = E.lps.getContext('2d', { willReadFrequently: true }));
    c.clearRect(0, 0, LPN, LPN); c.fillStyle = '#111'; c.fillRect(0, 0, LPN, LPN);
    c.drawImage(E.base, x - h, y - h, LPN, LPN, 0, 0, LPN, LPN);
    c.drawImage(E.ann, x - h, y - h, LPN, LPN, 0, 0, LPN, LPN);
    const d = c.getImageData(h, h, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const z = E.lpz.getContext('2d'); z.imageSmoothingEnabled = false;
    z.clearRect(0, 0, LPN * LPZ, LPN * LPZ); z.drawImage(E.lps, 0, 0, LPN * LPZ, LPN * LPZ);
    E.lpHex = hex; E.lpt.textContent = hex.toUpperCase(); E.lpw.style.background = hex;
    const W = 122, H = 154, m = E.m;
    let lx = E.mx + 22, ly = E.my + 22;
    if (lx + W > m.x + m.w - 8) lx = E.mx - 22 - W;
    if (ly + H > m.y + m.h - 8) ly = E.my - 22 - H;
    E.lp.style.left = lx + 'px'; E.lp.style.top = ly + 'px';
  }
  function pickColor() {
    lpUpd();
    const hex = E.lpHex; if (!hex) return;
    const H = hex.toUpperCase();
    setColor(hex);
    Promise.resolve(RS.invoke('copy_text', { text: H })).then(
      ok => toast(ok === false ? 'Не удалось скопировать цвет' : `Цвет ${H} скопирован`, ok !== false),
      () => toast('Не удалось скопировать цвет', false));
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
      const v = (isTx() ? E.fs : E.sz) + (c === 'BracketLeft' ? -1 : 1) * (isTx() ? 4 : 2);
      setSize(v); saveSize(); return;
    }
    if ((k === 'Delete' || k === 'Backspace') && E.seli >= 0) { e.preventDefault(); return delSel(); }
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
    if (E.pv) commitPv();
    select(-1);
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
    const fire = (type, x, y, extra, el) => (el || E.view).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: b.left + x * b.width, clientY: b.top + y * b.height, ...extra }));
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
    } else if (cmd === 'sel') {
      setTool('select'); await wait(250);
      const r = E.ops.findIndex(op => op.t === 'shape' && op.tool === 'rect');
      if (r < 0) { RS.log('test_ed sel: no rect'); return; }
      const l0 = lookAt(r), fx = x => (x - E.V.x) / E.V.w, fy = y => (y - E.V.y) / E.V.h;
      const x0 = fx(Math.min(l0.a[0], l0.b[0])), y0 = fy((l0.a[1] + l0.b[1]) / 2);
      await drag([[x0, y0], [x0 - .02, y0 + .02], [x0 - .05, y0 + .06]]);
      const picked = E.seli === r;
      const h = E.selh.find(q => q.dataset.sh === 'br'), hb = h.getBoundingClientRect();
      const hx = (hb.left + hb.width / 2 - b.left) / b.width, hy = (hb.top + hb.height / 2 - b.top) / b.height;
      fire('pointerdown', hx, hy, {}, h);
      for (let i = 1; i <= 6; i++) { fire('pointermove', hx + .01 * i, hy + .008 * i); await wait(16); }
      fire('pointerup', hx + .06, hy + .048); await wait(80);
      setColor(COLORS[5]); await wait(250);
      const l1 = lookAt(r);
      RS.log(`test_ed sel: picked ${picked}, sel ${E.seli === r}, moved ${Math.round(Math.min(l1.a[0], l1.b[0]) - Math.min(l0.a[0], l0.b[0]))}, grown ${Math.round(Math.abs(l1.b[0] - l1.a[0]) - Math.abs(l0.b[0] - l0.a[0]))}, color ${l1.c}, ${E.ops.length} steps`);
    } else if (cmd === 'pick') {
      setTool('pick'); await wait(200);
      fire('pointerenter', .3, .3); fire('pointermove', .3, .3); E.inView = true; ringShow(); await wait(250);
      fire('pointerdown', .3, .3); fire('pointerup', .3, .3); await wait(200);
      RS.log(`test_ed pick: ${E.lpHex} color ${E.color} loupe ${!!E.lpOn}`);
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
