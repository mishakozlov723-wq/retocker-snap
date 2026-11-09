'use strict';
// The selection stage. The real overlay and every preview in the settings draw with this same code,
// so what the user sees in the settings is exactly what PrintScreen shows.
(() => {
  const $e = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
  const ACTS = [
    { id: 'copy', icon: 'copy', t: 'Копировать', k: 'Ctrl+C', pri: true },
    { id: 'save', icon: 'floppy-disk', t: 'Сохранить', k: 'Ctrl+S' },
    { id: 'ocr', icon: 'text-t', t: 'Текст', k: 'T' },
    { id: 'ai', icon: 'sparkle', t: 'Текст через ИИ', k: 'Shift+T', ai: true },
    { sp: true },
    { id: 'close', icon: 'x', t: 'Отмена', k: 'Esc' }
  ];
  // the round menu after the shot
  const RADS = [
    { id: 'copy', icon: 'copy', t: 'Копировать', done: 'Скопировано' },
    { id: 'save', icon: 'floppy-disk', t: 'Сохранить', done: 'Сохранено' },
    { id: 'ocr', icon: 'text-t', t: 'Текст', done: 'Текст скопирован' },
    { id: 'ai', icon: 'sparkle', t: 'Через ИИ', done: 'Текст скопирован', ai: true },
    { id: 'close', icon: 'x', t: 'Закрыть' }
  ];
  const HS = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'];

  function make(root) {
    const el = $e('div', 'st', root);
    const shade = $e('div', 'shade', el), blur = $e('img', 'blur', shade); $e('div', 'tint', shade);
    const hole = $e('div', 'hole', el), sharp = $e('img', '', hole);
    const cx = $e('div', 'cx', el), cy = $e('div', 'cy', el);
    const fr = $e('div', 'fr', el);
    const lab = $e('div', 'lab', el);
    const mag = $e('div', 'mag', el), g = $e('div', 'g', mag), hx = $e('div', 'hx', mag);
    const bar = $e('div', 'bar', el);
    const flash = $e('div', 'flash', el);
    const hint = $e('div', 'hint', el);
    const rad = $e('div', 'rad', el);
    const cap = $e('div', 'rad', el);
    const st = { el, W: 0, H: 0, dpr: 1, url: '', r: null, adj: false, c: {}, ai: false, onAct: null, cv: null, cvx: null };

    st.frame = (url, W, H, dpr) => {
      st.url = url; st.W = W; st.H = H; st.dpr = dpr || 1;
      for (const i of [blur, sharp]) { i.src = url; i.style.width = W + 'px'; i.style.height = H + 'px'; }
      st.cv = null;
      return Promise.all([blur, sharp].map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve()));
    };

    st.cfg = c => {
      st.c = c;
      const s = el.style;
      s.setProperty('--fc', c.frameColor);
      s.setProperty('--fcA', RS.hexA(c.frameColor, .45));
      s.setProperty('--fw', c.frameW + 'px');
      s.setProperty('--fr', c.frameR + 'px');
      s.setProperty('--hs', c.handleSize + 'px');
      s.setProperty('--gl', Math.max(4, c.frameGlow || 10));
      s.setProperty('--dim', RS.hexA(c.dimColor, c.dim / 100));
      s.setProperty('--ms', c.magSize + 'px');
      blur.style.filter = [c.blur > 0 ? `blur(${c.blur}px)` : '', c.gray ? 'grayscale(1)' : ''].join(' ').trim() || 'none';
      // a blur shows the screen's edge: grow the picture a bit so the edge stays outside
      const m = c.blur > 0 ? c.blur * 2 : 0;
      blur.style.transform = m ? `translate(${-m}px,${-m}px) scale(${(st.W + m * 2) / Math.max(1, st.W)},${(st.H + m * 2) / Math.max(1, st.H)})` : '';
      blur.style.transformOrigin = '0 0';
      el.classList.toggle('cdash', c.crossStyle === 'dash');
      el.classList.toggle('ccol', c.crossStyle === 'color');
      mag.classList.toggle('sq', c.magShape === 'square');
      buildFrame();
      buildBar();
      if (st.r) place();
    };

    function buildFrame() {
      const c = st.c, f = c.frame;
      fr.className = 'fr ' + ({ circle: 'hc', square: 'hs', bar: 'hb', none: 'hn' }[c.handles] || 'hc');
      if (c.frameShadow && f !== 'neon' && f !== 'none') fr.classList.add('shadow');
      if (f === 'neon' || (c.frameGlow > 0 && f === 'solid')) fr.classList.add('glow');
      if (f === 'ants') fr.classList.add('ants');
      if (st.adj) fr.classList.add('adj');
      let h = '';
      if (f === 'solid' || f === 'neon') h = '<div class="b"></div>';
      else if (f === 'dashed' || f === 'ants') {
        const d = f === 'ants' ? '7 7' : `${Math.max(4, c.frameW * 4)} ${Math.max(3, c.frameW * 3)}`;
        h = `<svg><rect x="0" y="0" width="100%" height="100%" rx="${c.frameR}" stroke-dasharray="${d}"/></svg>`;
      } else if (f === 'corners') h = '<div class="thin"></div><div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div>';
      h += HS.map(k => `<div class="h ${k}" data-h="${k}"></div>`).join('');
      fr.innerHTML = h;
      fr.style.display = f === 'none' && c.handles === 'none' ? 'none' : '';
    }

    function buildBar() {
      const c = st.c;
      bar.className = 'bar' + (c.barStyle === 'square' ? ' sq' : c.barStyle === 'light' ? ' flat' : '') + (bar.classList.contains('on') ? ' on' : '');
      bar.innerHTML = ACTS.filter(a => !a.ai || st.ai).map(a => a.sp ? '<i class="sp"></i>'
        : `<button data-a="${a.id}" class="${a.pri ? 'pri' : ''}">${RS.ic(a.icon)}${c.barLabels && a.id !== 'close' ? `<span>${a.t}</span>` : ''}<span class="tt">${a.t}<kbd>${a.k}</kbd></span></button>`).join('');
    }
    bar.addEventListener('pointerdown', e => e.stopPropagation());
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b && st.onAct) st.onAct(b.dataset.a); });

    function place() {
      const r = st.r; if (!r) return;
      hole.style.transform = `translate(${r.x}px,${r.y}px)`;
      hole.style.width = r.w + 'px'; hole.style.height = r.h + 'px';
      sharp.style.transform = `translate(${-r.x}px,${-r.y}px)`;
      fr.style.transform = `translate(${r.x}px,${r.y}px)`;
      fr.style.width = r.w + 'px'; fr.style.height = r.h + 'px';
      fr.style.setProperty('--cl', Math.max(6, Math.min(24, Math.min(r.w, r.h) / 3)) + 'px');
      // the size
      const mode = st.c.sizeLabel;
      if (mode === 'off' || r.w < 2 || r.h < 2) lab.classList.remove('on');
      else {
        lab.innerHTML = `${Math.round(r.w * st.dpr)}<i>×</i>${Math.round(r.h * st.dpr)}`;
        lab.classList.add('on');
        const lw = lab.offsetWidth || 80;
        let x, y;
        if (mode === 'inside') { x = r.x + r.w - lw - 6; y = r.y + r.h - 28; if (r.w < lw + 12 || r.h < 34) { x = r.x + r.w + 6; y = r.y + r.h - 22; } }
        else { x = r.x; y = r.y - 28; if (y < 4) y = r.y + 6, x = r.x + 6; }
        lab.style.transform = `translate(${Math.max(4, Math.min(st.W - lw - 4, x))}px,${Math.max(4, Math.min(st.H - 26, y))}px)`;
      }
    }

    st.hover = r => {
      if (st.adj) return;
      if (!r) { el.classList.add('nohole'); el.classList.remove('soft'); fr.style.visibility = 'hidden'; lab.classList.remove('on'); st.r = null; return; }
      el.classList.remove('nohole'); el.classList.add('soft'); fr.style.visibility = ''; fr.classList.add('hov');
      st.r = r; place();
    };
    st.select = (r, adj) => {
      st.adj = !!adj;
      el.classList.remove('nohole', 'soft'); fr.style.visibility = ''; fr.classList.remove('hov');
      fr.classList.toggle('adj', st.adj);
      st.r = r; place();
    };

    st.cursor = (x, y, show) => {
      const c = st.c;
      el.classList.toggle('crs', !!(show && c.cross));
      cx.style.transform = `translateY(${Math.round(y)}px)`;
      cy.style.transform = `translateX(${Math.round(x)}px)`;
      if (!show || !c.mag) { mag.classList.remove('on'); return; }
      const z = c.magZoom, ms = c.magSize, d = st.dpr;
      const px = Math.floor(x * d), py = Math.floor(y * d);
      g.style.backgroundImage = `url("${st.url}")`;
      g.style.backgroundSize = `${st.W * d * z}px ${st.H * d * z}px`;
      g.style.backgroundPosition = `${ms / 2 - (px + .5) * z}px ${ms / 2 - (py + .5) * z}px`;
      g.style.setProperty('--z', z + 'px');
      g.style.setProperty('--go', ((ms / 2 - z / 2) % z) + 'px');
      if (c.hex) {
        const col = st.color(px, py);
        hx.style.display = '';
        hx.innerHTML = col ? `<b style="background:${col}"></b>${col.toUpperCase()}<span style="opacity:.45">${px}, ${py}</span>` : `${px}, ${py}`;
      } else hx.style.display = 'none';
      let mx = x + 24, my = y + 24;
      if (mx + ms > st.W - 4) mx = x - ms - 24;
      if (my + ms + 28 > st.H - 4) my = y - ms - 50;
      mag.style.transform = `translate(${mx}px,${my}px)`;
      mag.classList.add('on');
    };

    // the colour under the cursor, from a copy of the picture
    st.color = (px, py) => {
      try {
        if (!st.cv) {
          const i = sharp; if (!i.naturalWidth) return '';
          st.cv = document.createElement('canvas'); st.cv.width = i.naturalWidth; st.cv.height = i.naturalHeight;
          st.cvx = st.cv.getContext('2d', { willReadFrequently: true });
          st.cvx.drawImage(i, 0, 0);
        }
        const p = st.cvx.getImageData(Math.max(0, Math.min(st.cv.width - 1, px)), Math.max(0, Math.min(st.cv.height - 1, py)), 1, 1).data;
        return '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      } catch (e) { return ''; }
    };

    st.bar = show => {
      const was = bar.classList.contains('on');
      bar.classList.toggle('on', !!show);
      if (!show) { bar.style.opacity = 0; return; }
      const r = st.r; if (!r) return;
      const bw = bar.offsetWidth, bh = bar.offsetHeight;
      let x = r.x + r.w - bw, y = r.y + r.h + 10, below = true;
      if (y + bh > st.H - 6) { y = r.y - bh - 10; below = false; }
      if (y < 6) { y = r.y + r.h - bh - 10; below = true; }
      x = Math.max(6, Math.min(st.W - bw - 6, x));
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
      bar.style.transformOrigin = below ? '100% 0' : '100% 100%';
      if (!was) RS.anim(bar, { opacity: [0, 1], scale: [.9, 1], y: [below ? -6 : 6, 0] }, RS.spring(300, 35));
      else bar.style.opacity = 1;
    };

    // a piece of the frozen screen flows from one box into another: one spring drives the size, the place and the corners
    function morphBox(gh, gi, A, B, ra, rb, sp, extra) {
      const L = (a, b, p) => a + (b - a) * p;
      const set = p => {
        const x = L(A.x, B.x, p), y = L(A.y, B.y, p), w = Math.max(1, L(A.w, B.w, p)), h = Math.max(1, L(A.h, B.h, p));
        const q = Math.max(0, Math.min(1, p));
        gh.style.left = x + 'px'; gh.style.top = y + 'px'; gh.style.width = w + 'px'; gh.style.height = h + 'px';
        gh.style.borderRadius = Math.max(0, L(ra, rb, q)) + 'px';
        const s = Math.max(w / A.w, h / A.h), ox = (w - A.w * s) / 2, oy = (h - A.h * s) / 2;
        gi.style.transform = `translate(${ox - A.x * s}px,${oy - A.y * s}px) scale(${s})`;
        if (extra) extra(p);
      };
      set(0);
      return RS.drive(sp, set);
    }
    // ---------------- the round menu: the frame turns into a circle, the buttons come out around it
    rad.addEventListener('pointerdown', e => e.stopPropagation());
    rad.addEventListener('click', e => { const b = e.target.closest('button'); if (b && st.onRad) st.onRad(b.dataset.a); });
    rad.addEventListener('pointerenter', () => st.onRadHover && st.onRadHover(true));
    rad.addEventListener('pointerleave', () => st.onRadHover && st.onRadHover(false));
    const CHECK = '<svg viewBox="0 0 24 24"><path d="m5.5 12.5 4.2 4.2 8.8-9.2" pathLength="1"/></svg>';
    st.radOpen = async () => {
      const c = st.c, r = st.r; if (!r) return;
      const D = Math.max(80, c.radSize || 132), RO = D / 2 + 34, M = RO + 30;
      const ccx = Math.max(M, Math.min(st.W - M, r.x + r.w / 2)), ccy = Math.max(M, Math.min(st.H - M, r.y + r.h / 2));
      fr.style.visibility = 'hidden'; lab.classList.remove('on'); st.bar(false); mag.classList.remove('on'); el.classList.remove('crs');
      el.classList.add('nohole');
      // the picture: the selection itself flows into the circle
      const gh = $e('div', 'ghost rgh', rad), gi = $e('img', '', gh);
      gi.src = st.url; gi.style.width = st.W + 'px'; gi.style.height = st.H + 'px';
      const ms = Math.max(220, c.postMs * 1.1);
      const morph = morphBox(gh, gi, r, { x: ccx - D / 2, y: ccy - D / 2, w: D, h: D }, c.frameR, D / 2, RS.spring(ms, Math.min(c.bounce || 0, 25)));
      if (c.flash) RS.anim(flash, { opacity: [0, .8, 0] }, { duration: .26 });
      // the middle and the ring of buttons
      const mid = $e('div', 'rc' + (c.radThumb ? ' th' : ''), rad);
      Object.assign(mid.style, { left: ccx - D / 2 + 'px', top: ccy - D / 2 + 'px', width: D + 'px', height: D + 'px' });
      mid.innerHTML = `<div class="rcb"></div><div class="rci"><span class="rk">${CHECK}</span><b></b></div><div class="rsp"></div>`;
      const list = RADS.filter(a => !a.ai || st.ai);
      const n = list.length, start = -90, step = c.radSpin === 'arc' ? Math.min(42, 300 / n) : 360 / n;
      const a0 = c.radSpin === 'arc' ? start - step * (n - 1) / 2 + 180 : start;
      const btns = list.map((a, i) => {
        const ang = (a0 + step * i) * Math.PI / 180, x = ccx + Math.cos(ang) * RO, y = ccy + Math.sin(ang) * RO;
        const btn = $e('button', 'ro' + (a.id === 'close' ? ' cl' : ''), rad);
        btn.dataset.a = a.id;
        const cs = Math.cos(ang), sn = Math.sin(ang), lt = `translate:calc(-50% + ${(cs * 50).toFixed(1)}% + ${(cs * 28).toFixed(1)}px) calc(-50% + ${(sn * 50).toFixed(1)}% + ${(sn * 28).toFixed(1)}px)`;
        btn.innerHTML = RS.ic(a.icon) + (c.radLabels ? `<span class="rl" style="${lt}">${a.t}</span>` : `<span class="tt">${a.t}</span>`);
        btn.style.left = x - 20 + 'px'; btn.style.top = y - 20 + 'px';
        btn._d = { x: ccx - x, y: ccy - y };
        return btn;
      });
      st._rad = { mid, btns, gh, ccx, ccy, D };
      rad.classList.add('on');
      await morph;
      RS.anim(mid, { opacity: [0, 1], scale: [.92, 1] }, RS.spring(260, 30));
      await Promise.all(btns.map((btn, i) => new Promise(res => setTimeout(() => {
        RS.anim(btn, { x: [btn._d.x, 0], y: [btn._d.y, 0], scale: [.3, 1], opacity: [0, 1] }, RS.spring(380, c.bounce)).then(res);
      }, c.radSpin === 'all' ? 0 : i * 38))));
    };
    st.radBusy = id => {
      const R = st._rad; if (!R) return;
      R.mid.classList.add('busy'); R.mid.classList.remove('ok', 'bad');
      R.btns.forEach(b => b.classList.toggle('act', b.dataset.a === id));
    };
    st.radDone = (id, ok, text) => {
      const R = st._rad; if (!R) return;
      const a = RADS.find(x => x.id === id) || {};
      R.mid.classList.remove('busy');
      R.mid.querySelector('b').textContent = text || (ok ? a.done || 'Готово' : 'Не получилось');
      R.mid.classList.remove('ok', 'bad'); void R.mid.offsetWidth;
      R.mid.classList.add(ok ? 'ok' : 'bad');
      R.btns.forEach(b => { b.classList.remove('act'); if (ok && b.dataset.a === id) b.classList.add('dn'); });
      const ci = R.mid.querySelector('.rci'), kk = ci.querySelector('.rk'), bb = ci.querySelector('b'), pth = kk.querySelector('path');
      ci.style.opacity = 1;
      RS.anim(kk, { scale: [.4, 1], opacity: [0, 1] }, RS.spring(340, 45));
      RS.anim(bb, { opacity: [0, 1], y: [6, 0], filter: ['blur(4px)', 'blur(0px)'] }, RS.spring(300, 0));
      if (pth) RS.anim(pth, { strokeDashoffset: ok ? [1, 0] : [0, 0] }, { duration: .38, delay: .06, ease: [.4, 0, .2, 1] });
    };
    st.radClose = async () => {
      const R = st._rad; if (!R) return;
      st._rad = null;
      const c = st.c, sp = RS.spring(Math.max(180, c.postMs * .6), 0);
      await Promise.all(R.btns.map(b => RS.anim(b, { x: [0, b._d.x], y: [0, b._d.y], scale: [1, .3], opacity: [1, 0] }, { duration: .18 })));
      await Promise.all([
        RS.anim(R.mid, { scale: [1, .5], opacity: [1, 0] }, sp),
        RS.anim(R.gh, { scale: [1, .5], opacity: [1, 0] }, sp),
        RS.anim(shade, { opacity: [1, 0] }, { duration: .22 })
      ]);
      rad.classList.remove('on'); rad.innerHTML = '';
    };

    // ---------------- the capsule: the selection flows into a pill with the result and a few buttons
    cap.addEventListener('pointerdown', e => e.stopPropagation());
    cap.addEventListener('click', e => { const b = e.target.closest('button'); if (b && st.onCap) st.onCap(b.dataset.a); });
    cap.addEventListener('pointerenter', () => st.onCapHover && st.onCapHover(true));
    cap.addEventListener('pointerleave', () => st.onCapHover && st.onCapHover(false));
    const CAPS = { copy: ['copy', 'Копировать', 'Изображение скопировано'], save: ['floppy-disk', 'Сохранить', 'Сохранено'], ocr: ['text-t', 'Текст', 'Текст скопирован'], ai: ['sparkle', 'ИИ', 'Ответ ИИ скопирован'] };
    const hoverFx = b => {
      const x = b.classList.contains('x');
      b.addEventListener('pointerenter', () => RS.anim(b, { backgroundColor: x ? 'rgba(255,122,107,.9)' : 'rgba(255,255,255,.16)', color: '#ffffff', scale: 1.05 }, RS.spring(200, 30)));
      b.addEventListener('pointerleave', () => RS.anim(b, { backgroundColor: x ? 'rgba(255,255,255,0)' : 'rgba(255,255,255,.07)', color: x ? 'rgba(255,255,255,.5)' : '#ffffff', scale: 1 }, RS.spring(220, 0)));
      b.addEventListener('pointerdown', () => RS.anim(b, { scale: .94 }, RS.spring(120, 0)));
      b.addEventListener('pointerup', () => RS.anim(b, { scale: 1.05 }, RS.spring(200, 40)));
    };
    st.capOpen = async (pos, mons, first) => {
      const c = st.c, r = st.r; if (!r) return;
      fr.style.visibility = 'hidden'; lab.classList.remove('on'); st.bar(false); mag.classList.remove('on'); el.classList.remove('crs', 'soft');
      el.classList.add('nohole');
      const acts = ['copy', 'save', 'ocr', 'ai'].filter(a => a !== first && (a !== 'ai' || st.ai));
      const msg = !first || first === 'none' ? 'Снимок готов' : CAPS[first][2];
      const p = $e('div', 'cp', cap);
      p.innerHTML = `<div class="cpb"></div><div class="cpi"><span class="ck">${CHECK}<i></i></span><span class="ct"><b>${msg}</b><small>${Math.round(r.w * st.dpr)} × ${Math.round(r.h * st.dpr)}</small></span>` +
        acts.map(a => `<button class="cb${a === 'ai' ? ' i' : ''}" data-a="${a}" title="${CAPS[a][1]}">${RS.ic(CAPS[a][0])}${a === 'ai' ? '' : `<span>${CAPS[a][1]}</span>`}</button>`).join('') +
        `<button class="cb i x" data-a="close" title="Закрыть">${RS.ic('x')}</button></div>`;
      const inner = p.querySelector('.cpi'), bg = p.querySelector('.cpb');
      inner.querySelectorAll('.cb').forEach(hoverFx);
      cap.classList.add('on'); // the layer is hidden until then, and a hidden pill measures as zero
      // the font must be there before measuring, or the last button gets cut off
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise(res => setTimeout(res, 150))]);
      const Wc = Math.max(420, Math.ceil(inner.getBoundingClientRect().width) + 2), Hc = 60;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const m = (mons || []).find(q => cx >= q.x && cy >= q.y && cx < q.x + q.w && cy < q.y + q.h) || { x: 0, y: 0, w: st.W, h: st.H };
      let x = cx - Wc / 2, y = cy - Hc / 2;
      if (pos === 'bottom') { x = m.x + m.w / 2 - Wc / 2; y = m.y + m.h - Hc - Math.max(16, Math.min(72, m.h * .08)); }
      else if (pos === 'top') { x = m.x + m.w / 2 - Wc / 2; y = m.y + Math.max(12, Math.min(48, m.h * .05)); }
      x = Math.max(m.x + 10, Math.min(m.x + m.w - Wc - 10, x)); y = Math.max(m.y + 10, Math.min(m.y + m.h - Hc - 10, y));
      const C = { x, y, w: Wc, h: Hc }, T = { x: x + 8, y: y + 8, w: 68, h: 44 };
      const gh = $e('div', 'ghost cpg', cap), gi = $e('img', '', gh);
      gi.src = st.url; gi.style.width = st.W + 'px'; gi.style.height = st.H + 'px';
      inner.style.opacity = 0;
      const R = st._cap = { p, gh, inner, pos, C, T };
      cap.classList.add('on');
      const L = (a, b, t) => a + (b - a) * t;
      const ms = Math.max(260, c.postMs * 1.15);
      if (c.flash) RS.anim(flash, { opacity: [0, .7, 0] }, { duration: .26 });
      const so = +getComputedStyle(shade).opacity;
      if (so > 0) RS.anim(shade, { opacity: [so, 0] }, { duration: Math.min(.4, ms / 1000), ease: [.3, 0, .2, 1] });
      await morphBox(gh, gi, r, T, c.frameR, 13, RS.spring(ms, Math.min(c.bounce || 0, 22)), t => {
        const q = Math.max(0, Math.min(1, t));
        p.style.left = L(r.x, C.x, t) + 'px'; p.style.top = L(r.y, C.y, t) + 'px';
        p.style.width = Math.max(1, L(r.w, C.w, t)) + 'px'; p.style.height = Math.max(1, L(r.h, C.h, t)) + 'px';
        p.style.borderRadius = L(c.frameR, 30, q) + 'px';
        p.style.boxShadow = `0 18px 50px rgba(0,0,0,${(.45 * q).toFixed(3)})`;
        bg.style.opacity = Math.min(1, q * 1.6);
      });
      if (st._cap !== R) return;
      const ck = inner.querySelector('.ck'), tx = inner.querySelector('.ct'), bs = [...inner.querySelectorAll('.cb')], pth = ck.querySelector('path');
      ck.style.opacity = 0; tx.style.opacity = 0; bs.forEach(b => b.style.opacity = 0);
      inner.style.opacity = 1;
      RS.anim(ck, { scale: [.3, 1], opacity: [0, 1] }, RS.spring(360, 45));
      if (pth) RS.anim(pth, { strokeDashoffset: [1, 0] }, { duration: .36, delay: .1, ease: [.4, 0, .2, 1] });
      RS.anim(tx, { opacity: [0, 1], x: [-8, 0], filter: ['blur(4px)', 'blur(0px)'] }, RS.spring(320, 0));
      await Promise.all(bs.map((b, i) => new Promise(res => setTimeout(() => {
        RS.anim(b, { opacity: [0, 1], x: [-10, 0], scale: [.9, 1] }, RS.spring(300, 20)).then(res, res);
      }, 60 + i * 45))));
    };
    st.capBusy = id => {
      const R = st._cap; if (!R) return;
      R.inner.querySelector('.ck').classList.add('busy');
      R.inner.querySelectorAll('.cb').forEach(b => b.classList.toggle('act', b.dataset.a === id));
    };
    st.capDone = (id, ok, text) => {
      const R = st._cap; if (!R) return;
      const ck = R.inner.querySelector('.ck'), b = R.inner.querySelector('.ct b'), pth = ck.querySelector('path');
      ck.classList.remove('busy'); ck.classList.toggle('bad', !ok);
      R.inner.querySelectorAll('.cb').forEach(x => { x.classList.remove('act'); if (ok && x.dataset.a === id) x.classList.add('dn'); });
      b.textContent = text || (ok ? (CAPS[id] || [])[2] || 'Готово' : 'Не получилось');
      RS.anim(b, { opacity: [0, 1], y: [5, 0], filter: ['blur(3px)', 'blur(0px)'] }, RS.spring(280, 0));
      RS.anim(ck, { scale: [.6, 1] }, RS.spring(320, 50));
      if (pth && ok) RS.anim(pth, { strokeDashoffset: [1, 0] }, { duration: .34, ease: [.4, 0, .2, 1] });
    };
    st.capClose = async () => {
      const R = st._cap; if (!R) return;
      st._cap = null;
      const dy = R.pos === 'top' ? -14 : 14;
      R.gh.style.transformOrigin = `${R.C.x + R.C.w / 2 - R.T.x}px ${R.C.y + R.C.h / 2 - R.T.y}px`;
      await Promise.all([R.p, R.gh].map(x => RS.anim(x, { opacity: [1, 0], y: [0, dy], scale: [1, .94], filter: ['blur(0px)', 'blur(4px)'] }, RS.spring(260, 0))));
      cap.classList.remove('on'); cap.innerHTML = '';
    };
    st.shadeOff = () => { shade.style.opacity = 0; };

    st.hint = html => { if (html) hint.innerHTML = html; hint.classList.toggle('on', !!html); };

    const tint = el.querySelector('.tint');
    st.introPrep = (cxp, cyp) => {
      const c = st.c;
      if (c.appear === 'none') return;
      if (c.appear === 'zoom') el.style.opacity = 0;
      else if (c.appear === 'wave') shade.style.clipPath = `circle(0px at ${cxp}px ${cyp}px)`;
      else tint.style.opacity = 0;
    };
    st.intro = (cxp, cyp) => {
      const c = st.c, ms = Math.max(40, c.appearMs);
      const done = () => { el.style.opacity = ''; tint.style.opacity = ''; shade.style.clipPath = ''; };
      setTimeout(done, ms * 2 + 400); // the dim always ends up on, even if an animation never reports back
      if (c.appear === 'none') return done();
      if (c.appear === 'wave') {
        const R = Math.hypot(Math.max(cxp, st.W - cxp), Math.max(cyp, st.H - cyp));
        const a = shade.animate ? shade.animate([{ clipPath: `circle(0px at ${cxp}px ${cyp}px)` }, { clipPath: `circle(${R}px at ${cxp}px ${cyp}px)` }], { duration: ms * 1.6, easing: 'cubic-bezier(.3,.7,.2,1)' }) : null;
        shade.style.clipPath = '';
        RS.anim(tint, { opacity: [0, 1] }, { duration: ms * 1.6 / 1000 });
        return a ? a.finished.then(done, done) : done();
      }
      if (c.appear === 'zoom') return RS.anim(el, { opacity: [0, 1], scale: [1.015, 1] }, RS.spring(ms * 1.4, 0)).then(done, done);
      return RS.anim(tint, { opacity: [0, 1] }, { duration: ms / 1000, ease: [.2, .8, .2, 1] }).then(done, done);
    };

    // the snapshot leaves the screen; target: where the corner card will be
    st.outro = async (kind, target) => {
      const c = st.c, r = st.r;
      if (!r || kind === 'none') return;
      const gh = $e('div', 'ghost', el), gi = $e('img', '', gh);
      gi.src = st.url; gi.style.width = st.W + 'px'; gi.style.height = st.H + 'px'; gi.style.transform = `translate(${-r.x}px,${-r.y}px)`;
      Object.assign(gh.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', borderRadius: c.frameR + 'px' });
      fr.style.visibility = 'hidden'; lab.classList.remove('on'); st.bar(false); mag.classList.remove('on'); el.classList.remove('crs');
      el.classList.add('nohole');
      const sp = RS.spring(c.postMs, c.bounce);
      const ps = [];
      if (c.flash) ps.push(RS.anim(flash, { opacity: [0, .8, 0] }, { duration: .26 }));
      ps.push(RS.anim(shade, { opacity: [1, 0] }, { duration: Math.min(.35, c.postMs / 1000) }));
      const ccx = r.x + r.w / 2, ccy = r.y + r.h / 2;
      if (kind === 'fly') {
        const t = target || { x: st.W - 150, y: st.H - 110 };
        const s = Math.min(1, 220 / Math.max(r.w, r.h * 1.4));
        gh.style.boxShadow = '0 18px 50px rgba(0,0,0,.45)';
        await RS.anim(gh, { x: [0, t.x - ccx], y: [0, t.y - ccy], scale: [1, s], borderRadius: [c.frameR + 'px', 12 / s + 'px'] }, sp);
        await RS.anim(gh, { opacity: [1, 0], scale: [s, s * .92] }, { duration: .14 });
      } else if (kind === 'shrink') {
        await RS.anim(gh, { scale: [1, 0], opacity: [1, 0] }, sp);
      } else if (kind === 'pop') {
        await RS.anim(gh, { scale: [1, 1.05] }, RS.spring(c.postMs * .4, 50));
        await RS.anim(gh, { scale: [1.05, .2], opacity: [1, 0] }, { duration: c.postMs / 1600 });
      } else if (kind === 'peel') {
        gh.style.boxShadow = '0 24px 60px rgba(0,0,0,.5)';
        await RS.anim(gh, { rotate: [0, -3], y: [0, -14], scale: [1, 1.03] }, RS.spring(c.postMs * .5, c.bounce));
        await RS.anim(gh, { rotate: [-3, 7], y: [-14, st.H - r.y + 40], opacity: [1, .9] }, { duration: c.postMs / 1000, ease: [.5, 0, .9, .4] });
      } else if (kind === 'drop') {
        await RS.anim(gh, { y: [0, 36], scale: [1, .96], opacity: [1, 0] }, sp);
      } else if (kind === 'up') {
        await RS.anim(gh, { y: [0, -(r.y + r.h + 40)], opacity: [1, .8] }, sp);
      } else {
        await RS.anim(gh, { opacity: [1, 0] }, { duration: c.postMs / 1000 });
      }
      await Promise.all(ps);
      gh.remove();
    };

    st.reset = () => {
      st.r = null; st.adj = false;
      el.classList.add('nohole'); el.classList.remove('crs');
      fr.style.visibility = 'hidden'; fr.classList.remove('adj', 'hov');
      lab.classList.remove('on'); mag.classList.remove('on'); st.bar(false); st.hint('');
      st._rad = null; rad.classList.remove('on'); rad.innerHTML = '';
      st._cap = null; cap.classList.remove('on'); cap.innerHTML = ''; el.classList.remove('soft');
      el.style.opacity = ''; tint.style.opacity = ''; shade.style.clipPath = '';
      shade.style.opacity = ''; shade.style.transform = ''; flash.style.opacity = 0;
      for (const a of el.getAnimations ? el.getAnimations({ subtree: true }) : []) { try { a.cancel(); } catch (e) {} }
      el.querySelectorAll('.ghost').forEach(x => x.remove());
    };
    st.handleAt = target => { const h = target && target.closest && target.closest('.h'); return h && st.adj ? h.dataset.h : null; };
    st.reset();
    return st;
  }

  // ---------------------------------------------------------------- a made-up desktop for the previews
  function desktop(W, H, d = 2) {
    const cv = document.createElement('canvas'); cv.width = W * d; cv.height = H * d;
    const x = cv.getContext('2d'); x.scale(d, d);
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1c2b4a'); g.addColorStop(.55, '#2d2250'); g.addColorStop(1, '#4a2238');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (const [cx, cy, r, c] of [[.2, .3, .5, 'rgba(120,170,255,.25)'], [.85, .2, .4, 'rgba(255,140,190,.2)'], [.6, .95, .5, 'rgba(255,190,120,.16)']]) {
      const rg = x.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * W); rg.addColorStop(0, c); rg.addColorStop(1, 'transparent'); x.fillStyle = rg; x.fillRect(0, 0, W, H);
    }
    const rr = (X, Y, w, h, r, f) => { x.beginPath(); x.roundRect(X, Y, w, h, r); x.fillStyle = f; x.fill(); };
    const font = (s, w = 700) => `${w} ${s}px Manrope, Segoe UI, sans-serif`;
    const wins = [];
    // a browser with an article
    let a = { x: W * .05, y: H * .08, w: W * .55, h: H * .76 }; wins.push(a);
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24; x.shadowOffsetY = 8; rr(a.x, a.y, a.w, a.h, 8, '#f6f5f2'); x.shadowColor = 'transparent';
    rr(a.x, a.y, a.w, 22, 8, '#e7e5e0'); x.fillStyle = '#e7e5e0'; x.fillRect(a.x, a.y + 12, a.w, 10);
    for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) { x.beginPath(); x.arc(a.x + 12 + i * 11, a.y + 11, 3.6, 0, 7); x.fillStyle = c; x.fill(); }
    rr(a.x + 50, a.y + 5, a.w * .5, 12, 6, '#fff');
    x.fillStyle = '#9a978f'; x.font = font(7, 600); x.fillText('retocker.app/snap', a.x + 58, a.y + 13.5);
    x.fillStyle = '#1b1b1b'; x.font = font(Math.max(11, a.w * .045), 800); x.fillText('Скриншот за одно', a.x + 18, a.y + 52);
    x.fillText('движение', a.x + 18, a.y + 52 + a.w * .055);
    x.fillStyle = '#6b6860'; x.font = font(Math.max(7, a.w * .022), 600);
    const lines = ['Нажми PrintScreen, выдели область —', 'картинка уже в буфере обмена.', 'Текст со скрина — одной кнопкой.'];
    lines.forEach((l, i) => x.fillText(l, a.x + 18, a.y + 52 + a.w * .11 + i * a.w * .036));
    const iy = a.y + 52 + a.w * .11 + 3 * a.w * .036 + 4;
    const ig = x.createLinearGradient(a.x, iy, a.x + a.w, iy + 60); ig.addColorStop(0, '#ff9a8b'); ig.addColorStop(.5, '#ff6a88'); ig.addColorStop(1, '#a66cff');
    rr(a.x + 18, iy, a.w * .56, Math.max(20, a.y + a.h - iy - 16), 6, ig);
    for (let i = 0; i < 5; i++) rr(a.x + a.w * .64, iy + i * 12, a.w * .3 - (i % 2) * 18, 5, 2.5, '#dcd9d2');
    // a chat
    const b = { x: W * .57, y: H * .2, w: W * .37, h: H * .56 }; wins.unshift(b);
    x.shadowColor = 'rgba(0,0,0,.5)'; x.shadowBlur = 30; x.shadowOffsetY = 10; rr(b.x, b.y, b.w, b.h, 10, '#202124'); x.shadowColor = 'transparent';
    x.fillStyle = 'rgba(255,255,255,.85)'; x.font = font(8.5); x.fillText('Миша', b.x + 30, b.y + 17);
    x.beginPath(); x.arc(b.x + 17, b.y + 14, 7, 0, 7); x.fillStyle = '#7fb4f0'; x.fill();
    x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(b.x, b.y + 28, b.w, 1);
    const bub = [[0, .62, 'скинь скрин ошибки'], [1, .5, 'секунду 👇'], [1, .7, 'Ctrl+V — и готово'], [0, .45, 'ого, быстро']];
    bub.forEach(([me, w, t], i) => {
      const bw = b.w * w, bx = me ? b.x + b.w - bw - 10 : b.x + 10, by = b.y + 38 + i * (b.h - 50) / 4.4;
      rr(bx, by, bw, Math.min(20, (b.h - 50) / 5.2), 9, me ? '#3b6fd8' : '#2f3034');
      x.fillStyle = '#fff'; x.font = font(Math.max(6.5, b.w * .035), 600); x.fillText(t, bx + 8, by + Math.min(20, (b.h - 50) / 5.2) / 2 + 3);
    });
    // the taskbar
    x.fillStyle = 'rgba(20,20,24,.85)'; x.fillRect(0, H - H * .075, W, H * .075);
    for (let i = 0; i < 6; i++) rr(W / 2 - 66 + i * 22, H - H * .06, 14, 14, 4, i === 0 ? '#7fb4f0' : 'rgba(255,255,255,.22)');
    return { url: cv.toDataURL('image/png'), wins, W, H, d };
  }

  // ---------------------------------------------------------------- the looping preview
  // host: an element with a size; get(): the current settings; o.outro: play the leaving animation too
  function demo(host, get, o = {}) {
    host.innerHTML = '';
    host.style.position = host.style.position || 'relative';
    const W = host.clientWidth || 600, H = host.clientHeight || 280;
    const dk = desktop(W, H);
    const st = make(host);
    st.ai = true;
    const cur = $e('div', 'dcur', host);
    cur.innerHTML = '<svg viewBox="0 0 20 20"><path d="M10 1v6M10 13v6M1 10h6M13 10h6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M10 1v6M10 13v6M1 10h6M13 10h6" stroke="rgba(0,0,0,.5)" stroke-width="3.2" stroke-linecap="round" style="mix-blend-mode:multiply" opacity=".4"/></svg>';
    let alive = true, run = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const mv = (x, y) => { cur.style.transform = `translate(${x - 10}px,${y - 10}px)`; };
    async function tween(ms, fn) { const t0 = performance.now(); for (;;) { const t = Math.min(1, (performance.now() - t0) / ms); fn(ease(t)); if (t >= 1) return; await new Promise(r => requestAnimationFrame(r)); } }
    async function loop(id) {
      await st.frame(dk.url, W, H, dk.d);
      st.cfg(get());
      const ok = () => alive && id === run;
      while (ok()) {
        const c = get();
        st.reset(); st.cfg(c); st.intro(W * .3, H * .3);
        const A = { x: W * .12, y: H * .22 }, B = { x: W * .48, y: H * .64 };
        let p = { x: W * .78, y: H * .12 };
        // hover over the chat window: it lights up whole
        await tween(700, t => { const x = p.x + (W * .74 - p.x) * t, y = p.y + (H * .46 - p.y) * t; mv(x, y); st.cursor(x, y, true); if (c.snapWin && t > .3) st.hover(dk.wins[0]); });
        if (!ok()) return; await sleep(450);
        st.hover(null);
        await tween(600, t => { const x = W * .74 + (A.x - W * .74) * t, y = H * .46 + (A.y - H * .46) * t; mv(x, y); st.cursor(x, y, true); });
        if (!ok()) return;
        await tween(900, t => { const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t; mv(x, y); st.cursor(x, y, true); st.select({ x: A.x, y: A.y, w: x - A.x, h: y - A.y }, false); });
        if (!ok()) return;
        st.cursor(B.x, B.y, false);
        st.select({ x: A.x, y: A.y, w: B.x - A.x, h: B.y - A.y }, true);
        if (c.toolbar === 'capsule') {
          cur.style.opacity = 0;
          const a = c.capAct || 'copy', nx = a === 'save' ? 'copy' : 'save';
          await st.capOpen(c.capPos || 'place', null, a);
          if (!ok()) return;
          await sleep(900);
          if (!ok()) return;
          st.capBusy(nx); await sleep(300); st.capDone(nx, true);
          await sleep(o.outro ? 1500 : 2000);
          if (!ok()) return;
          await st.capClose();
          if (o.onDone) o.onDone();
          await sleep(700);
          cur.style.opacity = '';
          continue;
        }
        if (c.toolbar === 'radial') {
          cur.style.opacity = 0;
          await st.radOpen();
          if (!ok()) return;
          await sleep(350);
          const first = c.radAct && c.radAct !== 'none' ? c.radAct : 'save';
          st.radBusy(first); await sleep(260); st.radDone(first, true);
          await sleep(o.outro ? 1800 : 2400);
          if (!ok()) return;
          await st.radClose();
          if (o.onDone) o.onDone();
          await sleep(700);
          cur.style.opacity = '';
          continue;
        }
        if (c.toolbar !== 'instant') st.bar(true);
        await sleep(o.outro ? 1100 : 2200);
        if (!ok()) return;
        if (o.outro) {
          cur.style.opacity = 0;
          await st.outro(c.post, { x: W - 70, y: H - 52 });
          if (o.onDone) o.onDone();
          await sleep(900);
          cur.style.opacity = '';
        }
      }
    }
    loop(++run);
    return {
      st,
      update() { st.cfg(get()); },
      restart() { loop(++run); },
      stop() { alive = false; host.innerHTML = ''; }
    };
  }

  window.FX = { make, desktop, demo, ACTS, RADS };
})();
