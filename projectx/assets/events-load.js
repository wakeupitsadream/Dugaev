// Загрузка афиши: /api/events → при недоступности молча падаем на сид
// с детерминированной демо-симуляцией продаж. Гость ошибок не видит.
import { EVENTS } from './data/events.js';
import { demoWaves } from './waves.js';
import { SITE } from './data/config.js';

export async function loadEvents(nowMs = Date.now()) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000); // медленный мобильный интернет — не повод показывать сид
    const r = await fetch('/api/events', { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const j = await r.json();
      if (j && j.ok && Array.isArray(j.events) && j.events.length) {
        return { events: j.events, live: !j.degraded };
      }
    }
  } catch {
    /* деградация без ошибок */
  }
  return {
    // Скрытые волны (гостевой список) публике не показываем — как в /api/events
    // боевой сайт остатки не выдумывает: без API — sold = 0 и никаких «уже идут»
    events: EVENTS.map((e) => withDerivedStatus({
      ...e,
      waves: SITE.paymentDemo
        ? demoWaves({ ...e, waves: e.waves.filter((w) => w.public !== false) }, nowMs)
        : e.waves.filter((w) => w.public !== false).map((w) => ({ ...w, sold: 0 })),
    }, nowMs)),
    live: false,
  };
}

// Ночь закончилась, а в данных она «в продаже» (сид без базы, кэш):
// для гостя это уже прошлое — как derivedStatus на сервере
export function withDerivedStatus(e, nowMs = Date.now()) {
  if (e.status !== 'onsale' && e.status !== 'soldout') return e;
  const end = e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + 8 * 3600_000;
  return Number.isFinite(end) && end <= nowMs ? { ...e, status: 'past' } : e;
}

export function upcoming(events, nowMs = Date.now()) {
  return events
    // ночь «живая» до своего конца (без конца — 8 часов после старта), как и на сервере
    .filter((e) => e.status === 'onsale' && (e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + 8 * 3600_000) > nowMs)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export function pastEvents(events) {
  return events
    .filter((e) => e.status === 'past')
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
