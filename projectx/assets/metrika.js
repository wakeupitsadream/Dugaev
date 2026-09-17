// Яндекс.Метрика. Подключается только при SITE.metrikaId — без номера
// счётчика на страницу не попадает ни байта чужого кода. Цели через track():
// ошибки метрики не должны ронять бронь, поэтому всё в try.
import { SITE } from './data/config.js';

const counter = () => Number(SITE.metrikaId) || 0;

export function initMetrika() {
  const id = counter();
  if (!id || typeof window === 'undefined' || window.ym) return;
  window.ym = function ym() { (window.ym.a = window.ym.a || []).push(arguments); };
  window.ym.l = Date.now();
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://mc.yandex.ru/metrika/tag.js';
  document.head.appendChild(s);
  window.ym(id, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
}

export function track(goal, params) {
  const id = counter();
  if (!id || typeof window === 'undefined' || typeof window.ym !== 'function') return;
  try { window.ym(id, 'reachGoal', goal, params || undefined); } catch { /* аналитика не важнее брони */ }
}
