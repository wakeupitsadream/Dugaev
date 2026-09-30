// Обвязка простых страниц второго уровня (правила и подобные):
// шапка, меню, появление блоков, ссылка на директ.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';
import { loadEvents, upcoming } from './events-load.js';
import { fillEventCopy } from './blocks.js';

initChrome();
observeReveal();
document.querySelectorAll('[data-dm]').forEach((a) => { a.href = SITE.instagramDm; });
// Приписка SECRET PLACE и дата возврата зависят от ближайшей ночи в афише
if (document.querySelector('[data-secret-note], [data-refund-until]')) {
  loadEvents().then(({ events }) => fillEventCopy(upcoming(events)[0] || null)).catch(() => {});
}
