'use strict';
// The settings window. Every option is saved at once and the live example on top redraws with it.
(async () => {
  const $ = id => document.getElementById(id);
  const { invoke, listen, esc, ic } = RS;
  await RS.load();
  const S = () => RS.S;
  const set = (k, v) => { RS.set({ [k]: v }); afterSet(k); };
  let info = {}, cur = 'home', dm = null, dmKind = '';

  // icons in the menu
  document.querySelectorAll('.ni').forEach(b => b.insertAdjacentHTML('afterbegin', ic(b.dataset.i)));
  document.querySelectorAll('.wb').forEach(b => b.onclick = () => invoke('win_ctl', { a: b.dataset.w }).catch(() => {}));
  document.querySelectorAll('.ni').forEach(b => b.onclick = () => go(b.dataset.p));

  let tt = 0;
  function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2200); }

  // ---------------------------------------------------------- building blocks
  const H = (title, sub) => `<div class="ph"><h1>${title}</h1>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const sec = t => `<div class="sec">${t}</div>`;
  const lbl = (t, s) => `<div class="lbl"><span class="t">${t}</span>${s ? `<small>${s}</small>` : ''}</div>`;
  const sw = (k, t, s) => `<label class="row" data-row="${k}">${lbl(t, s)}<input type="checkbox" class="sw" data-k="${k}"></label>`;
  const seg = (k, t, s, opts) => `<div class="row" data-row="${k}">${lbl(t, s)}<div class="seg" data-k="${k}">${opts.map(([v, n]) => `<button data-v="${esc(v)}">${n}</button>`).join('')}</div></div>`;
  const rng = (k, t, s, min, max, step, unit) => `<div class="row col" data-row="${k}"><div class="rt">${lbl(t, s)}<span class="val" data-val="${k}" data-u="${unit || ''}"></span></div><input type="range" class="rng" data-k="${k}" min="${min}" max="${max}" step="${step}"></div>`;
  const COLS = ['#ffffff', '#ebebea', '#7fb4f0', '#5fcf98', '#ffd166', '#ff7a6b', '#ff6ad5', '#b49cf0', '#000000'];
  const col = (k, t, s, list) => `<div class="row col" data-row="${k}"><div class="rt">${lbl(t, s)}<span class="swn" data-val="${k}"></span></div><div class="sws" data-k="${k}">${(list || COLS).map(c => `<button class="swc" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('')}<label class="swc pick" title="Свой цвет"><input type="color" data-pick="${k}"></label></div></div>`;
  const inp = (k, t, s, ph, type) => `<div class="row col" data-row="${k}">${lbl(t, s)}<div class="fld"><input class="in" data-k="${k}" type="${type || 'text'}" placeholder="${esc(ph || '')}" spellcheck="false">${type === 'password' ? `<button class="eye" data-eye="${k}">${ic('eye')}</button>` : ''}</div></div>`;
  const hk = (k, t, s) => `<div class="row" data-row="${k}">${lbl(t, s)}<button class="hk" data-hk="${k}"></button></div>`;
  const tiles = (k, n, list, sample) => `<div class="tiles" style="--n:${n}" data-k="${k}">${list.map(([v, name]) => `<button class="tile" data-v="${v}">${sample(v)}<span>${name}</span></button>`).join('')}</div>`;

  // ---------------------------------------------------------- pages
  const P = {};
  P.home = () => `
    <div class="hero2"><div class="cap" id="cap"><small>PrtSc</small>Print<br>Screen</div>
      <div><h2>Нажми PrintScreen и выдели область</h2><p>Снимок сразу окажется в буфере обмена. Наведи на окно и кликни — снимется окно целиком.<br><kbd>Enter</kbd> копировать · <kbd>Ctrl+S</kbd> сохранить · <kbd>T</kbd> текст · <kbd>Esc</kbd> отмена</p></div></div>
    <div class="quick">
      <button class="qb" data-snap="area"><span class="ico">${ic('selection')}</span><span><b>Область</b><small id="q-area"></small></span></button>
      <button class="qb" data-snap="full"><span class="ico">${ic('monitor')}</span><span><b>Весь экран</b><small id="q-full"></small></span></button>
      <button class="qb" data-snap="text"><span class="ico">${ic('text-t')}</span><span><b>Текст с экрана</b><small id="q-text"></small></span></button>
    </div>
    ${sec('Последние снимки')}<div class="hgrid" id="homeHist"></div>`;

  const selSample = v => `<span class="sm"><span class="sel ${v}"></span></span>`;
  P.sel = () => H('Рамка выделения', 'как выглядит выбранная область') +
    sec('Стиль') + tiles('frame', 3, [['solid', 'Линия'], ['dashed', 'Пунктир'], ['ants', 'Бегущий пунктир'], ['corners', 'Уголки'], ['neon', 'Свечение'], ['none', 'Без рамки']], selSample) +
    col('frameColor', 'Цвет рамки') +
    rng('frameW', 'Толщина', '', .5, 5, .5, 'px') +
    rng('frameR', 'Скругление углов', 'и у рамки, и у самого выделения на экране', 0, 24, 1, 'px') +
    rng('frameGlow', 'Свечение линии', '0 — без свечения', 0, 30, 1, 'px') +
    sw('frameShadow', 'Мягкая тень', 'рамку видно даже на белом фоне') +
    sec('Углы для растягивания') +
    tiles('handles', 4, [['circle', 'Кружки'], ['square', 'Квадраты'], ['bar', 'Полоски'], ['none', 'Скрыть']], v => `<span class="hsm ${v}"><i></i></span>`) +
    rng('handleSize', 'Размер углов', '', 5, 16, 1, 'px');

  P.bg = () => H('Фон', 'что происходит с экраном вокруг выделения') +
    rng('dim', 'Затемнение', '0 — экран не темнеет', 0, 90, 1, '%') +
    col('dimColor', 'Цвет затемнения', '', ['#000000', '#101828', '#1a1033', '#2a0f14', '#0f2a1f', '#ffffff']) +
    rng('blur', 'Размытие', 'фон как сквозь матовое стекло', 0, 24, 1, 'px') +
    sw('gray', 'Чёрно-белый фон', 'цветной остаётся только выделение') +
    sec('Появление') +
    seg('appear', 'Как появляется затемнение', '', [['fade', 'Плавно'], ['wave', 'Волна от курсора'], ['zoom', 'Наезд'], ['none', 'Сразу']]) +
    rng('appearMs', 'Скорость появления', '', 60, 500, 10, 'мс');

  P.help = () => H('Помощники', 'чтобы попадать точно в пиксель') +
    sw('snapWin', 'Прилипание к окнам', 'навёл на окно — оно подсветилось, клик — снялось целиком') +
    sw('cross', 'Перекрестие', 'линии через весь экран от курсора') +
    seg('crossStyle', 'Вид перекрестия', '', [['line', 'Линия'], ['dash', 'Пунктир'], ['color', 'Цветом рамки']]) +
    sec('Лупа') +
    sw('mag', 'Лупа у курсора', 'увеличенные пиксели под курсором') +
    rng('magZoom', 'Увеличение', '', 3, 16, 1, '×') +
    rng('magSize', 'Размер лупы', '', 80, 200, 4, 'px') +
    seg('magShape', 'Форма', '', [['circle', 'Круг'], ['square', 'Квадрат']]) +
    sw('hex', 'Цвет пикселя', 'HEX-код и координаты под лупой') +
    sec('Размер') +
    seg('sizeLabel', 'Подпись размера', 'ширина × высота в настоящих пикселях', [['corner', 'Над рамкой'], ['inside', 'Внутри'], ['off', 'Скрыть']]);

  const OUT = [['fly', 'Улёт в угол'], ['shrink', 'Сжатие'], ['pop', 'Хлопок'], ['peel', 'Отклеить'], ['drop', 'Опустить'], ['up', 'Вверх'], ['fade', 'Растворить'], ['none', 'Без анимации']];
  const ACT = [['copy', 'Копировать'], ['save', 'Сохранить'], ['ocr', 'Текст']];
  P.after = () => H('После снимка', 'панель, анимация и карточка в углу') +
    sec('Панель с кнопками') +
    seg('toolbar', 'Когда отпускаешь мышь', '', [['auto', 'Показать панель'], ['instant', 'Сразу действие']]) +
    seg('instantAction', 'Действие сразу', 'также по двойному клику внутри выделения', ACT) +
    seg('barStyle', 'Вид панели', '', [['pill', 'Капсула'], ['square', 'Прямая'], ['light', 'Светлая']]) +
    sw('barLabels', 'Подписи на кнопках', 'не только иконки') +
    sec('Анимация снимка') +
    tiles('post', 4, OUT, v => `<span class="sm" style="--a:o-${v}"><span class="dm"></span><span class="gh"></span></span>`) +
    rng('postMs', 'Длительность', '', 150, 1200, 10, 'мс') +
    rng('bounce', 'Пружинистость', '0 — без отскока', 0, 60, 1, '%') +
    sw('flash', 'Вспышка', 'короткая белая вспышка, как у фотоаппарата') +
    sec('Карточка в углу') +
    sw('cardOn', 'Показывать карточку', 'миниатюра и быстрые кнопки после снимка') +
    seg('cardPos', 'Где', '', [['br', 'Справа внизу'], ['bl', 'Слева внизу'], ['tr', 'Справа сверху'], ['tl', 'Слева сверху']]) +
    rng('cardSec', 'Сколько висит', 'навёл мышь — не пропадёт', 1, 15, 1, ' с') +
    sec('Вместе') +
    sw('saveAlsoCopy', 'Сохраняя — ещё и копировать') +
    sw('copyAlsoSave', 'Копируя — ещё и сохранять в папку') +
    seg('quickAction', 'Снимок экрана и окна', 'что делают Shift+PrtSc и Alt+PrtSc', ACT.slice(0, 2));

  P.save = () => H('Сохранение', 'куда и как писать файлы') +
    `<div class="row col">${lbl('Папка', '')}<div class="fld"><input class="in" data-k="saveDir" id="saveDir" spellcheck="false"><button class="btn" id="openDir">${ic('folder-open')}Открыть</button></div></div>` +
    seg('saveFmt', 'Формат', 'PNG — без потерь, JPG — легче', [['png', 'PNG'], ['jpg', 'JPG']]) +
    rng('saveQ', 'Качество JPG', '', 50, 100, 1, '%') +
    `<div class="row col">${lbl('Имя файла', '')}<input class="in" data-k="saveName" spellcheck="false"><div class="tchips" id="tchips">${['{date}', '{time}', '{yyyy}', '{MM}', '{dd}', '{HH}', '{mm}', '{ss}', '{w}', '{h}', '{n}'].map(t => `<button data-t="${t}">${t}</button>`).join('')}</div><div class="nprev" id="nprev"></div></div>`;

  P.text = () => H('Текст со скрина', 'распознавание по кнопке T') +
    `<div class="note">${ic('info')}<div>Без ключа текст читает сама Windows — быстро и без интернета. С ключом <b>Groq</b> появится кнопка «Текст через ИИ»: она понимает таблицы, рукопись и смешанные языки.</div></div>` +
    seg('ocrLang', 'Язык Windows', 'для русского нужен русский языковой пакет в Windows', [['', 'Как в системе'], ['ru', 'Русский'], ['en-US', 'English']]) +
    sw('ocrFallback', 'Если Windows не справилась — спросить ИИ', 'нужен ключ Groq') +
    sec('Groq') +
    inp('groqKey', 'Ключ Groq', 'бесплатно на console.groq.com → API Keys', 'gsk_…', 'password') +
    `<div class="row"><div class="status" id="gst"><i></i><span>Ключ не проверен</span></div><div class="btns"><button class="btn" id="gget">${ic('arrow-square-out')}Получить ключ</button><button class="btn pri" id="gtest">Проверить</button></div></div>` +
    `<details class="det"><summary>Для опытных</summary><div class="body">` +
    inp('groqModel', 'Модель', 'должна понимать картинки', RS.DEF.groqModel) +
    `<div class="row col">${lbl('Инструкция для ИИ', '')}<textarea class="in" data-k="groqPrompt" rows="3"></textarea></div>` +
    inp('groqProxy', 'Прокси', 'если Groq не открывается из твоей сети — тот же адрес, что в Retocker Voice', 'https://script.google.com/macros/s/…/exec') +
    `</div></details>`;

  P.keys = () => H('Клавиши', 'кликни и нажми новое сочетание') +
    hk('hk_area', 'Снимок области', 'выделить часть экрана или окно') +
    hk('hk_full', 'Весь экран', 'сразу, без выделения') +
    hk('hk_window', 'Активное окно', 'сразу, без выделения') +
    hk('hk_text', 'Текст с экрана', 'выделил — текст в буфере') +
    hk('hk_last', 'Повторить прошлую область', 'та же рамка, новый снимок') +
    `<div class="lead" style="padding:6px 10px"><kbd>Esc</kbd> — отмена записи, <kbd>Backspace</kbd> — убрать сочетание.</div>` +
    sec('Разное') +
    rng('delay', 'Задержка перед снимком', 'чтобы успеть открыть меню или подсказку', 0, 10, 1, ' с') +
    seg('trayClick', 'Клик по иконке в трее', '', [['snap', 'Снимок'], ['settings', 'Настройки']]);

  P.hist = () => H('История', 'все снимки хранятся только у тебя') +
    sw('histOn', 'Запоминать снимки') +
    rng('histLimit', 'Сколько хранить', 'старые удаляются сами', 20, 1000, 10, '') +
    `<div class="row"><span class="lead" id="hcount"></span><button class="btn red" id="hclear">${ic('trash')}Очистить</button></div><div class="hgrid" id="hgrid"></div>`;

  P.app = () => H('Программа', '') +
    `<label class="row">${lbl('Запускать вместе с Windows', 'PrintScreen работает сразу после включения')}<input type="checkbox" class="sw" id="auto"></label>` +
    sw('startHidden', 'Не открывать окно при запуске', 'программа ждёт в трее') +
    seg('iconW', 'Иконки', '', [['light', 'Тонкие'], ['regular', 'Обычные'], ['bold', 'Жирные'], ['fill', 'Залитые']]) +
    sec('Обновления') +
    `<div class="row col upd"><div class="rt"><div class="status" id="ust"><i></i><span>Версия …</span></div><div class="btns"><button class="btn" id="uchk">${ic('arrows-clockwise')}Проверить</button><button class="btn pri" id="uins" hidden>${ic('download-simple')}Обновить</button></div></div><div class="unotes" id="unotes" hidden></div><div class="pbar" id="upb" hidden><b></b></div></div>` +
    sec('Если что-то не так') +
    `<div class="row">${lbl('Журнал', 'пришли его разработчику')}<button class="btn" id="logs">${ic('file-text')}Открыть папку</button></div>` +
    `<div class="row">${lbl('Вернуть всё как было', 'ключ и папка останутся')}<button class="btn red" id="reset">Сбросить настройки</button></div>`;

  for (const k in P) $('p-' + k).innerHTML = P[k]();

  // ---------------------------------------------------------- wiring
  function fill(root = document) {
    const s = S();
    root.querySelectorAll('input.sw[data-k]').forEach(i => i.checked = !!s[i.dataset.k]);
    root.querySelectorAll('.seg[data-k],.tiles[data-k],.sws[data-k]').forEach(g => g.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', String(s[g.dataset.k]).toLowerCase() === b.dataset.v.toLowerCase())));
    root.querySelectorAll('input.rng[data-k]').forEach(i => { i.value = s[i.dataset.k]; paint(i); });
    root.querySelectorAll('[data-val]').forEach(v => { const k = v.dataset.val, x = s[k]; v.textContent = typeof x === 'string' ? x.toUpperCase() : (k === 'histLimit' ? x : x + (v.dataset.u || '')); });
    root.querySelectorAll('input[data-pick]').forEach(i => i.value = s[i.dataset.pick]);
    root.querySelectorAll('input.in[data-k],textarea.in[data-k]').forEach(i => { if (document.activeElement !== i) i.value = s[i.dataset.k] || ''; });
    root.querySelectorAll('[data-hk]').forEach(b => { if (!b.classList.contains('rec')) b.innerHTML = RS.hkKbd(s[b.dataset.hk]); });
    deps();
    const q = (id, k) => { const e = $(id); if (e) e.textContent = RS.hkLabel(s[k]) || '—'; };
    q('q-area', 'hk_area'); q('q-full', 'hk_full'); q('q-text', 'hk_text');
    $('keyDot').hidden = true;
  }
  function paint(i) { i.style.setProperty('--p', ((i.value - i.min) / (i.max - i.min) * 100) + '%'); }
  function deps() {
    const s = S(), dis = (k, off) => document.querySelectorAll(`[data-row="${k}"]`).forEach(r => r.classList.toggle('dis', !!off));
    dis('crossStyle', !s.cross); ['magZoom', 'magSize', 'magShape', 'hex'].forEach(k => dis(k, !s.mag));
    dis('instantAction', s.toolbar !== 'instant'); ['barStyle', 'barLabels'].forEach(k => dis(k, s.toolbar === 'instant'));
    ['cardPos', 'cardSec'].forEach(k => dis(k, !s.cardOn)); dis('saveQ', s.saveFmt !== 'jpg');
    dis('frameGlow', s.frame !== 'solid' && s.frame !== 'neon'); dis('handleSize', s.handles === 'none'); dis('histLimit', !s.histOn);
    ['postMs', 'bounce'].forEach(k => dis(k, s.post === 'none'));
  }

  document.addEventListener('change', e => {
    const i = e.target;
    if (i.matches('input.sw[data-k]')) set(i.dataset.k, i.checked);
    if (i.matches('input[data-pick]')) set(i.dataset.pick, i.value);
  });
  document.addEventListener('input', e => {
    const i = e.target;
    if (i.matches('input.rng[data-k]')) { paint(i); set(i.dataset.k, +i.value); }
    if (i.matches('input.in[data-k],textarea.in[data-k]')) set(i.dataset.k, i.value);
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (b) { const g = b.closest('[data-k]'); if (g && !g.matches('input')) { set(g.dataset.k, b.dataset.v); if (g.dataset.k === 'post' && dm) dm.restart(); } }
    const eye = e.target.closest('[data-eye]');
    if (eye) { const i = eye.parentNode.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; eye.innerHTML = ic(i.type === 'password' ? 'eye' : 'eye-slash'); }
    const sn = e.target.closest('[data-snap]');
    if (sn) invoke('snap_now', { kind: sn.dataset.snap }).catch(err => toast(String(err)));
  });

  let pt = 0;
  function afterSet(k) {
    fill();
    if (dm) dm.update();
    if (k === 'iconW') location.reload();
    if (k === 'saveName' || k === 'saveFmt') namePrev();
    if (k === 'histOn' || k === 'histLimit') { clearTimeout(pt); pt = setTimeout(loadHist, 300); }
  }

  // ---------------------------------------------------------- the live example
  const LIVE = { sel: 1, bg: 1, help: 1, after: 2 };
  function preview(id) {
    const pvw = $('pvw'), on = !!LIVE[id];
    pvw.classList.toggle('on', on);
    if (!on) { if (dm) { dm.stop(); dm = null; dmKind = ''; } return; }
    const kind = LIVE[id] === 2 ? 'after' : 'sel';
    if (dm && dmKind === kind) return;
    if (dm) dm.stop();
    dmKind = kind;
    requestAnimationFrame(() => { dm = FX.demo($('pv'), S, { outro: kind === 'after' }); });
  }

  function go(id) {
    if (!$('p-' + id)) id = 'home';
    cur = id;
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + id));
    document.querySelectorAll('.ni').forEach(b => b.classList.toggle('on', b.dataset.p === id));
    $('scroll').scrollTop = 0;
    preview(id);
    if (id === 'hist' || id === 'home') loadHist();
    if (id === 'save') namePrev();
  }

  // play outro tiles on hover
  document.querySelectorAll('.tiles[data-k="post"] .tile').forEach(t => { t.onmouseenter = () => t.classList.add('play'); t.onmouseleave = () => t.classList.remove('play'); });

  // ---------------------------------------------------------- hotkeys
  let recK = null, held = [];
  const MODS = ['Ctrl', 'Shift', 'Alt', 'Win'];
  document.querySelectorAll('[data-hk]').forEach(b => b.onclick = () => {
    if (recK) stopRec();
    recK = b.dataset.hk; held = [];
    b.classList.add('rec'); b.innerHTML = 'Нажми сочетание…';
    invoke('hk_record', { on: true }).catch(() => {});
  });
  function stopRec() {
    invoke('hk_record', { on: false }).catch(() => {});
    document.querySelectorAll('.hk.rec').forEach(b => b.classList.remove('rec'));
    recK = null; held = []; fill();
  }
  listen('rec', e => {
    if (!recK) return;
    const { name, down, m } = e.payload || {};
    if (m) { if (down) { if (!held.includes(name)) held.push(name); } else held = held.filter(x => x !== name); 
      const b = document.querySelector(`[data-hk="${recK}"]`); if (b) b.innerHTML = held.length ? RS.hkKbd(held.join('+')) + '<span>+ …</span>' : 'Нажми сочетание…'; return; }
    if (!down) return;
    const k = recK;
    if (name === 'Escape' && !held.length) return stopRec();
    if ((name === 'Backspace' || name === 'Delete') && !held.length) { stopRec(); return set(k, ''); }
    const combo = MODS.filter(x => held.includes(x)).concat(name).join('+');
    const clash = ['hk_area', 'hk_full', 'hk_window', 'hk_text', 'hk_last'].find(o => o !== k && S()[o] === combo);
    stopRec();
    if (clash) { RS.set({ [clash]: '' }); toast('Это сочетание снято с другого действия'); }
    set(k, combo);
  });

  // ---------------------------------------------------------- saving
  $('openDir').onclick = () => invoke('open_save_dir').catch(e => toast(String(e)));
  $('tchips').onclick = e => { const t = e.target.closest('[data-t]'); if (!t) return; const i = document.querySelector('input[data-k="saveName"]'); i.value = (i.value + ' ' + t.dataset.t).trim(); set('saveName', i.value); };
  async function namePrev() {
    try { const n = await invoke('name_preview', { tpl: S().saveName }); $('nprev').innerHTML = `Будет так: <b>${esc(n)}.${S().saveFmt}</b>`; } catch (e) { $('nprev').textContent = ''; }
  }
  try { if (!S().saveDir) $('saveDir').placeholder = await invoke('default_save_dir'); } catch (e) {}

  // ---------------------------------------------------------- Groq
  $('gget').onclick = () => invoke('open_url', { url: 'https://console.groq.com/keys' }).catch(() => {});
  $('gtest').onclick = async () => {
    const st = $('gst'), sp = st.querySelector('span'), key = (S().groqKey || '').trim();
    if (!key) { st.className = 'status bad'; sp.textContent = 'Сначала вставь ключ'; return; }
    st.className = 'status wait'; sp.textContent = 'Проверяю…';
    try { await invoke('groq_test', { key, proxy: S().groqProxy || '' }); st.className = 'status ok'; sp.textContent = 'Ключ работает — кнопка «Текст через ИИ» включена'; }
    catch (e) { st.className = 'status bad'; sp.textContent = String(e); }
  };

  // ---------------------------------------------------------- history
  const SNAP = ['http', '//snap.localhost/'].join(':');
  const when = t => { const d = new Date(t), n = new Date(); const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === n.toDateString() ? hm : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm; };
  function card(it, small) {
    const src = SNAP + 'hist/' + encodeURIComponent(it.id) + '.jpg';
    return `<div class="hi" data-id="${esc(it.id)}" style="background-image:url('${src}')">
      ${it.text ? `<span class="tg">${ic('text-t')}текст</span>` : ''}
      <div class="ops"><button data-o="copy" title="Копировать">${ic('copy')}</button><button data-o="text" title="Текст">${ic('text-t')}</button>${small ? '' : `<button data-o="save" title="Сохранить">${ic('floppy-disk')}</button><button data-o="del" class="del" title="Удалить">${ic('trash')}</button>`}</div>
      <div class="meta"><span>${when(it.t)}</span><span>${it.w}×${it.h}</span></div></div>`;
  }
  async function loadHist() {
    let items = [];
    try { items = await invoke('hist_list', { limit: 300 }) || []; } catch (e) {}
    const hg = $('hgrid'), hh = $('homeHist');
    hg.innerHTML = items.length ? items.map(i => card(i)).join('') : '<div class="empty">Пока пусто — нажми PrintScreen</div>';
    hh.innerHTML = items.length ? items.slice(0, 8).map(i => card(i, true)).join('') : '<div class="empty">Здесь появятся твои снимки</div>';
    $('hcount').textContent = items.length ? `${items.length} ${RS.pl(items.length, 'снимок', 'снимка', 'снимков')}` : '';
  }
  document.addEventListener('click', async e => {
    const h = e.target.closest('.hi'); if (!h) return;
    const id = h.dataset.id, o = e.target.closest('[data-o]');
    try {
      if (!o) return invoke('hist_open', { id });
      const a = o.dataset.o;
      if (a === 'copy') { await invoke('hist_copy', { id }); toast('Картинка скопирована'); }
      if (a === 'text') { toast('Распознаю…'); const t = await invoke('hist_text', { id, ai: false }); toast(t && t.trim() ? 'Текст скопирован' : 'Текст не найден'); }
      if (a === 'save') { const p = await invoke('hist_save', { id }); toast('Сохранено: ' + String(p).split(/[\\/]/).pop()); }
      if (a === 'del') { await invoke('hist_del', { id }); RS.anim(h, { opacity: [1, 0], scale: [1, .9] }, { duration: .16 }).then(loadHist); }
    } catch (err) { toast(String(err)); }
  });
  $('hclear').onclick = async () => { if (!confirm('Удалить все снимки из истории?')) return; await invoke('hist_clear').catch(() => {}); loadHist(); };
  listen('hist', () => { if (cur === 'hist' || cur === 'home') loadHist(); });

  // ---------------------------------------------------------- program
  $('auto').onchange = async e => { try { const v = await invoke('autostart', { on: e.target.checked }); e.target.checked = !!v; } catch (err) { toast(String(err)); } };
  $('logs').onclick = () => invoke('open_logs').catch(() => {});
  $('reset').onclick = () => {
    if (!confirm('Сбросить все настройки на обычные?')) return;
    const keep = { groqKey: S().groqKey, saveDir: S().saveDir, groqProxy: S().groqProxy };
    RS.set({ ...RS.DEF, ...keep }); fill(); if (dm) dm.update(); toast('Готово');
  };
  const ust = () => $('ust'), usp = () => $('ust').querySelector('span');
  $('uchk').onclick = async () => {
    ust().className = 'status wait'; usp().textContent = 'Проверяю…';
    try {
      const m = await invoke('upd_check');
      if (m && m.newer) {
        ust().className = 'status ok'; usp().textContent = `Есть новая версия ${m.version}`;
        $('uins').hidden = false; $('updDot').hidden = false;
        if (m.notes) { $('unotes').hidden = false; $('unotes').textContent = m.notes; }
      } else { ust().className = 'status ok'; usp().textContent = `У тебя последняя версия — ${info.version || ''}`; }
    } catch (e) { ust().className = 'status bad'; usp().textContent = 'Не удалось проверить: ' + e; }
  };
  $('uins').onclick = () => { $('uins').disabled = true; invoke('upd_install').catch(e => toast(String(e))); };
  listen('upd', e => {
    const d = e.payload || {}, pb = $('upb');
    if (d.stage === 'down') { pb.hidden = false; pb.querySelector('b').style.width = Math.round((d.p || 0) * 100) + '%'; usp().textContent = 'Скачиваю…'; ust().className = 'status wait'; }
    if (d.stage === 'check') usp().textContent = 'Проверяю подпись…';
    if (d.stage === 'apply') usp().textContent = 'Устанавливаю и перезапускаю…';
    if (d.stage === 'error') { ust().className = 'status bad'; usp().textContent = d.msg || 'Ошибка'; $('uins').disabled = false; pb.hidden = true; }
  });

  async function loadInfo() {
    try { info = await invoke('app_info') || {}; } catch (e) { info = {}; }
    $('auto').checked = !!info.autostart;
    $('nfoot').innerHTML = `<b>Retocker Snap</b><br>версия ${esc(info.version || '—')}`;
    ust().className = 'status'; usp().textContent = `Версия ${info.version || '—'}`;
    if (info.updated) toast('Обновлено до ' + info.updated);
  }

  // the PrintScreen key on the home page
  $('cap').onclick = () => { $('cap').classList.add('dn'); setTimeout(() => $('cap').classList.remove('dn'), 150); invoke('snap_now', { kind: 'area' }).catch(e => toast(String(e))); };

  listen('page', e => go(e.payload || 'home'));
  listen('cfg', e => { Object.assign(RS.S, e.payload || {}); fill(); if (dm) dm.update(); });

  fill();
  loadInfo();
  go(new URLSearchParams(location.search).get('p') || 'home');
  setTimeout(() => $('uchk') && invoke('upd_check').then(m => { if (m && m.newer) $('updDot').hidden = false; }).catch(() => {}), 4000);
})();
