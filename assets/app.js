// Главная страница: hero, волны, афиша, галерея, контакты.
// Правило: данные и формулы — в модулях, здесь только связка с DOM.
import { SITE } from './data/config.js';
import { FACTS, GALLERY } from './data/events.js';
import { loadEvents, upcoming, pastEvents, esc } from './events-load.js';
import { waveStates, fromPrice, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel } from './ticket-format.js';

const $ = (id) => document.getElementById(id);

const state = {
  events: [],
  live: false,
  city: 'all',
  nearest: null,
};

init();

async function init() {
  renderMarquee();
  renderFacts();
  renderGallery();
  renderContacts();

  const { events, live } = await loadEvents();
  state.events = events;
  state.live = live;
  const up = upcoming(events);
  state.nearest = up[0] || null;

  renderHero();
  renderWavesPanel();
  renderAfisha();
  startCountdown();

  // живость счётчиков: раз в минуту обновляем «идут N» и лестницу волн
  setInterval(() => {
    renderWavesPanel();
  }, 60_000);
}

// ---------- HERO ----------
function renderHero() {
  const e = state.nearest;
  if (!e) return;
  const db = dateBox(e.startsAt);
  $('ne-day').textContent = db.day;
  $('ne-mon').textContent = db.mon;
  $('ne-title').textContent = e.title;
  $('ne-meta').textContent = `${SITE.cities[e.city] || e.city} · ${e.venue} · ${fmtWhen(e.startsAt)}`;
  $('ne-link').href = `/e/${e.id}`;
  $('next-event').hidden = false;

  const price = fromPrice(e.waves);
  const sticky = $('sticky-buy');
  sticky.href = `/e/${e.id}`;
  sticky.textContent = price ? `Билеты от ${price} ₽` : 'Смотреть афишу';
  $('header-buy').href = `/e/${e.id}`;
}

function renderFacts() {
  $('hero-facts').innerHTML = FACTS.map(
    (f) => `<div class="fact"><div class="f-num">${esc(f.n)}</div><div class="f-label">${esc(f.label)}</div></div>`
  ).join('');
}

function renderMarquee() {
  const words = [
    'TRAP HOUSE', '★', 'ОРЕНБУРГ', '★', 'МАГНИТОГОРСК', '★', 'ВХОД ПО QR', '★',
    'ЧЁРНЫЙ ДРЕСС-КОД', '★', '18+ ПО ПАСПОРТУ', '★', '16+ БЕЗ БАРА', '★',
  ];
  const half = words
    .map((w, i) => `<span class="${w === '★' ? 'm-acid' : ''}">${esc(w)}</span>`)
    .join('');
  $('marquee-track').innerHTML = half + half; // трек в две копии для бесшовного цикла
}

// ---------- COUNTDOWN ----------
let cdTimer = null;
function startCountdown() {
  const e = state.nearest;
  if (!e) return;
  const target = Date.parse(e.startsAt);
  const el = $('countdown');
  el.hidden = false;
  const tick = () => {
    let left = Math.max(0, target - Date.now());
    const d = Math.floor(left / 86400_000);
    left -= d * 86400_000;
    const h = Math.floor(left / 3600_000);
    left -= h * 3600_000;
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left - m * 60_000) / 1000);
    $('cd-d').textContent = String(d);
    $('cd-d-l').textContent = plural(d, 'день', 'дня', 'дней');
    $('cd-h').textContent = String(h).padStart(2, '0');
    $('cd-m').textContent = String(m).padStart(2, '0');
    $('cd-s').textContent = String(s).padStart(2, '0');
  };
  tick();
  clearInterval(cdTimer);
  cdTimer = setInterval(tick, 1000);
}

// ---------- ВОЛНЫ ----------
function renderWavesPanel() {
  const e = state.nearest;
  if (!e) return;
  const panel = $('waves-panel');
  const ws = waveStates(e.waves);
  const sold = totalSold(e.waves);
  const going = goingCount(e.id, Date.parse(e.startsAt), sold, Date.now());

  $('wp-event').textContent = `${e.title} · ${fmtWhen(e.startsAt)}`;
  $('wp-going').innerHTML = `уже ${plural(going, 'идёт', 'идут', 'идут')} <b>${going}</b> ${plural(going, 'человек', 'человека', 'человек')}`;

  $('wp-rows').innerHTML = ws
    .map((w) => {
      const pct = Math.round((w.sold / w.quota) * 100);
      let leftNote;
      if (w.state === 'past') leftNote = 'распродана';
      else if (w.state === 'active') leftNote = `<b>${w.left}</b> ${plural(w.left, 'билет', 'билета', 'билетов')} по этой цене`;
      else leftNote = 'откроется позже';
      return `
        <div class="wave-row is-${w.state}">
          <div class="wave-name">${esc(w.name)}<small class="wave-left">${leftNote}</small></div>
          <div></div>
          <div class="wave-price">${w.priceRub} ₽</div>
          <div class="wave-bar"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join('');

  const active = ws.find((w) => w.state === 'active');
  const buy = $('wp-buy');
  buy.href = `/e/${e.id}`;
  buy.textContent = active ? `Успеть за ${active.priceRub} ₽` : 'Все билеты проданы';
  if (!active) buy.classList.replace('btn-acid', 'btn-ghost');
  panel.hidden = false;
}

// ---------- АФИША ----------
function renderAfisha() {
  const grid = $('afisha-grid');
  const now = Date.now();
  const list = [...upcoming(state.events, now), ...pastEvents(state.events).slice(0, 1)];
  const filtered = list.filter((e) => state.city === 'all' || e.city === state.city);

  if (!filtered.length) {
    grid.innerHTML = `<p class="muted">В этом городе пока ничего не анонсировано — следи за нами в Telegram.</p>`;
    return;
  }

  grid.innerHTML = filtered.map((e) => cardHtml(e)).join('');

  document.querySelectorAll('#city-chips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.city = chip.dataset.city;
      document.querySelectorAll('#city-chips .chip').forEach((c) => c.classList.toggle('is-on', c === chip));
      renderAfisha();
    };
  });
}

function cardHtml(e) {
  const isPast = e.status === 'past';
  const db = dateBox(e.startsAt);
  const price = fromPrice(e.waves);
  const soldOut = !isPast && price === null;
  const poster = e.posterUrl
    ? `<img src="${esc(e.posterUrl)}" alt="${esc(e.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : '';
  let priceHtml;
  if (isPast) priceHtml = '<span class="muted">как это было</span>';
  else if (soldOut) priceHtml = '<span class="badge badge-soldout">sold out</span>';
  else priceHtml = `<small>от</small> ${price} ₽`;

  return `
    <a class="event-card ${isPast ? 'is-past' : ''}" href="/e/${esc(e.id)}">
      <div class="ec-poster ${e.posterUrl ? 'has-img' : ''}">
        ${poster}
        <span class="ec-word">${esc(e.title)}</span>
        <div class="ec-datebox"><b>${db.day}</b><small>${db.mon}</small></div>
        <div class="ec-badges">
          <span class="badge badge-age ${e.ageRating < 18 ? 'age-16' : ''}">${ageLabel(e.ageRating)}</span>
        </div>
      </div>
      <div class="ec-body">
        <div class="ec-title">${esc(e.title)}</div>
        <div class="ec-meta">${esc(SITE.cities[e.city] || e.city)} · ${esc(e.venue)}<br />${fmtWhen(e.startsAt)}</div>
        <div class="ec-foot">
          <div class="ec-price">${priceHtml}</div>
          <span class="ec-go">${isPast ? 'фотоотчёт' : 'билеты →'}</span>
        </div>
      </div>
    </a>`;
}

// ---------- ГАЛЕРЕЯ ----------
function renderGallery() {
  $('gallery').innerHTML = GALLERY.map(
    (g) => `
      <div class="g-item">
        <span class="g-glyph">TH</span>
        <div class="g-title">${esc(g.title)}</div>
        <div class="g-note">${esc(g.note)}</div>
      </div>`
  ).join('');
}

// ---------- КОНТАКТЫ ----------
function renderContacts() {
  const cards = [
    { kind: 'Telegram', val: 'Канал TRAP HOUSE', note: 'Анонсы, розыгрыши, афтемуви', href: SITE.tgChannel },
    { kind: 'VK', val: 'Группа VK', note: 'Фотоотчёты со всех тусовок', href: SITE.vk },
    { kind: 'Сотрудничество', val: `@${SITE.tgManager}`, note: 'Площадкам, артистам, спонсорам', href: `https://t.me/${SITE.tgManager}` },
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
