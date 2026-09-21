// Обвязка простых страниц второго уровня (правила и подобные):
// шапка, меню, появление блоков, ссылка на директ.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';
import { loadEvents, upcoming } from './events-load.js';
import { fillSecretNote } from './blocks.js';

initChrome();
observeReveal();
document.querySelectorAll('[data-dm]').forEach((a) => { a.href = SITE.instagramDm; });
// Правило SECRET PLACE на /night дописывает, открыт ли адрес ближайшей ночи
if (document.querySelector('[data-secret-note]')) {
  loadEvents().then(({ events }) => fillSecretNote(upcoming(events)[0] || null)).catch(() => {});
}
