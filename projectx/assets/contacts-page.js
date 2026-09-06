// Страница контактов: карточки связи + «Привезите к нам».
import { SITE } from './data/config.js';
import { esc } from './events-load.js';
import { initChrome, observeReveal } from './chrome.js';
import { initCityForm } from './city-form.js';

const $ = (id) => document.getElementById(id);

initChrome();
renderContacts();
initCityForm();
observeReveal();

function renderContacts() {
  const cards = [
    { kind: 'Instagram', val: SITE.instagramName, note: 'Анонсы, афиши и афтер-муви — тут раньше всех', href: SITE.instagram },
    { kind: 'Директ', val: 'Написать организаторам', note: 'Вопросы по проходкам, столам и возвратам', href: SITE.instagramDm },
    { kind: 'Сотрудничество', val: 'Партнёрам и площадкам', note: 'Реклама, интеграции, свои города', href: SITE.instagramDm },
  ];
  $('contact-cards').innerHTML = cards
    .map(
      (c) => `
      <a class="contact-card" href="${esc(c.href)}" target="_blank" rel="noopener">
        <span class="cc-kind">${esc(c.kind)}</span>
        <span class="cc-val">${esc(c.val)}</span>
        <span class="cc-note">${esc(c.note)}</span>
      </a>`
    )
    .join('');
}
