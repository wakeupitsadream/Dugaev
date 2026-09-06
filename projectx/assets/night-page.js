// Страница «Ночь»: три правила (сцена по скроллу), как устроена ночь
// (таймлайн, который заполняется по мере прокрутки), резиденты.
import { loadEvents, upcoming } from './events-load.js';
import { initChrome, observeReveal } from './chrome.js';
import { initNightScene, renderBands, pointBuyLinks, reduced } from './blocks.js';

const $ = (id) => document.getElementById(id);

init();

async function init() {
  initChrome();
  initNightScene('night');
  renderBands();
  initTimeline();
  observeReveal();
  const { events } = await loadEvents();
  pointBuyLinks(upcoming(events)[0] || null);
}

// Таймлайн ночи: вертикальная линия заливается вслед за прокруткой, остановки
// зажигаются, когда проходят середину экрана. Только transform и класс.
function initTimeline() {
  const tl = $('timeline');
  if (!tl) return;
  const fill = tl.querySelector('.tl-fill');
  const stops = [...tl.querySelectorAll('.tl-stop')];
  if (reduced.matches) { stops.forEach((s) => s.classList.add('is-on')); fill.style.transform = 'scaleY(1)'; return; }
  let raf = 0;
  const update = () => {
    raf = 0;
    const r = tl.getBoundingClientRect();
    const mid = window.innerHeight * 0.55;
    const p = Math.min(1, Math.max(0, (mid - r.top) / r.height));
    fill.style.transform = `scaleY(${p.toFixed(4)})`;
    stops.forEach((s) => {
      const sr = s.getBoundingClientRect();
      s.classList.toggle('is-on', sr.top + 24 < mid);
    });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}
