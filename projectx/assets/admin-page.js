// Панель организатора PROJECT X: вход по ключу, разделы по #хешу, выбор
// ночи, плашки о проблемах и автообновление. Разделы — в assets/admin/.
//   #overview      сводка по ночи
//   #orders        брони, ждущие оплаты
//   #guests        гости, касса, офлайн-копия
//   #events        ночи; #events/new, #events/<id>, #events/copy/<id>
//   #promo         ссылки с метками, QR, анонс в боте
//   #service       бот, самотест, база
import {
  $, qsa, state, ls, LS, on, emit, reloadEvents, loadStats, setNight, nightById, phaseOf, phaseLabel, endOf,
  esc, icon, hydrateIcons, toast, dialog, confirmDlg, busy, fmtDay, fmtWhen, pill, coverAttr, coverPh, initials, PH,
} from './admin/core.js';
import * as overview from './admin/overview.js';
import * as orders from './admin/orders.js';
import * as guests from './admin/guests.js';
import * as events from './admin/events.js';
import * as editor from './admin/editor.js';
import * as promo from './admin/promo.js';
import * as service from './admin/service.js';

const VIEWS = { overview, orders, guests, events, editor, promo, service };

hydrateIcons();
bindGate();
if (state.key) boot();
else showGate();

// ---------- вход ----------
function showGate(err) {
  state.booted = false;
  $('app').hidden = true;
  $('gate').hidden = false;
  document.body.dataset.view = 'gate';
  $('gate-name').value = state.name;
  $('gate-err').hidden = !err;
  if (err) $('gate-err').textContent = err === true ? 'Ключ не подошёл' : err;
  setTimeout(() => $('gate-key').focus(), 50);
}

function bindGate() {
  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('gate-key').value.trim();
    if (!key) {
      $('gate-err').textContent = 'Введи ключ администратора';
      $('gate-err').hidden = false;
      $('gate-key').focus();
      return;
    }
    state.key = key;
    state.name = $('gate-name').value.trim() || 'админ';
    ls.set(LS.key, state.key);
    ls.set(LS.name, state.name);
    boot();
  });
}

async function boot() {
  const btn = $('gate-go');
  btn.classList.add('is-busy');
  const r = await reloadEvents();
  btn.classList.remove('is-busy');
  if (r.status === 403) {
    ls.del(LS.key);
    state.key = '';
    showGate(true);
    return;
  }
  if (r.status === 0 && !$('gate').hidden) {
    showGate(r.message);
    return;
  }
  $('gate').hidden = true;
  $('app').hidden = false;
  state.booted = true;
  $('gate-key').value = '';
  $('who-name').textContent = state.name || 'админ';
  $('who-av').textContent = initials(state.name || 'админ');
  pickNight();
  renderNightPick();
  renderBanner(r);
  bindShell();
  await route();
  loadStats();
}

// ночь по умолчанию: ближайшая в продаже, иначе последняя прошедшая
function pickNight() {
  if (state.night && nightById(state.night)) return;
  const now = Date.now();
  const soon = state.events
    .filter((e) => ['onsale', 'soldout'].includes(e.status) && endOf(e) > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const recent = state.events.filter((e) => e.status !== 'draft'); // список с сервера — от новых к старым
  const pick = soon[0] || recent[0] || state.events[0] || null;
  state.night = pick ? pick.id : '';
  state.stats = null;
  if (state.night) ls.set(LS.night, state.night);
  else ls.del(LS.night);
}

function renderNightPick() {
  const e = nightById(state.night);
  const th = $('np-th');
  th.setAttribute('style', e && e.posterUrl ? `background-image:url("${e.posterUrl.replace(/"/g, '%22')}")` : '');
  th.innerHTML = e && e.posterUrl ? '' : PH;
  $('np-t').textContent = e ? e.title : state.dbOk ? 'Ночей пока нет' : 'База не подключена';
  $('np-s').textContent = e ? `${fmtDay(e.startsAt)} · ${phaseLabel(e).toLowerCase()}` : state.dbOk ? 'создай первую' : 'раздел «Сервис»';
}

async function openNightPicker() {
  if (!state.events.length) {
    location.hash = '#events/new';
    return;
  }
  const now = Date.now();
  const asc = (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt);
  const soon = state.events.filter((e) => ['onsale', 'soldout'].includes(e.status) && endOf(e) > now).sort(asc);
  const drafts = state.events.filter((e) => e.status === 'draft').sort(asc);
  const rest = state.events.filter((e) => !soon.includes(e) && !drafts.includes(e)).sort((a, b) => -asc(a, b));
  const item = (e) => `<button type="button" class="pick" data-id="${esc(e.id)}" aria-current="${e.id === state.night}">
      <span class="np-th"${coverAttr(e.posterUrl)}>${coverPh(e.posterUrl)}</span>
      <span style="display:grid;min-width:0"><span class="pick-t">${esc(e.title)}</span>
      <span class="pick-s">${esc(fmtWhen(e.startsAt).toLowerCase())}${Number(e.pending) ? ` · ждут оплаты: ${e.pending}` : ''}</span></span>
      ${pill(e)}</button>`;
  const group = (title, list) => (list.length ? `<div class="picker-h">${title}</div>${list.map(item).join('')}` : '');
  const v = await dialog({
    title: 'Какая ночь?',
    body: `<div class="picker">${group('Скоро', soon)}${group('Черновики', drafts)}${group('Прошедшие', rest)}</div>`,
    actions: [{ label: 'Закрыть', value: null, kind: 'ghost' }, { label: 'Новая ночь', value: '__new', kind: 'primary', icon: 'plus' }],
    onMount(d, close) {
      for (const b of d.querySelectorAll('.pick')) b.onclick = () => close(b.dataset.id);
    },
  });
  if (v === '__new') location.hash = '#events/new';
  else if (v) setNight(v);
}

// ---------- плашка о проблеме ----------
function renderBanner(r) {
  const b = $('banner');
  if (r && r.status === 0) {
    b.className = 'banner is-bad';
    b.innerHTML = `${icon('alert')}<span>Нет связи с сервером — данные могут быть неактуальны.</span><button class="b b-sm b-ghost" type="button" data-retry>Повторить</button>`;
    b.hidden = false;
    b.querySelector('[data-retry]').onclick = (e) => busy(e.currentTarget, refreshAll);
    return;
  }
  if (!state.dbOk) {
    b.className = 'banner is-bad';
    b.innerHTML = `${icon('alert')}<span>База данных не отвечает. Подключи Neon Postgres в Vercel (Storage → Neon), сделай Redeploy и нажми «Инициализировать БД».</span><a class="b b-sm b-ghost" href="#service">Сервис</a>`;
    b.hidden = false;
    return;
  }
  const stale = state.events.filter((e) => phaseOf(e) === 'stale');
  if (stale.length) {
    const e = stale[0];
    b.className = 'banner';
    b.innerHTML = `${icon('alert')}<span>«${esc(e.title)}» закончилась, но стоит «в продаже». Гости её уже не видят — переведи в прошедшие, она уйдёт в архив афиши.</span>
      <a class="b b-sm b-ghost" href="#events/${encodeURIComponent(e.id)}">Открыть</a>`;
    b.hidden = false;
    return;
  }
  b.hidden = true;
}

// ---------- маршруты ----------
let current = { view: '', key: '' };
let currentHash = '';

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [a, b, c] = h.split('/');
  if (a === 'events' && b === 'new') return { view: 'editor', params: { mode: 'new' }, key: 'new' };
  if (a === 'events' && b === 'copy' && c) return { view: 'editor', params: { mode: 'copy', id: c }, key: `copy:${c}` };
  if (a === 'events' && b) return { view: 'editor', params: { mode: 'edit', id: b }, key: `edit:${b}` };
  if (VIEWS[a] && a !== 'editor') return { view: a, params: {}, key: a };
  return { view: 'overview', params: {}, key: 'overview' };
}

async function route() {
  if (!state.booted) return;
  const next = parseHash();
  if (current.view === 'editor' && next.key !== current.key && !(await editor.canLeave())) {
    history.replaceState(null, '', currentHash || '#events');
    return;
  }
  current = next;
  currentHash = location.hash || '#overview';
  document.body.dataset.view = next.view;
  for (const sec of qsa('.view')) sec.hidden = sec.dataset.view !== next.view;
  for (const a of qsa('[data-nav]')) {
    const v = a.dataset.nav;
    const on = v === next.view || (v === 'events' && next.view === 'editor') || (v === 'more' && ['promo', 'service'].includes(next.view));
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  await VIEWS[next.view].show(next.params);
}

// ---------- оболочка ----------
let shellBound = false;
function bindShell() {
  if (shellBound) return;
  shellBound = true;
  window.addEventListener('hashchange', route);
  $('night-pick').onclick = openNightPicker;
  $('btn-refresh').onclick = (e) => busy(e.currentTarget, async () => {
    await refreshAll();
    toast('Данные обновлены', 'ok', 1600);
  });
  for (const b of qsa('[data-logout]')) b.onclick = logout;
  $('tab-more').onclick = openMore;

  on('route-silent', () => {
    const next = parseHash();
    current = next;
    currentHash = location.hash;
  });
  on('night', renderNightPick);
  on('events', () => {
    if (!nightById(state.night)) {
      pickNight();
      emit('night');
      loadStats();
    }
    renderNightPick();
    renderBanner();
  });
  on('auth-lost', () => {
    ls.del(LS.key);
    state.key = '';
    showGate('Ключ больше не подходит — его сменили. Введи новый.');
  });

  // живые цифры: сводка — раз в 30 секунд, список ночей — раз в 2 минуты;
  // в фоне не опрашиваем, при возврате на вкладку — сразу
  setInterval(() => {
    if (state.booted && document.visibilityState === 'visible') loadStats();
  }, 30_000);
  setInterval(() => {
    if (state.booted && document.visibilityState === 'visible' && !editor.isDirty()) reloadEvents();
  }, 120_000);
  document.addEventListener('visibilitychange', () => {
    if (state.booted && document.visibilityState === 'visible' && Date.now() - state.statsAt > 15_000) loadStats();
  });
}

async function refreshAll() {
  const r = await reloadEvents();
  renderBanner(r.status === 0 ? r : undefined);
  await loadStats();
  emit('refresh');
}

async function openMore() {
  const item = (go, ic, title, sub) => `<button type="button" class="pick" data-go="${go}">
    <span class="np-th" style="display:grid;place-items:center">${icon(ic)}</span>
    <span style="display:grid;min-width:0"><span class="pick-t">${title}</span><span class="pick-s">${sub}</span></span><span></span></button>`;
  const v = await dialog({
    title: 'Ещё',
    body: `<div class="picker">
      ${item('#promo', 'megaphone', 'Продвижение', 'ссылки с метками, QR-постеры, анонс в боте')}
      ${item('#service', 'sliders', 'Сервис', 'бот, самотест, база данных')}
      ${item('/scan', 'scan', 'Сканер входа', 'открыть в новой вкладке')}
      ${item('/', 'external', 'Сайт', 'proxject.ru глазами гостя')}
      ${item('logout', 'logout', 'Выйти', `сейчас: ${esc(state.name || 'админ')}`)}
    </div>`,
    actions: [{ label: 'Закрыть', value: null, kind: 'ghost' }],
    onMount(d, close) {
      for (const b of d.querySelectorAll('[data-go]')) b.onclick = () => close(b.dataset.go);
    },
  });
  if (!v) return;
  if (v === 'logout') logout();
  else if (v.startsWith('#')) location.hash = v;
  else window.open(v, '_blank', 'noopener');
}

async function logout() {
  const ok = await confirmDlg({
    title: 'Выйти из панели?',
    text: 'Ключ на этом устройстве удалится — для входа придётся ввести его заново. Офлайн-копии списков для сканера останутся.',
    ok: 'Выйти', danger: true,
  });
  if (!ok) return;
  ls.del(LS.key);
  state.key = '';
  history.replaceState(null, '', location.pathname);
  location.reload();
}
