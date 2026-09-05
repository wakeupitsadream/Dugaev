// Загрузка афиши: /api/events → при недоступности молча падаем на сид
// с детерминированной демо-симуляцией продаж. Гость ошибок не видит.
import { EVENTS } from './data/events.js';
import { demoWaves } from './waves.js';

export async function loadEvents(nowMs = Date.now()) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
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
    events: EVENTS.map((e) => ({ ...e, waves: demoWaves(e, nowMs) })),
    live: false,
  };
}

export function upcoming(events, nowMs = Date.now()) {
  return events
    .filter((e) => e.status === 'onsale' && Date.parse(e.endsAt || e.startsAt) > nowMs)
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
