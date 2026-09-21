// Счётчик «идут N человек» — чистая логика без DOM.
// В бою показываем только реальное число и только когда оно уже что-то
// значит (>= REAL_THRESHOLD проходок); ниже порога счётчика нет вовсе —
// null, и карточка его не рисует. Симуляция (базовое число от хеша ивента,
// рост к дате, «живость» от 10-минутного ведра) включается только на
// демо-стенде (demo: true) — гостю боевого сайта выдуманных цифр не показываем.
import { hash } from './waves.js';

export const REAL_THRESHOLD = 20;
const RAMP_DAYS = 30;

export function goingCount(eventId, startsAtMs, soldTotal, nowMs, { demo = false } = {}) {
  if (soldTotal >= REAL_THRESHOLD) return soldTotal;
  if (!demo) return null;
  const base = 70 + (hash(eventId) % 90); // 70..159 — правдоподобно для города
  const saleStart = startsAtMs - RAMP_DAYS * 86400_000;
  const t = clamp((nowMs - saleStart) / (startsAtMs - saleStart), 0, 1);
  const ramp = Math.round(base * (0.3 + 0.7 * t));
  const bucket = Math.floor(nowMs / 600_000);
  const drip = hash(`${eventId}:going:${bucket}`) % 3; // 0..2
  return ramp + soldTotal + drip;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
