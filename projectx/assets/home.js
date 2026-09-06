// Главная PROJECT X: сцена со знаком, три правила по скроллу, афиша,
// лента афиш, манифест, программа, фейсконтроль. Блоки — в blocks.js,
// здесь только порядок сборки, живой знак и то, что есть лишь на главной.
import { loadEvents, upcoming, esc } from './events-load.js';
import { fromPrice } from './waves.js';
import { plural, dateBox, fmtWhen, ageLabel } from './ticket-format.js';
import { springTo } from './spring.js';
import { initChrome, observeReveal, wrapWords } from './chrome.js';
import {
  reduced, finePointer, renderAfisha, renderReel, initNightScene, renderBands, initFaceControl, pointBuyLinks,
} from './blocks.js';

const $ = (id) => document.getElementById(id);
const state = { events: [], nearest: null };

init();

async function init() {
  initChrome();
  renderBands();
  renderReel('reel');
  initManifest();
  initFaceControl();
  initHeroMotion();
  initNightScene('night');
  observeReveal();

  const { events } = await loadEvents();
  state.events = events;
  state.nearest = upcoming(events)[0] || null;
  renderNext();
  renderAfisha('afisha-grid', upcoming(state.events));
  renderCta();
  pointBuyLinks(state.nearest);
  startCountdown();

  // раз в минуту подтягиваем остатки волн — лестница не должна врать
  setInterval(async () => {
    const fresh = await loadEvents();
    state.events = fresh.events;
    state.nearest = upcoming(fresh.events)[0] || null;
    renderAfisha('afisha-grid', upcoming(state.events));
    renderNext();
  }, 60_000);
}

// ---------- Ближайшая ночь в hero ----------
function renderNext() {
  const e = state.nearest;
  const card = $('next-event');
  if (!e) { card.hidden = true; return; }
  const db = dateBox(e.startsAt);
  const price = fromPrice(e.waves);
  $('ne-day').textContent = db.day;
  $('ne-mon').textContent = db.mon;
  $('ne-title').textContent = e.title;
  $('ne-meta').innerHTML = `<b>${esc(e.venue || 'SECRET PLACE')}</b> · ${esc(fmtWhen(e.startsAt))} · ${esc(ageLabel(e.ageRating))}`;
  $('ne-link').textContent = price ? `Взять проходку · от ${price} ₽` : 'Подробнее';
  card.href = `/e/${e.id}`;
  card.hidden = false;
}

function renderCta() {
  const e = state.nearest;
  if (!e) return;
  const price = fromPrice(e.waves);
  const db = dateBox(e.startsAt);
  $('cta-lead').innerHTML =
    `<b>${db.day} ${esc(db.mon)}</b> · ${esc(e.venue || 'SECRET PLACE')}${price ? ` · от <b>${price} ₽</b>` : ''}. ` +
    'Проходка берётся за минуту, вход — по именному QR. Адрес придёт в проходку перед стартом.';
  $('cta-buy').textContent = price ? `Взять проходку · ${price} ₽` : 'Подробнее о ночи';
}

// ---------- Счётчик ----------
let cdTimer = null;
function startCountdown() {
  const e = state.nearest;
  if (!e) return;
  const target = Date.parse(e.startsAt);
  $('countdown').hidden = false;
  const tick = () => {
    let left = Math.max(0, target - Date.now());
    const d = Math.floor(left / 86400_000);
    left -= d * 86400_000;
    const h = Math.floor(left / 3600_000);
    left -= h * 3600_000;
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left - m * 60_000) / 1000);
    $('cd-d').textContent = String(d);
    $('cd-d-l').textContent = plural(d, 'день', 'дня', 'дней');
    $('cd-h').textContent = String(h).padStart(2, '0');
    $('cd-m').textContent = String(m).padStart(2, '0');
    $('cd-s').textContent = String(s).padStart(2, '0');
  };
  tick();
  clearInterval(cdTimer);
  cdTimer = setInterval(tick, 1000);
}

// ---------- Живой знак в hero ----------
// Курсор наклоняет знак и уводит свет — через пружину, а не напрямую:
// прямая привязка к мыши выглядит механической, у пружины есть инерция.
// На телефоне знак и свет отвечают на прокрутку (параллакс в три слоя).
function initHeroMotion() {
  if (reduced.matches) return;
  const hero = $('hero');
  const mark = $('hero-mark');
  const light = $('hero-light');
  const bgx = $('hero-bgx');
  if (!hero || !mark) return;

  const pose = { rx: 0, ry: 0, lx: 0, ly: 0, scroll: 0 };
  const apply = () => {
    mark.style.transform = `perspective(900px) rotateX(${pose.rx.toFixed(2)}deg) rotateY(${pose.ry.toFixed(2)}deg) translate3d(0, ${(pose.scroll * 0.18).toFixed(1)}px, 0)`;
    light.style.transform = `translate3d(${pose.lx.toFixed(1)}px, ${(pose.ly + pose.scroll * 0.12).toFixed(1)}px, 0)`;
    bgx.style.transform = `translate3d(0, ${(pose.scroll * 0.06).toFixed(1)}px, 0) rotate(${(pose.scroll * 0.02).toFixed(2)}deg)`;
  };
  // пружина, которую можно дёргать сколько угодно: новая цель — та же пружина
  const tracker = (key) => {
    let sp = null;
    return (target) => {
      if (sp && !sp.done) { sp.retarget(target); return; }
      sp = springTo({ from: pose[key], to: target, damping: 1, response: 0.55, onUpdate: (v) => { pose[key] = v; apply(); } });
    };
  };
  const toRx = tracker('rx');
  const toRy = tracker('ry');
  const toLx = tracker('lx');
  const toLy = tracker('ly');

  if (finePointer.matches) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      toRy(nx * 9);
      toRx(-ny * 7);
      toLx(nx * 48);
      toLy(ny * 30);
    });
    hero.addEventListener('pointerleave', () => { toRx(0); toRy(0); toLx(0); toLy(0); });
  }

  let raf = 0;
  const onScroll = () => {
    raf = 0;
    const y = window.scrollY;
    if (y > window.innerHeight * 1.2) return; // сцена ушла — не считаем зря
    pose.scroll = y;
    apply();
  };
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(onScroll); }, { passive: true });
}

// ---------- Манифест: слова входят по одному ----------
function initManifest() {
  const ps = [...document.querySelectorAll('#manifest p:not(.m-note)')];
  ps.forEach((p) => {
    wrapWords(p);
    p.querySelectorAll('.w').forEach((w, i) => { w.style.transitionDelay = `${Math.min(i * 34, 900)}ms`; });
  });
  if (!('IntersectionObserver' in window)) { ps.forEach((p) => p.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
  }, { threshold: 0.35 });
  ps.forEach((p) => io.observe(p));
}
