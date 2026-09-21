// Условия покупки: продавец, реквизиты перевода, срок возврата, лесенка цен
// и порядок чека подставляются из конфига и афиши — текст на странице
// всегда совпадает с тем, что реально настроено.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';
import { loadEvents, upcoming, esc } from './events-load.js';
import { ladderText } from './waves.js';

initChrome();
observeReveal();

const L = SITE.legal || {};
const T = SITE.transfer || {};
const $ = (id) => document.getElementById(id);
const fmtDate = (iso) => (iso
  ? new Date(`${iso}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: SITE.tz }).replace(/\s*г\.$/, '')
  : '');

// продавец
const seller = `${L.status ? `${L.status} ` : ''}${L.operator || 'организатор ночей PROJECT X'}`;
document.querySelectorAll('[data-seller]').forEach((el) => { el.textContent = seller; });
document.querySelectorAll('[data-legal-role]').forEach((el) => { el.textContent = L.roleNote || 'организатор ночей PROJECT X'; });
document.querySelectorAll('[data-dm]').forEach((a) => { a.href = SITE.instagramDm; });
document.querySelectorAll('[data-ig-name]').forEach((el) => { el.textContent = SITE.instagramName; });
document.querySelectorAll('[data-legal-updated]').forEach((el) => { el.textContent = fmtDate(L.policyUpdated); });
document.querySelectorAll('[data-refund-until]').forEach((el) => { el.textContent = fmtDate(SITE.refundUntil) || 'даты, указанной в FAQ'; });
document.querySelectorAll('[data-hold-hours]').forEach((el) => { el.textContent = String(SITE.holdHours || 3); });

// реквизиты перевода — те же, что на экране брони
document.querySelectorAll('[data-transfer-phone]').forEach((el) => { el.textContent = T.phone || '—'; });
document.querySelectorAll('[data-transfer-bank]').forEach((el) => { el.textContent = T.bank || ''; });
document.querySelectorAll('[data-transfer-recipient]').forEach((el) => { el.textContent = T.recipient || ''; });

// чек: самозанятый — из «Мой налог», ИП — кассовый
const selfEmployed = /самозанят/i.test(L.status || '');
document.querySelectorAll('[data-receipt]').forEach((el) => {
  el.textContent = selfEmployed
    ? 'Продавец применяет налог на профессиональный доход: чек формируется в приложении «Мой налог» после подтверждения оплаты и присылается тебе в Telegram-бот или в директ по запросу.'
    : 'Кассовый чек формируется после подтверждения оплаты и присылается тебе в Telegram-бот или в директ по запросу.';
});

// реквизиты продавца: только заполненные строки
const props = [
  ['Статус', L.status ? L.status[0].toUpperCase() + L.status.slice(1) : ''],
  ['ИНН', L.inn],
  ['ОГРНИП', L.ogrnip],
  ['Адрес', L.address],
  ['E-mail', L.email ? `<a href="mailto:${esc(L.email)}">${esc(L.email)}</a>` : ''],
].filter(([, v]) => v);
for (const dl of [$('seller-props'), $('seller-props-2')]) {
  if (!dl) continue;
  if (props.length) dl.innerHTML = props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  else dl.hidden = true;
}
const emailLi = $('offer-email');
if (emailLi) {
  if (L.email) emailLi.innerHTML = `по электронной почте <a href="mailto:${esc(L.email)}">${esc(L.email)}</a>;`;
  else emailLi.remove();
}

// цены — из афиши (панель), а не из HTML
loadEvents().then(({ events }) => {
  const e = upcoming(events)[0];
  const ladder = e ? ladderText(e.waves) : null;
  document.querySelectorAll('[data-ladder]').forEach((el) => { if (ladder) el.textContent = ladder; });
}).catch(() => {});
