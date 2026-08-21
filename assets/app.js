// Главная страница: hero, волны, афиша, шоу-программа, фотолента,
// фейсконтроль, заявки городов, контакты. Данные и формулы — в модулях,
// здесь только связка с DOM.
import { SITE } from './data/config.js';
import { FACTS, GALLERY, SHOW_PROGRAM } from './data/events.js';
import { loadEvents, upcoming, pastEvents, esc } from './events-load.js';
import { waveStates, fromPrice, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel } from './ticket-format.js';
import { faceControl, shareText } from './facecontrol.js';

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
  renderProgram();
  renderStrip();
  renderContacts();
  initFaceControl();
  initCityForm();
  $('parents-contact').href = `https://t.me/${SITE.tgManager}`;

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
  $('ne-meta').textContent = `${SITE.cities[e.city] || e.city} · ${fmtWhen(e.startsAt)} · ${ageLabel(e.ageRating)}`;
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
    '14+', '★', 'БЕЗ АЛКОГОЛЯ', '★', 'ДНЁМ', '★', 'ДО 22:00', '★',
    'ВХОД ПО QR', '★', 'ОРЕНБУРГ', '★', 'МАГНИТОГОРСК', '★',
  ];
  const half = words
    .map((w) => `<span class="${w === '★' ? 'm-acid' : ''}">${esc(w)}</span>`)
    .join('');
  $('marquee-track').innerHTML = half + half; // трек в две копии для бесшовного цикла
}

// ---------- COUNTDOWN ----------
let cdTimer = null;
function startCountdown() {
  const e = state.nearest;
  if (!e) return;
  const target = Date.parse(e.startsAt);
  $('countdown').hidden = false;
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
  $('waves-panel').hidden = false;
}

// ---------- АФИША ----------
function renderAfisha() {
  const grid = $('afisha-grid');
  const now = Date.now();
  const list = [...upcoming(state.events, now), ...pastEvents(state.events).slice(0, 1)];
  const filtered = list.filter((e) => state.city === 'all' || e.city === state.city);

  if (!filtered.length) {
    grid.innerHTML = `<p class="muted">В этом городе пока ничего не анонсировано — следи за <a class="acid" href="${esc(SITE.tgChannel)}" target="_blank" rel="noopener">телегой</a>.</p>`;
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
          <span class="badge badge-dry">0% алк</span>
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

// ---------- ШОУ-ПРОГРАММА ----------
function renderProgram() {
  $('program-grid').innerHTML = SHOW_PROGRAM.map(
    (p, i) => `
      <div class="program-item">
        <span class="p-num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.text)}</p>
      </div>`
  ).join('');
}

// ---------- ФОТОЛЕНТА ----------
function renderStrip() {
  $('strip').innerHTML = GALLERY.map(
    (g) => `
      <figure class="strip-item">
        <img src="${esc(g.src)}" alt="${esc(g.title)}" loading="lazy" onerror="this.closest('figure').classList.add('no-img')" />
        <figcaption><span class="strip-tag">${esc(g.title)}</span><span class="strip-note">${esc(g.note)}</span></figcaption>
      </figure>`
  ).join('');
}

// ---------- ФЕЙСКОНТРОЛЬ ----------
function initFaceControl() {
  const input = $('face-age');
  const run = () => {
    const r = faceControl(input.value);
    if (r.verdict === 'invalid') {
      input.focus();
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    const bubble = $('face-bubble');
    bubble.className = `face-bubble fb-${r.verdict}`;
    $('fb-title').textContent = r.title;
    $('fb-sub').textContent = r.sub;
    $('face-result').classList.remove('hidden');
    const copy = $('face-copy');
    copy.textContent = 'Скопировать и похвастаться';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareText(r, location.origin));
        copy.textContent = 'Скопировано';
      } catch {
        copy.textContent = 'Не вышло — заскринь';
      }
    };
  };
  $('face-check').onclick = run;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('face-again').onclick = () => {
    $('face-result').classList.add('hidden');
    input.value = '';
    input.focus();
  };
}

// ---------- ПРИВЕЗИТЕ К НАМ ----------
function initCityForm() {
  const done = new Set(SITE.homeCities);
  $('city-request-chips').innerHTML = [
    ...SITE.homeCities.map((c) => `<span class="chip is-on">${esc(c)} ✓</span>`),
    ...SITE.expansionCities.map((c) => `<button type="button" class="chip" data-city="${esc(c)}">${esc(c)}</button>`),
    `<span class="chip chip-ghost">Твой город?</span>`,
  ].join('');
  document.querySelectorAll('#city-request-chips .chip[data-city]').forEach((chip) => {
    chip.onclick = () => {
      $('cf-city').value = chip.dataset.city;
      $('cf-contact').focus();
    };
  });

  $('cf-consent').onchange = (e) => {
    if (e.target.checked) e.target.closest('.check')?.classList.remove('is-error');
  };
  const form = $('city-form');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const city = $('cf-city').value.trim();
    const contact = $('cf-contact').value.trim();
    const consent = $('cf-consent').checked;
    let bad = false;
    toggleErr('cf-city', city.length < 2) && (bad = true);
    toggleErr('cf-contact', contact.length < 2) && (bad = true);
    toggleErr('cf-consent', !consent) && (bad = true);
    $('cf-consent').closest('.check')?.classList.toggle('is-error', !consent);
    if (bad || done.has(city)) {
      if (done.has(city)) $('cf-note').textContent = `${city} — мы уже здесь! Следи за афишей выше.`;
      return;
    }
    const btn = $('cf-send');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    let ok = false;
    try {
      const r = await fetch('/api/cityrequest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, contact, consent, website: $('cf-website').value }),
      });
      ok = r.ok;
    } catch { /* деградация ниже */ }
    btn.disabled = false;
    if (ok) {
      btn.textContent = 'Заявка принята';
      $('cf-note').textContent = `${city} в списке. Как наберётся достаточно заявок — напишем тебе первому.`;
    } else {
      // сервер недоступен — отправка заявки напрямую в телегу, без ошибок
      btn.textContent = 'Отправить заявку';
      const text = `Привет! Привезите TRAP HOUSE в ${city}. Мой контакт: ${contact}`;
      window.open(`https://t.me/${SITE.tgManager}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      $('cf-note').textContent = 'Открыли телегу — жми «Отправить», заявка уйдёт напрямую организаторам.';
    }
  };

  function toggleErr(id, isBad) {
    const el = $(`err-${id}`);
    if (el) el.style.display = isBad ? 'block' : 'none';
    return isBad;
  }
}

// ---------- КОНТАКТЫ ----------
function renderContacts() {
  const cards = [
    { kind: 'Telegram-канал', val: SITE.tgChannelName, note: `${SITE.tgSubscribers} подписчиков · анонсы и афиши — тут раньше всех`, href: SITE.tgChannel },
    { kind: 'Менеджер', val: `@${SITE.tgManager}`, note: 'Вопросы по билетам, спискам и возвратам', href: `https://t.me/${SITE.tgManager}` },
    { kind: 'Сотрудничество', val: 'Партнёрам и площадкам', note: 'Реклама, интеграции, свои города', href: `https://t.me/${SITE.tgManager}` },
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
