// Счётчик «идут N человек» — чистая логика без DOM.
// При живых продажах (>= REAL_THRESHOLD билетов) показываем реальное число.
// Иначе — детерминированная симуляция: базовое число от хеша ивента,
// рост к дате, «живость» от 10-минутного ведра. Симуляция — только для демо,
// в бою помечается и заменяется реальными данными (см. BRIEF.md).
import { hash } from './waves.js';

export const REAL_THRESHOLD = 40;
const RAMP_DAYS = 30;

export function goingCount(eventId, startsAtMs, soldTotal, nowMs) {
  if (soldTotal >= REAL_THRESHOLD) return soldTotal;
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
