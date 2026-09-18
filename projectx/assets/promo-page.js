// Страница промоутера: личная ссылка с меткой src, QR, тексты для сторис.
// Продажи по ссылке видны в панели («Источники»). Сервера нет: всё считается
// в браузере, ссылка ведёт на страницу ближайшей ночи.
import { SITE } from './data/config.js';
import { initChrome, observeReveal } from './chrome.js';
import { loadEvents, upcoming, esc } from './events-load.js';
import { qrSvg } from './qr.js';
import { promoSlug, promoLink } from './promo-link.js';
import { ladderText, fmtRub, waveStates } from './waves.js';
import { dateBox } from './ticket-format.js';

const $ = (id) => document.getElementById(id);
const state = { event: null, link: '', texts: [] };

init();

async function init() {
  initChrome();
  observeReveal();
  if (SITE.promo && SITE.promo.rewardText) {
    $('pr-reward').textContent = SITE.promo.rewardText;
    $('pr-contact').href = SITE.promo.contact || SITE.instagramDm;
    $('pr-rules').hidden = false;
  }
  $('pr-make').addEventListener('click', make);
  $('pr-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
  $('pr-copy').addEventListener('click', () => copy(state.link, $('pr-copy')));
  const { events } = await loadEvents();
  state.event = upcoming(events)[0] || null;
  let saved = '';
  try { saved = localStorage.getItem('px_promo_name') || ''; } catch { /* приватный режим */ }
  if (saved) { $('pr-name').value = saved; make(); }
}

function make() {
  const name = $('pr-name').value;
  const slug = promoSlug(name);
  const err = $('pr-err');
  if (!slug) { err.classList.add('is-on'); $('pr-name').focus(); return; }
  err.classList.remove('is-on');
  try { localStorage.setItem('px_promo_name', name); } catch { /* приватный режим */ }
  const eventId = state.event ? state.event.id : 'px-260926';
  const link = promoLink(SITE.siteUrl, eventId, slug);
  state.link = link;
  $('pr-link').textContent = link;
  $('pr-open').href = link;
  const svg = qrSvg(link, { ecc: 'M', margin: 2 });
  $('pr-qr').innerHTML = svg;
  $('pr-qr-dl').href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  $('pr-qr-dl').download = `proxject-qr-${slug}.svg`;
  renderTexts(link);
  $('pr-out').hidden = false;
}

function renderTexts(link) {
  const e = state.event;
  const db = e ? dateBox(e.startsAt) : null;
  const when = db ? `${db.day} ${db.mon}` : '26 сен';
  const venue = e && e.venue ? e.venue : 'арт-локация «Режиссёр»';
  const ladder = (e && ladderText(e.waves)) || 'Первые 50 проходок — по 1 000 ₽, дальше дороже';
  const active = e ? waveStates((e.waves || []).filter((w) => w.public !== false)).find((w) => w.state === 'active') : null;
  const now = active ? `по ${fmtRub(active.priceRub)}` : 'по стартовой цене';
  state.texts = [
    { t: 'Сторис', s: `${when} — PROJECT X, ${venue}. Двери 22:00, до 04:00, 18+. ${ladder}. Беру себе и тебе: ${link}` },
    { t: 'В личку другу', s: `Го ${when} на PROJECT X? Четыре комнаты, танцпол, диджеи, всё до 04:00. Проходку бери тут, пока есть ${now}: ${link}` },
    { t: 'В чат группы или общаги', s: `Собираем компанию на PROJECT X ${when}, «Режиссёр», двери 22:00. Проходки именные, на сайте; на входе продают только если останутся места. Ссылка: ${link}` },
  ];
  $('pr-texts').innerHTML = state.texts.map((x, i) => `
    <article class="promo-text">
      <h3>${esc(x.t)}</h3>
      <p>${esc(x.s)}</p>
      <button class="btn btn-ghost" type="button" data-copy="${i}">Скопировать</button>
    </article>`).join('');
  $('pr-texts').querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => copy(state.texts[Number(b.dataset.copy)].s, b));
  });
}

async function copy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* буфер недоступен */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  const was = btn.textContent;
  btn.textContent = ok ? 'Скопировано' : 'Не вышло — выдели вручную';
  setTimeout(() => { btn.textContent = was; }, 1600);
}
