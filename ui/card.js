'use strict';
// The small card in the corner after a shot: what happened, plus quick buttons.
(() => {
  const $ = id => document.getElementById(id);
  const cd = $('cd'), th = $('th'), sz = $('sz'), stl = $('st'), tx = $('tx'), bt = $('bt'), bar = $('bar');
  let cur = null, shown = false, timer = 0, hover = false, left = 0, t0 = 0, cfg = { ...RS.DEF };
  $('x').innerHTML = RS.ic('x', 'bold');
  $('x').onclick = () => hide();

  RS.load().then(c => cfg = c).catch(() => {});
  RS.listen('cfg', e => { cfg = { ...cfg, ...(e.payload || {}) }; });
  RS.listen('card', e => show(e.payload || {}));

  const OK = RS.ic('check', 'bold'), BAD = RS.ic('x', 'bold'), SPIN = RS.ic('circle-notch', 'bold');
  const ACT = { copy: 'Скопировано', save: 'Сохранено', ocr: 'Текст скопирован', ai: 'Текст скопирован' };

  function status(kind, text, small) {
    stl.className = 'st ' + kind;
    stl.querySelector('i').innerHTML = kind === 'bad' ? BAD : kind === 'busy' ? SPIN : OK;
    stl.querySelector('.t').textContent = text;
    stl.querySelector('small').textContent = small || '';
  }
  function btn(icon, label, fn, pri) {
    const b = document.createElement('button');
    if (pri) b.className = 'pri';
    b.innerHTML = RS.ic(icon) + `<span>${label}</span>`;
    b.onclick = async () => { try { await fn(); } catch (e) { status('bad', String(e)); } };
    bt.appendChild(b);
  }

  function show(d) {
    const same = cur && cur.id === d.id;
    cur = d;
    const pos = cfg.cardPos || 'br';
    document.body.className = (pos.includes('l') ? 'l ' : '') + (pos.includes('t') ? 't' : '');
    if (d.thumb) th.style.backgroundImage = 'url("http://snap.localhost/' + d.thumb + '")';
    sz.textContent = d.w && d.h ? `${d.w} × ${d.h}` : '';
    tx.hidden = true; tx.className = 'tx';
    if (d.busy) { status('busy', 'Распознаю текст…'); tx.hidden = false; tx.className = 'tx sh'; tx.textContent = ''; }
    else if (d.error) status('bad', d.error);
    else if (d.text != null) {
      const n = String(d.text).trim();
      status(n ? 'ok' : 'bad', n ? ACT[d.action] || ACT.ocr : 'Текст не найден', n ? `${n.length} ${RS.pl(n.length, 'символ', 'символа', 'символов')}` : '');
      if (n) { tx.hidden = false; tx.textContent = n; }
    } else status('ok', ACT[d.action] || ACT.copy, d.path ? d.path.split(/[\\/]/).pop() : '');
    bt.innerHTML = '';
    btn('copy', 'Картинка', async () => { await RS.invoke('hist_copy', { id: d.id }); status('ok', 'Картинка скопирована'); }, d.action !== 'copy' && !d.text);
    if (d.text) btn('clipboard-text', 'Текст', async () => { await RS.invoke('copy_text', { text: d.text }); status('ok', 'Текст скопирован'); }, true);
    else btn('text-t', 'Текст', async () => { status('busy', 'Распознаю текст…'); const r = await RS.invoke('hist_text', { id: d.id, ai: false }); show({ ...d, text: typeof r === 'string' ? r : (r && r.text) || '', action: 'ocr', busy: false }); });
    if (d.path) btn('folder-open', 'Папка', () => RS.invoke('open_path', { p: d.path, select: true }));
    else btn('floppy-disk', 'Сохранить', async () => { const p = await RS.invoke('hist_save', { id: d.id }); show({ ...d, path: typeof p === 'string' ? p : p && p.path, action: 'save', text: d.text }); });
    if (!shown) {
      shown = true;
      const up = !(pos.includes('t'));
      RS.anim(cd, { opacity: [0, 1], y: [up ? 40 : -40, 0], scale: [.94, 1] }, RS.spring(cfg.postMs || 420, cfg.bounce));
    } else if (!same) RS.anim(cd, { scale: [.97, 1] }, RS.spring(260, 40));
    arm(d.busy ? 0 : (cfg.cardSec || 4) * 1000);
  }

  function arm(ms) {
    clearInterval(timer); left = ms; t0 = performance.now();
    bar.style.transform = 'scaleX(1)';
    if (!ms) { bar.style.opacity = 0; return; }
    bar.style.opacity = 1;
    timer = setInterval(() => {
      if (hover) { t0 = performance.now(); return; }
      const now = performance.now(); left -= now - t0; t0 = now;
      bar.style.transform = `scaleX(${Math.max(0, left / ms)})`;
      if (left <= 0) hide();
    }, 50);
  }
  cd.addEventListener('mouseenter', () => { hover = true; });
  cd.addEventListener('mouseleave', () => { hover = false; });
  th.addEventListener('click', () => { if (cur && cur.path) RS.invoke('open_path', { p: cur.path, select: false }).catch(() => {}); else if (cur) RS.invoke('show_settings', { page: 'hist' }).catch(() => {}); });

  async function hide() {
    clearInterval(timer);
    if (!shown) return;
    shown = false;
    const up = !((cfg.cardPos || 'br').includes('t'));
    await RS.anim(cd, { opacity: [1, 0], y: [0, up ? 24 : -24], scale: [1, .96] }, { duration: .18 });
    RS.invoke('card_hide').catch(() => {});
  }
  addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
})();
