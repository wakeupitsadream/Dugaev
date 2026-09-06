// Страница «FC/DC»: фейсконтроль-интерактив, дресс-код, что взять с собой,
// как это выглядит на дверях.
import { loadEvents, upcoming } from './events-load.js';
import { initChrome, observeReveal } from './chrome.js';
import { initFaceControl, pointBuyLinks } from './blocks.js';

const $ = (id) => document.getElementById(id);

init();

async function init() {
  initChrome();
  initFaceControl();
  initChecklist();
  observeReveal();
  const { events } = await loadEvents();
  pointBuyLinks(upcoming(events)[0] || null);
}

// Чеклист «с собой»: отмечаешь — и когда всё собрано, страница это замечает.
// Первый и единственный раз за визит — редкий момент, ему положено немного
// восторга.
function initChecklist() {
  const list = $('pack-list');
  if (!list) return;
  const done = $('pack-done');
  const items = [...list.querySelectorAll('input[type="checkbox"]')];
  const check = () => {
    const all = items.every((i) => i.checked);
    done.hidden = !all;
    if (all) done.classList.add('is-in');
  };
  items.forEach((i) => i.addEventListener('change', check));
}
