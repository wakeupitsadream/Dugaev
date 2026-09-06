// Обвязка простых страниц второго уровня (правила и подобные):
// шапка, меню, появление блоков, ссылка на директ.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';

initChrome();
observeReveal();
document.querySelectorAll('[data-dm]').forEach((a) => { a.href = SITE.instagramDm; });
