// Политика конфиденциальности: реквизиты оператора, дата редакции и статус
// Метрики подставляются из конфига — текст на странице всегда совпадает с
// тем, что реально настроено.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';
import { esc } from './events-load.js';
import { consentNeeded, consentState, showConsent } from './consent.js';

initChrome();
observeReveal();

const L = SITE.legal || {};
const $ = (id) => document.getElementById(id);

// оператор и связь
const OP = L.operator || {};
const SE = L.seller || {};
document.querySelectorAll('[data-legal-operator]').forEach((el) => { el.textContent = OP.name || 'организатор ночей PROJECT X'; });
document.querySelectorAll('[data-seller]').forEach((el) => {
  el.textContent = SE.name ? `${SE.status ? `${SE.status} ` : ''}${SE.name}` : 'продавец проходок';
});
document.querySelectorAll('[data-dm]').forEach((a) => { a.href = SITE.instagramDm; });
document.querySelectorAll('[data-ig-name]').forEach((el) => { el.textContent = SITE.instagramName; });

// реквизиты: только заполненные строки, пустой блок скрывается
const props = [
  ['ИНН', OP.inn],
  ['ОГРНИП', OP.ogrnip],
  ['Адрес', OP.address],
  ['E-mail', OP.email ? `<a href="mailto:${esc(OP.email)}">${esc(OP.email)}</a>` : ''],
].filter(([, v]) => v);
const dl = $('legal-props');
if (dl) {
  if (props.length) dl.innerHTML = props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  else dl.hidden = true;
}
const emailLi = $('legal-email');
if (emailLi) {
  if (OP.email) emailLi.innerHTML = `по электронной почте <a href="mailto:${esc(OP.email)}">${esc(OP.email)}</a>;`;
  else emailLi.remove();
}

// дата редакции
const upd = L.policyUpdated ? new Date(`${L.policyUpdated}T12:00:00+05:00`) : null;
document.querySelectorAll('[data-legal-updated]').forEach((el) => {
  el.textContent = upd
    ? upd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: SITE.tz }).replace(/\s*г\.$/, '')
    : '';
});
document.querySelectorAll('[data-retention]').forEach((el) => { el.textContent = String(L.retentionMonths || 12); });

// Метрика: честный статус и выбор гостя — поменять можно здесь же
const on = consentNeeded();
document.querySelectorAll('[data-metrika-status]').forEach((el) => {
  el.textContent = on ? 'включается только с твоего согласия' : 'сейчас выключена';
});
const ctl = document.querySelector('[data-consent-ctl]');
if (ctl && on) {
  const now = ctl.querySelector('[data-consent-now]');
  const paint = () => {
    const st = consentState();
    now.textContent = st === 'yes' ? 'статистика разрешена' : st === 'no' ? 'статистика запрещена' : 'не выбрано';
  };
  paint();
  ctl.hidden = false;
  ctl.querySelector('[data-consent-change]').addEventListener('click', showConsent);
  document.addEventListener('px:consent', paint);
}
