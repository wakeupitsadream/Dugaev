// Панель организатора — общее ядро: состояние, запросы к API с ключом,
// шина событий, иконки, уведомления и диалоги. Разделы панели (сводка,
// брони, гости, ночи, продвижение, сервис) живут в соседних модулях и
// общаются только через состояние и события отсюда.
import { esc } from '../events-load.js';
import { plural, fmtWhen, fmtTime, TZ } from '../ticket-format.js';
import { fmtRub } from '../waves.js';

export { esc, plural, fmtWhen, fmtTime, fmtRub };

export const $ = (id) => document.getElementById(id);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- память браузера ----------
// Ключи те же, что у прежней панели и сканера: офлайн-копии и имя сотрудника
// остаются на месте после обновления.
export const LS = { key: 'th_admin_key', name: 'th_admin_name', night: 'th_admin_night' };
export const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

export const state = {
  key: ls.get(LS.key) || '',
  name: ls.get(LS.name) || '',
  events: [], // все ночи с волнами (GET /api/event-upsert)
  ai: false, // подключён ли ИИ к разбору постов
  subs: 0, // подписчиков анонсов в боте
  night: ls.get(LS.night) || '', // выбранная ночь
  stats: null, // /api/stats по выбранной ночи
  statsAt: 0,
  dbOk: true,
  booted: false,
};

// ---------- шина ----------
const handlers = new Map();
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
}
export function emit(type, data) {
  for (const fn of handlers.get(type) || []) {
    try { fn(data); } catch (e) { console.error(`[${type}]`, e); }
  }
}
export const visible = (view) => document.body.dataset.view === view;

// ---------- запросы ----------
// → { ok, status, j, message }. Ошибки сети и таймауты не бросаются: панель
// всегда показывает человеку понятную причину.
export async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(path, {
      method,
      headers: {
        'X-Admin-Key': state.key,
        'X-Admin-Name': encodeURIComponent(state.name || ''),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const j = await r.json().catch(() => null);
    if (r.status === 403 && j && j.error === 'forbidden' && state.booted) emit('auth-lost');
    const ok = r.ok && Boolean(j && j.ok);
    return { ok, status: r.status, j: j || {}, message: (j && j.message) || (ok ? '' : `Сервер ответил ${r.status}`) };
  } catch (e) {
    return {
      ok: false, status: 0, j: {},
      message: e && e.name === 'AbortError' ? 'Сервер не ответил вовремя — попробуй ещё раз' : 'Нет связи с сервером — проверь интернет',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function reloadEvents() {
  const r = await api('/api/event-upsert');
  if (r.ok) {
    state.events = r.j.events || [];
    state.ai = Boolean(r.j.ai);
    state.subs = Number(r.j.subs || 0);
    state.dbOk = true;
    emit('events');
  } else if (r.status === 503) {
    state.dbOk = false;
    emit('events');
  }
  return r;
}

export async function loadStats() {
  const id = state.night;
  if (!id || !state.dbOk) return null;
  const r = await api(`/api/stats?event_id=${encodeURIComponent(id)}`);
  if (!r.ok || state.night !== id) return null; // ночь успели переключить — ответ устарел
  state.stats = r.j;
  state.statsAt = Date.now();
  emit('stats');
  return r.j;
}

export function setNight(id) {
  if (!id || id === state.night) return;
  state.night = id;
  state.stats = null;
  ls.set(LS.night, id);
  emit('night');
  loadStats();
}

// ---------- ночи: даты и статусы ----------
export const nightById = (id) => state.events.find((e) => e.id === id) || null;
export const endOf = (e) => (e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + 8 * 3600_000);
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

// фаза для людей: черновик / в продаже / идёт / закончилась / прошла / отменена
export function phaseOf(e, now = Date.now()) {
  if (!e) return 'none';
  if (e.status === 'draft') return 'draft';
  if (e.status === 'early') return now >= endOf(e) ? 'stale' : 'early';
  if (e.status === 'cancelled') return 'cancelled';
  if (e.status === 'past') return 'past';
  const s = Date.parse(e.startsAt);
  const end = endOf(e);
  if (now >= end) return 'stale'; // «в продаже», а ночь уже закончилась
  if (now >= s) return 'live';
  const pub = (e.waves || []).filter((w) => w.public !== false);
  if (e.status === 'soldout' || (pub.length && pub.every((w) => Number(w.sold) >= Number(w.quota)))) return 'soldout';
  return 'onsale';
}
const PHASE = {
  draft: ['Черновик', 'pill-draft'],
  early: ['Ранний доступ', 'pill-early'],
  onsale: ['В продаже', 'pill-onsale'],
  soldout: ['Распродано', 'pill-soldout'],
  live: ['Идёт сейчас', 'pill-live'],
  stale: ['Закончилась', 'pill-stale'],
  past: ['Прошла', 'pill-past'],
  cancelled: ['Отменена', 'pill-cancelled'],
  none: ['—', ''],
};
export const phaseLabel = (e) => PHASE[phaseOf(e)][0];
export const pill = (e) => {
  const [label, cls] = PHASE[phaseOf(e)];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};
// публичная страница есть только у ночей, которые видит афиша
export const isPublic = (e) => Boolean(e) && ['onsale', 'soldout', 'past'].includes(e.status);

export function countdown(e, now = Date.now()) {
  const s = Date.parse(e.startsAt);
  if (now >= endOf(e)) {
    const ago = Math.round((Date.parse(`${ymd(now)}T00:00:00+05:00`) - Date.parse(`${ymd(s)}T00:00:00+05:00`)) / 86400_000);
    return ago <= 0 ? 'сегодня' : ago === 1 ? 'вчера' : ago < 60 ? `${ago} ${plural(ago, 'день', 'дня', 'дней')} назад` : '';
  }
  if (now >= s) return 'идёт прямо сейчас';
  const days = Math.round((Date.parse(`${ymd(s)}T00:00:00+05:00`) - Date.parse(`${ymd(now)}T00:00:00+05:00`)) / 86400_000);
  if (days <= 0) return `сегодня в ${fmtTime(e.startsAt)}`;
  if (days === 1) return `завтра в ${fmtTime(e.startsAt)}`;
  return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

// кратко: «пт · 10 октября»
export const fmtDay = (iso) => fmtWhen(iso).replace(/ · \d{1,2}:\d{2}$/, '').toLowerCase();
export const rub = (n) => `${fmtRub(n)} ₽`;
export const priceLabel = (n) => (Number(n) === 0 ? 'бесплатно' : rub(n));
export const siteUrl = (e) => `${location.origin}/e/${encodeURIComponent(e.id)}`;
// +79991234567 → +7 999 123-45-67
export const fmtPhone = (p) => {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(String(p || ''));
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : String(p || '');
};
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';

// фон-афиша: картинка или фирменная заглушка с алым X
export const PH = `<span class="ph"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 14 L48 50 M48 14 L16 50" stroke="#e51a20" stroke-width="10" stroke-linecap="round"/></svg></span>`;
export const coverAttr = (url) => (url ? ` style="background-image:url('${esc(url)}')"` : '');
export const coverPh = (url) => (url ? '' : PH);

// ---------- иконки ----------
const P = {
  chart: '<path d="M5 20V11M12 20V4M19 20v-7"/>',
  ticket: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2.5L13 19V5L7.5 9H5a1 1 0 0 0-1 1z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sparkles: '<path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-8.5 8.5"/>',
  upload: '<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19.5h14"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17v.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM19.5 14v.5M14 19.5h.5M17 20h3v-3"/>',
  send: '<path d="M20.5 3.5 3.5 10.6l6.8 2.6 2.6 6.8z"/><path d="m10.3 13.2 4.2-4.2"/>',
  scan: '<path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3M4 12h16"/>',
  logout: '<path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5M10 16l4-4-4-4M14 12H4"/>',
  print: '<path d="M7 9V4h10v5M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17"/><rect x="7" y="14" width="10" height="6.5" rx="1"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  edit: '<path d="M4 20h4.5L19 9.5a2.1 2.1 0 0 0-3-3L5.5 17 4 20z"/><path d="m14.5 8 2.5 2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4.5-2.2 1.4a11 11 0 0 0 5.8 5.8l1.4-2.2 4.5 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  door: '<path d="M5 20.5h14M7 20.5V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v16"/><path d="M13.5 12h.5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
};
export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
// <i data-ic="…"> в разметке → svg
export function hydrateIcons(root = document) {
  for (const el of qsa('i[data-ic]', root)) el.outerHTML = icon(el.dataset.ic);
}

// ---------- уведомления ----------
export function toast(text, kind = 'ok', ms = 3600) {
  const host = $('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check')}<span>${esc(text)}</span>`;
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// ---------- диалоги ----------
// dialog({ title, body (html), actions: [{ label, value, kind, collect?, validate? }] })
// → Promise со значением нажатой кнопки; Esc и клик мимо → dismiss (null).
// Кнопки в разметке идут в обратном порядке, а показываются как задано:
// Enter в поле жмёт главную (последнюю) кнопку.
let dlgChain = Promise.resolve();
export function dialog(opts) {
  const run = () => new Promise((resolve) => {
    const d = $('dlg');
    const actions = opts.actions || [{ label: 'Понятно', value: true, kind: 'primary' }];
    d.innerHTML = `<form class="dlg-card" method="dialog">
      ${opts.title ? `<h2 class="dlg-t">${esc(opts.title)}</h2>` : ''}
      ${opts.body ? `<div class="dlg-b">${opts.body}</div>` : ''}
      <div class="dlg-a">${actions.map((a, i) => ({ a, i })).reverse()
        .map(({ a, i }) => `<button class="b ${KIND[a.kind || 'ghost']}" value="${i}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>
    </form>`;
    const form = d.querySelector('form');
    let result = opts.dismiss ?? null;
    form.addEventListener('submit', (ev) => {
      const btn = ev.submitter;
      const a = actions[btn ? Number(btn.value) : actions.length - 1];
      if (!a) return;
      if (a.validate && !a.validate(form)) { ev.preventDefault(); return; }
      result = a.collect ? a.collect(form) : a.value;
    });
    d.onclose = () => { d.onclose = null; resolve(result); };
    d.onclick = (ev) => { if (ev.target === d) d.close(); };
    if (opts.onMount) opts.onMount(d, (v) => { result = v; d.close(); });
    d.showModal();
    // фокус в поле — только где ввод и есть суть диалога: на телефоне он
    // поднимает клавиатуру и закрывает полэкрана
    const first = form.querySelector('[autofocus]');
    if (first) first.focus();
  });
  dlgChain = dlgChain.then(run, run);
  return dlgChain;
}
const KIND = { primary: 'b-primary', ghost: 'b-ghost', danger: 'b-danger-solid', ok: 'b-ok', quiet: 'b-quiet' };

export function confirmDlg({ title, text = '', html = '', ok = 'Подтвердить', cancel = 'Отмена', danger = false, kind = '' }) {
  return dialog({
    title,
    body: html || (text ? `<p>${esc(text)}</p>` : ''),
    actions: [{ label: cancel, value: false, kind: 'ghost' }, { label: ok, value: true, kind: kind || (danger ? 'danger' : 'primary') }],
    dismiss: false,
  });
}

export function promptDlg({ title, text = '', value = '', placeholder = '', ok = 'Сохранить', min = 1 }) {
  return dialog({
    title,
    body: `${text ? `<p>${esc(text)}</p>` : ''}<input class="in" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autofocus />`,
    actions: [
      { label: 'Отмена', value: null, kind: 'ghost' },
      {
        label: ok, kind: 'primary',
        validate: (f) => String(f.v.value).trim().length >= min,
        collect: (f) => String(f.v.value).trim(),
      },
    ],
  });
}

// ---------- мелочи ----------
export async function busy(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* нет буфера */ }
    ta.remove();
    return ok;
  }
}

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
