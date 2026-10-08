// Согласие на cookie Яндекс Метрики (152-ФЗ): счётчик запускается только
// после «Разрешить». Плашка появляется, только если счётчик настроен
// (SITE.metrikaId) и гость ещё не выбирал. Выбор живёт в памяти браузера,
// поменять его можно на странице политики (раздел 6).
import { SITE } from './data/config.js';

const KEY = 'px_consent_metrika';
export const consentNeeded = () => Boolean(Number(SITE.metrikaId));

// → 'yes' | 'no' | null (ещё не выбирал или память браузера недоступна)
export function consentState() {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw).v : null;
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

function save(v) {
  try { localStorage.setItem(KEY, JSON.stringify({ v, at: new Date().toISOString() })); } catch { /* приватный режим: спросим на следующей странице */ }
}

// Отказ после согласия: стираем cookie Метрики (_ym_*) этого сайта
function dropYmCookies() {
  try {
    const host = location.hostname;
    const domains = ['', host, `.${host.replace(/^www\./, '')}`];
    document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => n.startsWith('_ym')).forEach((n) => {
      domains.forEach((d) => { document.cookie = `${n}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`; });
    });
  } catch { /* не критично */ }
}

let accept = null;

// onAccept — запуск счётчика: сразу, если согласие уже есть, или после «Разрешить»
export function initConsent({ onAccept }) {
  accept = onAccept;
  if (!consentNeeded()) return;
  const st = consentState();
  if (st === 'yes') onAccept();
  else if (st === null) showConsent();
}

export function setConsent(v) {
  const was = consentState();
  save(v);
  hideConsent();
  if (v === 'yes' && accept) accept();
  if (v === 'no' && was === 'yes') dropYmCookies();
  try { document.dispatchEvent(new CustomEvent('px:consent', { detail: v })); } catch { /* старый браузер */ }
}

export function showConsent() {
  if (!consentNeeded() || typeof document === 'undefined' || document.getElementById('consent-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'consent-bar';
  bar.className = 'consent';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Cookie и статистика посещений');
  bar.innerHTML = `
    <p>Разрешаешь сайту считать посещения через Яндекс Метрику? Она ставит cookie. Имена, телефоны и брони ей не передаются. <a href="/privacy#cookies">Подробнее</a></p>
    <div class="consent-acts">
      <button type="button" class="btn btn-ghost" data-consent="no">Нет</button>
      <button type="button" class="btn btn-acid" data-consent="yes">Разрешить</button>
    </div>`;
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-consent]');
    if (b) setConsent(b.dataset.consent === 'yes' ? 'yes' : 'no');
  });
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('is-in'));
}

function hideConsent() {
  const bar = typeof document !== 'undefined' && document.getElementById('consent-bar');
  if (!bar) return;
  bar.classList.remove('is-in');
  const done = () => bar.remove();
  bar.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400); // без анимации (reduced motion) transitionend не придёт
}
