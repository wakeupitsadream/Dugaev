// Ночь: создание и правка.
// Мастер «из поста»: текст анонса → поля формы. Разбирает сервер (правила +
// ИИ, если подключён); без связи — те же правила прямо в браузере. Дальше
// человек проверяет подсвеченные поля, добавляет афишу и публикует.
// Превью справа (на телефоне — кнопкой) показывает страницу глазами гостя.
import {
  $, qsa, state, api, on, emit, visible, reloadEvents, nightById, setNight, phaseOf, phaseLabel, pill, isPublic,
  esc, icon, toast, dialog, confirmDlg, busy, copyText, siteUrl, fmtWhen, fmtDay, plural, rub, coverAttr, coverPh,
} from './core.js';
import { parsePost } from '../post-parse.js';
import { ladderText, waveStates } from '../waves.js';
import {
  emptyForm, toForm, copyForm, applyDraft, toBody, validate, rangeOf, WAVE_TEMPLATES, PROGRAM_IDEAS,
} from './event-model.js';
import { startBroadcast } from './promo.js';

const ed = {
  mode: 'new', // new | copy | edit
  id: null, // id сохранённой ночи
  status: 'draft', // статус в базе
  srcTitle: '',
  f: emptyForm(),
  base: '',
  localPoster: null, // картинка до загрузки на сервер — показываем сразу
  uploading: 0,
  uploadSeq: 0,
  analysis: null,
  magicOpen: true,
};

const form = () => $('ed-form');
const snap = () => JSON.stringify(toBody(ed.f, { id: ed.id, status: '' }));
export const isDirty = () => visible('editor') && ed.base !== snap();

export async function canLeave() {
  if (!isDirty()) return true;
  return confirmDlg({
    title: 'Уйти без сохранения?',
    text: 'Изменения в этой ночи пропадут.',
    ok: 'Уйти', cancel: 'Остаться', danger: true,
  });
}

// ---------- открытие ----------
export async function show(params) {
  bindOnce();
  clearErrors();
  clearMarks();
  ed.analysis = null;
  if (ed.localPoster) URL.revokeObjectURL(ed.localPoster);
  ed.localPoster = null;

  if (params.mode === 'edit' || params.mode === 'copy') {
    let ev = nightById(params.id);
    if (!ev) {
      await reloadEvents();
      ev = nightById(params.id);
    }
    if (!ev) {
      toast('Такой ночи нет — возможно, её удалили', 'err');
      location.hash = '#events';
      return;
    }
    if (params.mode === 'edit') {
      ed.mode = 'edit';
      ed.id = ev.id;
      ed.status = ev.status;
      ed.f = toForm(ev);
      ed.magicOpen = false;
    } else {
      ed.mode = 'copy';
      ed.id = null;
      ed.status = 'draft';
      ed.srcTitle = ev.title;
      ed.f = copyForm(ev);
      ed.magicOpen = false;
    }
  } else {
    ed.mode = 'new';
    ed.id = null;
    ed.status = 'draft';
    ed.f = emptyForm();
    ed.magicOpen = true;
  }
  ed.base = snap();
  $('ed-post').value = '';
  renderAll();
  if (ed.mode === 'copy') {
    setMark('date', 'is-missing');
    $('ed-poster-note').textContent = 'Загрузи новую афишу — на старой прошлая дата.';
  }
  if (ed.mode === 'new') setTimeout(() => $('ed-post').focus({ preventScroll: true }), 60);
}

function renderAll() {
  renderHead();
  fillInputs();
  renderAge();
  renderMagic();
  renderPoster();
  renderLineup();
  renderProgram();
  renderWaves();
  renderStatus();
  renderPreview();
  renderBar();
}

function renderHead() {
  const ev = ed.id ? nightById(ed.id) : null;
  $('ed-h').textContent = ed.mode === 'edit' ? (ed.f.title || 'Ночь') : ed.mode === 'copy' ? 'Копия ночи' : 'Новая ночь';
  $('ed-sub').textContent = ed.mode === 'edit'
    ? `${ev ? fmtWhen(ev.startsAt) : ''}${ev ? ' · ' + phaseLabel(ev).toLowerCase() : ''}`
    : ed.mode === 'copy'
      ? `Из «${ed.srcTitle}»: место, цены и программа перенесены. Поставь дату и новую афишу.`
      : 'Вставь пост из Telegram или заполни вручную — справа видно, как страницу увидят гости.';
  const acts = [];
  if (ed.mode === 'edit') {
    if (ev && isPublic(ev)) acts.push(`<a class="b b-ghost b-sm" href="/e/${encodeURIComponent(ed.id)}" target="_blank" rel="noopener">${icon('external')}Страница</a>`);
    acts.push(`<a class="b b-ghost b-sm" href="#events/copy/${encodeURIComponent(ed.id)}">${icon('copy')}Копия на новую дату</a>`);
  }
  $('ed-head-acts').innerHTML = acts.join('');
  const open = $('ed-open');
  open.hidden = !(ev && isPublic(ev));
  if (ev) open.href = `/e/${encodeURIComponent(ev.id)}`;
}

function fillInputs() {
  for (const el of qsa('[data-k]', form())) {
    const v = ed.f[el.dataset.k];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  }
}

function renderAge() {
  for (const b of qsa('[data-age]', $('ed-age'))) b.setAttribute('aria-pressed', String(Number(b.dataset.age) === Number(ed.f.ageRating)));
}

// ---------- мастер «из поста» ----------
function renderMagic() {
  const box = $('ed-magic');
  box.hidden = ed.mode === 'edit';
  const a = ed.analysis;
  const collapsed = !ed.magicOpen && a;
  box.querySelector('.magic-row').hidden = Boolean(collapsed) || (!ed.magicOpen && ed.mode === 'copy');
  box.querySelector('.magic-acts').hidden = Boolean(collapsed) || (!ed.magicOpen && ed.mode === 'copy');
  const head = box.querySelector('.magic-h p');
  head.textContent = ed.mode === 'copy'
    ? 'Есть новый пост для этой ночи? Вставь его — дата, цены и программа обновятся.'
    : 'Вставь текст анонса из Telegram — разберу дату, время, место, цены, лайн-ап и программу. Афишу можно перетащить или вставить рядом.';
  if (ed.mode === 'copy' && !ed.magicOpen && !a) {
    $('ed-found').hidden = false;
    $('ed-found').innerHTML = `<div class="magic-done"><button class="b b-ghost b-sm" type="button" data-magic="open">${icon('sparkles')}Вставить пост</button></div>`;
    return;
  }
  $('ed-engine').textContent = state.ai ? 'ИИ подключён — разберёт даже вольный текст' : 'Разбор по правилам — проверь подсвеченные поля';
  const found = $('ed-found');
  if (!a) {
    found.hidden = true;
    found.innerHTML = '';
    return;
  }
  const F = a.found || {};
  const f = ed.f;
  const chip = (ok, label) => `<span class="fc ${ok ? '' : 'is-miss'}">${icon(ok ? 'check' : 'x')}${esc(label)}</span>`;
  const n = (k, one, few, many) => (F[k] ? `${F[k]} ${plural(Number(F[k]), one, few, many)}` : '');
  const engine = a.engine === 'rules+ai'
    ? 'Разобрано ИИ и правилами'
    : a.offline ? 'Сервер не ответил — разобрано в браузере по правилам' : 'Разобрано по правилам';
  found.hidden = false;
  found.innerHTML = `
    <div class="magic-done">${icon('check')}<b>${esc(engine)}</b>
      <button class="b b-quiet b-sm" type="button" data-magic="open">${icon('edit')}Изменить текст</button></div>
    <div class="found-chips">
      ${chip(F.title, 'Название')}
      ${chip(F.date, F.date && f.date ? `Дата: ${fmtDay(`${f.date}T12:00:00+05:00`)}` : 'Дата')}
      ${chip(F.timeStart, F.timeStart ? `Двери ${f.timeStart}` : 'Время')}
      ${chip(F.venue, 'Площадка')}
      ${chip(F.address, f.secret ? 'SECRET PLACE' : 'Адрес')}
      ${chip(F.waves, n('waves', 'цена', 'цены', 'цен') || 'Цены')}
      ${F.lineup ? chip(true, `Лайн-ап: ${F.lineup}`) : ''}
      ${F.program ? chip(true, `Программа: ${n('program', 'пункт', 'пункта', 'пунктов')}`) : ''}
      ${chip(F.descr, 'Описание')}
    </div>
    ${(a.notes || []).length ? `<ul class="notes">${a.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
}

async function analyze() {
  const text = $('ed-post').value.trim();
  if (text.length < 10) {
    toast('Вставь текст поста — хотя бы пару строк', 'err');
    $('ed-post').focus();
    return;
  }
  const r = await busy($('ed-analyze'), () => api('/api/event-upsert', { method: 'POST', body: { action: 'analyze', text }, timeout: 30000 }));
  let res;
  if (r.ok) res = r.j;
  else if (r.status === 0 || r.status >= 500) {
    const p = parsePost(text);
    res = { draft: p.draft, found: p.found, notes: p.notes, engine: 'rules', offline: true };
  } else {
    toast(r.message, 'err');
    return;
  }
  const sold = ed.f.waves.some((w) => w.sold > 0);
  ed.f = applyDraft(ed.f, res.draft || {}, { keepWaves: sold });
  ed.analysis = res;
  ed.magicOpen = false;
  clearErrors();
  fillInputs();
  renderAge();
  renderMagic();
  renderLineup();
  renderProgram();
  renderWaves();
  renderPreview();
  renderBar();
  markFound(res.found || {});
  const F = res.found || {};
  if (!F.date && !F.waves && !F.venue) toast('В тексте не нашлось ни даты, ни цен, ни места — это точно анонс?', 'info', 5000);
  else toast('Готово — проверь подсвеченные поля и добавь афишу');
  $('ed-magic').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function markFound(F) {
  setMark('title', !F.title && 'is-missing');
  setMark('date', !F.date && 'is-missing');
  setMark('timeStart', !F.timeStart && 'is-check');
  setMark('timeEnd', !F.timeEnd && 'is-check');
  setMark('venue', !F.venue && 'is-missing');
  setMark('address', !F.address && !ed.f.secret && 'is-missing');
}
function setMark(field, cls) {
  const el = form().querySelector(`[data-f="${field}"]`);
  if (!el) return;
  el.classList.remove('is-missing', 'is-check');
  if (cls) el.classList.add(cls);
}
function clearMarks() {
  for (const el of qsa('.is-missing, .is-check', form())) el.classList.remove('is-missing', 'is-check');
}

// ---------- афиша ----------
function renderPoster() {
  const url = ed.localPoster || ed.f.posterUrl;
  for (const id of ['ed-drop', 'ed-drop2']) {
    const d = $(id);
    d.classList.toggle('has-img', Boolean(url));
    d.classList.toggle('is-busy', ed.uploading > 0);
    d.style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : '';
  }
  $('ed-poster-del').hidden = !url;
  if (!url && ed.mode !== 'copy') $('ed-poster-note').textContent = '';
}

// Картинку уменьшаем в браузере: до 1350 px по длинной стороне, JPEG. Так
// запрос укладывается в лимит функции, а страница ночи грузится быстро.
async function shrink(file, max = 1350) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let q = 0.86;
    let out = c.toDataURL('image/jpeg', q);
    while (out.length > 3_900_000 && q > 0.5) {
      q -= 0.12;
      out = c.toDataURL('image/jpeg', q);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPoster(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) {
    toast('Нужна картинка: JPG, PNG или WebP', 'err');
    return;
  }
  const seq = ++ed.uploadSeq;
  if (ed.localPoster) URL.revokeObjectURL(ed.localPoster);
  ed.localPoster = URL.createObjectURL(file);
  ed.uploading++;
  $('ed-poster-note').textContent = 'Загружаю афишу…';
  renderPoster();
  renderPreview();
  renderBar();
  let data = null;
  try {
    data = await shrink(file);
  } catch {
    data = null;
  }
  const r = data
    ? await api('/api/poster', { method: 'POST', body: { data }, timeout: 45000 })
    : { ok: false, message: 'не получилось открыть картинку — попробуй JPG или PNG' };
  ed.uploading--;
  if (seq !== ed.uploadSeq) return; // пока грузили, выбрали другую
  if (!r.ok) {
    URL.revokeObjectURL(ed.localPoster);
    ed.localPoster = null;
    $('ed-poster-note').textContent = '';
    toast(`Афиша не загрузилась: ${r.message}`, 'err', 6000);
  } else {
    ed.f.posterUrl = r.j.url;
    $('ed-poster-note').textContent = `Загружено · ${Math.round((r.j.bytes || 0) / 1024)} КБ`;
    setMark('poster', null);
  }
  renderPoster();
  renderPreview();
  renderBar();
}

function removePoster() {
  ed.uploadSeq++;
  if (ed.localPoster) URL.revokeObjectURL(ed.localPoster);
  ed.localPoster = null;
  ed.f.posterUrl = '';
  $('ed-poster-note').textContent = '';
  renderPoster();
  changed();
}

function bindDrop(el) {
  const pick = () => $('ed-file').click();
  el.addEventListener('click', pick);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    const file = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type));
    if (file) uploadPoster(file);
    else toast('Перетащи картинку — JPG, PNG или WebP', 'err');
  });
}

// ---------- лайн-ап ----------
function renderLineup() {
  const host = $('ed-lineup');
  const input = $('ed-lineup-in');
  for (const t of qsa('.tg', host)) t.remove();
  input.insertAdjacentHTML('beforebegin', ed.f.lineup
    .map((n, i) => `<span class="tg">${esc(n)}<button type="button" data-lu="${i}" aria-label="Убрать ${esc(n)}">${icon('x')}</button></span>`)
    .join(''));
  input.hidden = ed.f.lineup.length >= 10;
  input.placeholder = ed.f.lineup.length ? 'Ещё имя' : 'Имя диджея или MC';
}
function addLineup(raw) {
  const names = String(raw || '').split(/[,;\n]/).map((s) => s.trim().slice(0, 60)).filter(Boolean);
  if (!names.length) return;
  for (const n of names) {
    if (ed.f.lineup.length >= 10) break;
    if (!ed.f.lineup.some((x) => x.toLowerCase() === n.toLowerCase())) ed.f.lineup.push(n);
  }
  $('ed-lineup-in').value = '';
  renderLineup();
  changed();
}

// ---------- программа ----------
function renderProgram() {
  const list = ed.f.program;
  $('ed-program').innerHTML = list
    .map((p, i) => `
      <div class="pg-row">
        <input class="in" data-pi="${i}" data-pk="title" value="${esc(p.title)}" maxlength="60" placeholder="Что будет, напр. Лазер-шоу" aria-label="Пункт ${i + 1}" />
        <input class="in pg-text" data-pi="${i}" data-pk="text" value="${esc(p.text)}" maxlength="400" placeholder="Пара слов — необязательно" aria-label="Описание пункта ${i + 1}" />
        <div class="pg-acts">
          <button type="button" class="b b-quiet b-sm b-icon" data-pm="up" data-pi="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button>
          <button type="button" class="b b-quiet b-sm b-icon" data-pm="down" data-pi="${i}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button>
          <button type="button" class="b b-quiet b-sm b-icon" data-pm="del" data-pi="${i}" aria-label="Убрать пункт">${icon('x')}</button>
        </div>
      </div>`)
    .join('') + (list.length < 16 ? `<div><button type="button" class="b b-ghost b-sm" data-pm="add">${icon('plus')}Пункт программы</button></div>` : '');
  const have = new Set(list.map((p) => p.title.trim().toLowerCase()));
  const ideas = PROGRAM_IDEAS.filter((t) => !have.has(t.toLowerCase()));
  $('ed-sugg').innerHTML = ideas.length && list.length < 16
    ? `<span>Быстро:</span>${ideas.map((t) => `<button type="button" class="chip" data-idea="${esc(t)}">+ ${esc(t)}</button>`).join('')}`
    : '';
}

function programAction(act, i) {
  const list = ed.f.program;
  if (act === 'add') {
    list.push({ title: '', text: '' });
    renderProgram();
    $('ed-program').querySelector(`[data-pi="${list.length - 1}"][data-pk="title"]`)?.focus();
  } else if (act === 'del') {
    list.splice(i, 1);
    renderProgram();
  } else if (act === 'up' && i > 0) {
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    renderProgram();
  } else if (act === 'down' && i < list.length - 1) {
    [list[i + 1], list[i]] = [list[i], list[i + 1]];
    renderProgram();
  }
  changed();
}

// ---------- волны ----------
function renderWaves() {
  const host = $('ed-waves');
  const waves = ed.f.waves;
  if (!waves.length) {
    host.innerHTML = `<div class="tpls">${Object.entries(WAVE_TEMPLATES)
      .map(([k, t]) => `<button type="button" class="tpl" data-tpl="${k}"><b>${esc(t.label)}</b><span>${esc(t.hint)}</span></button>`)
      .join('')}</div>`;
  } else {
    host.innerHTML = waves
      .map((w, i) => `
        <div class="wr">
          <span class="wr-no">${i + 1}</span>
          <label class="f wr-name" data-f="wave-${w.waveNo}"><span class="f-l">Название</span>
            <input class="in" data-wi="${i}" data-wk="name" value="${esc(w.name)}" maxlength="40" placeholder="Ранняя" /></label>
          <label class="f wr-price" data-f="wave-${w.waveNo}-price"><span class="f-l">Цена, ₽</span>
            <input class="in" data-wi="${i}" data-wk="priceRub" type="number" inputmode="numeric" min="0" max="50000" step="50" value="${esc(String(w.priceRub))}" /></label>
          <label class="f wr-quota" data-f="wave-${w.waveNo}-quota"><span class="f-l">Проходок</span>
            <input class="in" data-wi="${i}" data-wk="quota" type="number" inputmode="numeric" min="1" max="5000" value="${esc(String(w.quota))}" /></label>
          <label class="sw wr-pub"><input type="checkbox" data-wi="${i}" data-wk="public" ${w.public !== false ? 'checked' : ''} /><span>на сайте</span></label>
          <span class="wr-x"><button type="button" class="b b-quiet b-icon" data-wdel="${i}" ${w.sold > 0 ? 'disabled title="По волне есть продажи — удалить нельзя"' : 'title="Удалить волну"'} aria-label="Удалить волну">${icon('trash')}</button></span>
          ${w.sold > 0 ? `<span class="wr-sold">Продано ${w.sold} — квоту можно поднять, удалить волну нельзя</span>` : ''}
        </div>`)
      .join('');
  }
  $('ed-wave-add').hidden = !waves.length || waves.length >= 8;
  renderWaveSum();
}

function renderWaveSum() {
  const box = $('ed-wave-sum');
  const waves = ed.f.waves;
  if (!waves.length) {
    box.innerHTML = '<span>Выбери шаблон — цифры поправишь под себя.</span>';
    return;
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const total = waves.reduce((s, w) => s + num(w.quota), 0);
  const onSite = waves.filter((w) => w.public !== false).reduce((s, w) => s + num(w.quota), 0);
  const gross = waves.reduce((s, w) => s + num(w.quota) * num(w.priceRub), 0);
  const cap = Number(ed.f.capacity) || 0;
  box.innerHTML = `
    <span>Всего проходок: <b>${total}</b>${onSite !== total ? ` · на сайте ${onSite}` : ''}${cap ? ` · вместимость ${cap}` : ''}</span>
    <span>При полном зале ≈ <b>${esc(rub(gross))}</b></span>
    ${cap && total > cap ? `<span class="warn-t">Проходок больше, чем вмещает площадка</span>` : ''}`;
}

function addWave(tpl) {
  const waves = ed.f.waves;
  if (tpl) {
    const t = WAVE_TEMPLATES[tpl];
    if (!t) return;
    ed.f.waves = t.waves.map((w, i) => ({ ...w, waveNo: i + 1, sold: 0 }));
  } else {
    if (waves.length >= 8) {
      toast('Волн не больше восьми', 'info');
      return;
    }
    const last = waves[waves.length - 1];
    const no = Math.max(0, ...waves.map((w) => Number(w.waveNo) || 0)) + 1;
    waves.push({
      waveNo: no,
      name: last ? `${waves.length + 1} волна` : 'Проходка',
      priceRub: last ? (Number(last.priceRub) || 0) + 200 : 1000,
      quota: last ? Number(last.quota) || 100 : 200,
      sold: 0,
      public: true,
    });
  }
  clearFieldError('waves');
  renderWaves();
  changed();
  const inputs = qsa('[data-wk="name"]', $('ed-waves'));
  if (!tpl) inputs.at(-1)?.select();
}

// ---------- статус ----------
function renderStatus() {
  const card = $('ed-status-card');
  if (ed.mode !== 'edit') {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const ev = nightById(ed.id) || { status: ed.status, startsAt: new Date().toISOString(), waves: [] };
  const ph = phaseOf(ev);
  const sold = ed.f.waves.reduce((s, w) => s + (w.sold || 0), 0);
  const canDelete = sold === 0 && !Number(ev.pending || 0) && !Number(ev.revenue || 0);
  const text = {
    draft: 'Черновик видишь только ты. Опубликуй, когда всё готово, — ночь появится на сайте и в боте.',
    onsale: 'Ночь на сайте и в боте, проходки продаются.',
    soldout: 'Все проходки на сайте проданы. Добавь волну, если места ещё есть.',
    live: 'Ночь идёт прямо сейчас: продажи открыты до финиша.',
    stale: 'Ночь закончилась, а статус всё ещё «в продаже». Переведи её в прошедшие — уйдёт в архив афиши.',
    past: 'Ночь в архиве афиши: страница открывается, купить нельзя.',
    cancelled: 'Ночь отменена и скрыта с сайта. Можно снова опубликовать.',
  }[ph] || '';
  const btns = [];
  if (['onsale', 'soldout', 'live'].includes(ph)) btns.push(`<button type="button" class="b b-ghost b-sm" data-st="unpublish">${icon('eye')}Снять с продажи</button>`);
  if (ph === 'stale' || ph === 'live') btns.push(`<button type="button" class="b b-ghost b-sm" data-st="past">${icon('check')}Перевести в прошедшие</button>`);
  if (canDelete) btns.push(`<button type="button" class="b b-danger b-sm" data-st="delete">${icon('trash')}Удалить ночь</button>`);
  $('ed-status').innerHTML = `
    <div class="pub-row"><div class="inline">${pill(ev)}</div><div class="acts">${btns.join('')}</div></div>
    <p class="small muted">${esc(text)}${!canDelete && sold ? ` Удалить нельзя: продано ${sold} ${plural(sold, 'проходка', 'проходки', 'проходок')}.` : ''}</p>`;
}

// какой статус уйдёт при «Сохранить»
const keepStatus = () => (['onsale', 'soldout'].includes(ed.status) ? 'onsale' : ed.status === 'past' ? 'past' : 'draft');

// ---------- превью ----------
function previewHtml() {
  const f = ed.f;
  const r = rangeOf(f);
  const poster = ed.localPoster || f.posterUrl;
  const waves = f.waves
    .map((w) => ({ waveNo: Number(w.waveNo), name: w.name, priceRub: Number(w.priceRub) || 0, quota: Number(w.quota) || 0, sold: Number(w.sold) || 0, public: w.public !== false }))
    .filter((w) => w.quota > 0);
  const pub = waves.filter((w) => w.public);
  const act = waveStates(pub).find((w) => w.state === 'active');
  const ladder = ladderText(pub);
  const place = f.secret
    ? 'SECRET PLACE — адрес откроется за сутки до ночи'
    : [f.venue, f.address].map((s) => String(s).trim()).filter(Boolean).join(', ');
  const prog = f.program.filter((p) => p.title.trim());
  const priceLine = act
    ? `<b>от ${esc(rub(act.priceRub))}</b>`
    : pub.length ? '<b>всё продано</b>' : '<b class="pv-empty">цены не указаны</b>';
  return `
    <div class="pv-cover"${coverAttr(poster)}>${coverPh(poster)}
      <span class="pv-age">${Number(f.ageRating)}+</span>
      <div class="pv-over">
        <span class="pv-date">${r ? esc(fmtWhen(r.startsAt)) : 'дата не выбрана'}</span>
        <div class="pv-title">${esc((String(f.title).trim() || 'Название ночи').toUpperCase())}</div>
      </div>
    </div>
    <div class="pv-b">
      <div class="pv-row">${icon('pin')}<span>${place ? esc(place) : '<span class="pv-empty">место не указано</span>'}</span></div>
      <div class="pv-row">${icon('clock')}<span>двери ${esc(f.timeStart || '—')} · до ${esc(f.timeEnd || '—')} · ${Number(f.ageRating)}+</span></div>
      <div class="pv-price">${priceLine}${ladder ? `<small>${esc(ladder)}</small>` : ''}</div>
      ${f.lineup.length ? `<div class="pv-lu">${f.lineup.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}
      ${prog.length ? `<ul class="pv-pg">${prog.map((p) => `<li><b>${esc(p.title)}</b>${p.text.trim() ? `<span>${esc(p.text)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${String(f.descr).trim() ? `<p class="pv-d">${esc(String(f.descr).trim())}</p>` : ''}
      <div class="pv-cta">Взять проходку</div>
    </div>`;
}

let pvFrame = 0;
function renderPreview() {
  cancelAnimationFrame(pvFrame);
  pvFrame = requestAnimationFrame(() => { $('ed-pv').innerHTML = previewHtml(); });
}

function openPreview() {
  dialog({
    title: 'Так увидят гости',
    body: `<div class="pv">${previewHtml()}</div>`,
    actions: [{ label: 'Закрыть', value: null, kind: 'ghost' }],
  });
}

// ---------- нижняя панель ----------
function renderBar() {
  const dirty = ed.base !== snap();
  const st = keepStatus();
  const note = $('ed-note');
  const ev = ed.id ? nightById(ed.id) : null;
  note.classList.toggle('is-dirty', dirty || ed.uploading > 0);
  note.textContent = ed.uploading > 0
    ? 'Загружаю афишу…'
    : dirty
      ? (ed.mode === 'edit' ? 'Есть несохранённые изменения' : 'Ночь ещё не сохранена')
      : ed.mode === 'edit' ? `Сохранено · ${(ev ? phaseLabel(ev) : 'черновик').toLowerCase()}` : '';
  const save = $('ed-save');
  const pub = $('ed-publish');
  if (st === 'draft') {
    save.hidden = false;
    save.innerHTML = ed.mode === 'edit' ? 'Сохранить' : '<span class="hide-s">Сохранить черновик</span><span class="show-s">Черновик</span>';
    pub.textContent = 'Опубликовать';
  } else {
    save.hidden = true;
    pub.textContent = 'Сохранить';
  }
}

function changed() {
  renderPreview();
  renderBar();
}

// ---------- ошибки ----------
function showErrors(list) {
  let first = null;
  for (const e of list) {
    const field = String(e.field || '');
    let el = form().querySelector(`[data-f="${CSS.escape(field)}"]`);
    if (!el && /^wave/.test(field)) el = form().querySelector('[data-f="waves"]');
    if (!el) continue;
    el.classList.add('is-error');
    const msg = el.querySelector(':scope > .f-err');
    if (msg) msg.textContent = e.message;
    if (!first) first = el;
  }
  const w = list.find((e) => /^wave/.test(String(e.field || '')));
  const box = $('ed-waves-err');
  box.textContent = w ? w.message : '';
  box.style.display = w ? 'block' : 'none';
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function clearErrors() {
  for (const el of qsa('.is-error', form())) el.classList.remove('is-error');
  const box = $('ed-waves-err');
  box.textContent = '';
  box.style.display = 'none';
}
function clearFieldError(field) {
  form().querySelector(`[data-f="${CSS.escape(field)}"]`)?.classList.remove('is-error', 'is-missing', 'is-check');
}

// ---------- сохранение ----------
async function save(status, btn) {
  clearErrors();
  const errs = validate(ed.f, status);
  if (errs.length) {
    showErrors(errs);
    toast(errs[0].message, 'err');
    return false;
  }
  if (ed.uploading > 0) {
    toast('Афиша ещё загружается — пара секунд', 'info');
    return false;
  }
  const r = await busy(btn, () => api('/api/event-upsert', { method: 'POST', body: toBody(ed.f, { id: ed.id, status }), timeout: 20000 }));
  if (!r.ok) {
    if (Array.isArray(r.j.fields)) showErrors(r.j.fields);
    if (r.j.error === 'exists' && r.j.event_id) {
      const go = await confirmDlg({
        title: 'Такая ночь уже есть',
        text: 'Ночь с этим названием и датой уже создана. Открыть её и поправить там?',
        ok: 'Открыть', cancel: 'Остаться',
      });
      if (go) {
        ed.base = snap();
        location.hash = `#events/${r.j.event_id}`;
      }
      return false;
    }
    toast(r.message || 'Не удалось сохранить', 'err', 6000);
    return false;
  }
  const id = r.j.event_id;
  await reloadEvents();
  const ev = nightById(id);
  ed.mode = 'edit';
  ed.id = id;
  ed.status = ev ? ev.status : status;
  if (ev) ed.f = toForm(ev);
  ed.base = snap();
  ed.analysis = null;
  history.replaceState(null, '', `#events/${encodeURIComponent(id)}`);
  emit('route-silent');
  clearMarks();
  renderAll();
  for (const w of r.j.warnings || []) toast(w, 'info', 6500);
  if (r.j.published) {
    const cur = nightById(state.night);
    if (!cur || !['onsale', 'soldout', 'live'].includes(phaseOf(cur))) setNight(id);
    publishedDialog(ev || { id, title: ed.f.title });
  } else {
    toast(status === 'draft' ? (r.j.created ? 'Черновик сохранён' : 'Сохранено') : status === 'past' ? 'Ночь в архиве' : 'Сохранено');
  }
  return true;
}

async function publish(btn) {
  const errs = validate(ed.f, 'onsale');
  if (errs.length) {
    clearErrors();
    showErrors(errs);
    toast(errs[0].message, 'err');
    return;
  }
  const f = ed.f;
  const r = rangeOf(f);
  const pub = f.waves.filter((w) => w.public !== false);
  const first = waveStates(pub.map((w) => ({ ...w, priceRub: Number(w.priceRub), quota: Number(w.quota), sold: w.sold || 0 }))).find((w) => w.state === 'active');
  const place = f.secret ? 'SECRET PLACE' : [f.venue, f.address].filter((s) => String(s).trim()).join(', ');
  const ok = await confirmDlg({
    title: 'Опубликовать ночь?',
    html: `<p>«${esc(String(f.title).toUpperCase())}» появится на сайте и в боте, проходки начнут продаваться.</p>
      <div class="pv-price"><b>${esc(fmtWhen(r.startsAt))}</b><small>${esc(place || 'место не указано')}${first ? ` · от ${esc(rub(first.priceRub))}` : ''}</small></div>
      ${f.posterUrl ? '' : '<p class="small warn-t">Без афиши: превью ссылки покажет фирменную картинку. Можно добавить позже.</p>'}`,
    ok: 'Опубликовать',
  });
  if (ok) await save('onsale', btn);
}

async function statusAction(act, btn) {
  if (act === 'unpublish') {
    const ok = await confirmDlg({
      title: 'Снять с продажи?',
      text: 'Ночь пропадёт с сайта и из бота. Купленные проходки останутся в силе, ожидающие брони можно подтвердить.',
      ok: 'Снять с продажи', danger: true,
    });
    if (ok) await save('draft', btn);
  } else if (act === 'past') {
    await save('past', btn);
  } else if (act === 'delete') {
    const ev = nightById(ed.id);
    const ok = await confirmDlg({
      title: 'Удалить ночь?',
      text: `«${ed.f.title}» исчезнет из панели${ev && isPublic(ev) ? ', с сайта и из бота' : ''}. Отменить это нельзя.`,
      ok: 'Удалить', danger: true,
    });
    if (!ok) return;
    const r = await busy(btn, () => api('/api/event-upsert', { method: 'POST', body: { action: 'delete', id: ed.id } }));
    if (!r.ok) {
      toast(r.message, 'err', 6000);
      return;
    }
    ed.base = snap();
    await reloadEvents();
    toast('Ночь удалена');
    location.hash = '#events';
  }
}

async function publishedDialog(ev) {
  const url = siteUrl(ev);
  const subs = state.subs;
  const v = await dialog({
    title: 'Ночь в продаже',
    body: `<p>«${esc(ev.title)}» уже на сайте и в боте. Превью ссылки покажет афишу, дату и цену.</p>
      <div class="linkbox"><code>${esc(url)}</code><button type="button" class="b b-sm" data-copy>${icon('copy')}Копировать</button></div>
      ${subs
        ? `<p><b>Анонс подписчикам бота</b><br><span class="small muted">${subs} ${plural(subs, 'человек ждёт', 'человека ждут', 'человек ждут')} новую ночь — анонс с афишей и кнопкой брони придёт в Telegram.</span></p>`
        : '<p class="small muted">Подписчиков анонсов в боте пока нет — их собирает кнопка «Узнать первым» на сайте и ссылка в постах.</p>'}`,
    actions: [
      { label: 'Готово', value: 'done', kind: 'ghost' },
      subs ? { label: 'Разослать анонс', value: 'bc', kind: 'primary', icon: 'send' } : { label: 'Открыть страницу', value: 'open', kind: 'primary', icon: 'external' },
    ],
    onMount(d) {
      d.querySelector('[data-copy]').onclick = async () => {
        if (await copyText(url)) toast('Ссылка скопирована');
      };
    },
  });
  if (v === 'bc') {
    location.hash = '#promo';
    setTimeout(() => startBroadcast(ev.id), 50);
  } else if (v === 'open') {
    window.open(url, '_blank', 'noopener');
  }
}

// ---------- обработчики ----------
let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  const f = form();

  f.addEventListener('submit', (e) => e.preventDefault());
  f.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.k) {
      const k = el.dataset.k;
      ed.f[k] = el.type === 'checkbox' ? el.checked : el.value;
      clearFieldError(k);
      if (k === 'secret') setMark('address', null);
      if (k === 'capacity') renderWaveSum();
      changed();
    } else if (el.dataset.pk) {
      const p = ed.f.program[Number(el.dataset.pi)];
      if (p) p[el.dataset.pk] = el.value;
      changed();
    } else if (el.dataset.wk) {
      const w = ed.f.waves[Number(el.dataset.wi)];
      if (!w) return;
      const k = el.dataset.wk;
      if (k === 'public') w.public = el.checked;
      else if (k === 'name') w.name = el.value;
      else w[k] = el.value === '' ? '' : Number(el.value);
      el.closest('.f')?.classList.remove('is-error');
      clearFieldError('waves');
      renderWaveSum();
      changed();
    }
  });
  f.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.age) {
      ed.f.ageRating = Number(t.dataset.age);
      renderAge();
      changed();
    } else if (t.dataset.lu !== undefined) {
      ed.f.lineup.splice(Number(t.dataset.lu), 1);
      renderLineup();
      changed();
    } else if (t.dataset.pm) {
      programAction(t.dataset.pm, Number(t.dataset.pi));
    } else if (t.dataset.idea) {
      ed.f.program.push({ title: t.dataset.idea, text: '' });
      renderProgram();
      changed();
    } else if (t.dataset.tpl) {
      addWave(t.dataset.tpl);
    } else if (t.dataset.wdel !== undefined) {
      const i = Number(t.dataset.wdel);
      if ((ed.f.waves[i]?.sold || 0) > 0) return;
      ed.f.waves.splice(i, 1);
      renderWaves();
      changed();
    } else if (t.dataset.st) {
      statusAction(t.dataset.st, t);
    }
  });

  const lu = $('ed-lineup-in');
  lu.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addLineup(lu.value);
    } else if (e.key === 'Backspace' && !lu.value && ed.f.lineup.length) {
      ed.f.lineup.pop();
      renderLineup();
      changed();
    }
  });
  lu.addEventListener('blur', () => addLineup(lu.value));
  lu.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (/[,;\n]/.test(text)) {
      e.preventDefault();
      addLineup(text);
    }
  });
  $('ed-lineup').addEventListener('click', (e) => { if (e.target === $('ed-lineup')) lu.focus(); });

  $('ed-wave-add').onclick = () => addWave();
  $('ed-analyze').onclick = analyze;
  $('ed-skip').onclick = () => {
    $('ed-magic').hidden = true;
    form().querySelector('[data-k="title"]').focus();
  };
  $('ed-magic').addEventListener('click', (e) => {
    const b = e.target.closest('[data-magic]');
    if (!b) return;
    ed.magicOpen = true;
    ed.analysis = null;
    renderMagic();
    $('ed-post').focus();
  });
  $('ed-post').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      analyze();
    }
  });

  bindDrop($('ed-drop'));
  bindDrop($('ed-drop2'));
  $('ed-poster-pick').onclick = () => $('ed-file').click();
  $('ed-poster-del').onclick = removePoster;
  $('ed-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) uploadPoster(file);
  });
  // картинка из буфера (скопировал афишу в Telegram — вставил сюда)
  document.addEventListener('paste', (e) => {
    if (!visible('editor')) return;
    const file = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (!file) return;
    const text = e.clipboardData.getData('text');
    if (!text) e.preventDefault();
    uploadPoster(file);
  });

  $('ed-save').onclick = () => save(keepStatus() === 'draft' ? 'draft' : keepStatus(), $('ed-save'));
  $('ed-publish').onclick = () => (keepStatus() === 'draft' ? publish($('ed-publish')) : save(keepStatus(), $('ed-publish')));
  $('ed-pv-btn').onclick = openPreview;
  document.addEventListener('keydown', (e) => {
    if (!visible('editor') || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    if (keepStatus() === 'draft') save('draft', $('ed-save'));
    else save(keepStatus(), $('ed-publish'));
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty() || ed.uploading > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // ночь могла измениться из бота или второй вкладки: обновляем шапку и
  // проданное, но не трогаем то, что человек сейчас правит
  on('events', () => {
    if (!visible('editor') || ed.mode !== 'edit') return;
    const ev = nightById(ed.id);
    if (!ev) return;
    const soldBy = new Map((ev.waves || []).map((w) => [Number(w.waveNo), Number(w.sold) || 0]));
    let touched = false;
    for (const w of ed.f.waves) {
      const s = soldBy.get(Number(w.waveNo)) || 0;
      if (s !== w.sold) { w.sold = s; touched = true; }
    }
    if (ed.base === snap()) ed.status = ev.status;
    renderHead();
    renderStatus();
    if (touched) {
      const focused = document.activeElement && $('ed-waves').contains(document.activeElement);
      if (!focused) renderWaves();
    }
  });
}
