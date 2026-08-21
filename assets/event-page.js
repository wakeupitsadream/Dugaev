// Страница ивента + чекаут. Состояние формы живёт в store (переживает
// перерисовки), экран успеха держится флагом showingDone.
import { SITE } from './data/config.js';
import { loadEvents, esc } from './events-load.js';
import { waveStates, activeWave, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel, normalizePhone } from './ticket-format.js';
import { handlePayment } from './payment.js';

const $ = (id) => document.getElementById(id);

const store = {
  event: null,
  wave: null,          // выбранная волна (активная; после 409 — следующая)
  qty: 1,
  attendees: [{ name: '', minor: false }],
  phone: '',
  tg: '',
  consent: false,
  showingDone: false,
  sending: false,
};

init();

function slug() {
  const m = location.pathname.match(/^\/e\/([\w-]+)/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get('id');
}

async function init() {
  const { events } = await loadEvents();
  const e = events.find((x) => x.id === slug());
  if (!e) {
    $('event-missing').hidden = false;
    $('sticky-cta').classList.add('hidden');
    return;
  }
  store.event = e;
  store.wave = activeWave(e.waves);
  renderEvent();
  renderWaves();
  bindSheet();
  bindForm();
  setInterval(renderWaves, 60_000); // живость счётчика; шторку не трогает
}

function renderEvent() {
  const e = store.event;
  document.title = `${e.title} — билеты · TRAP HOUSE`;
  const db = dateBox(e.startsAt);
  $('eh-word').textContent = e.title;
  $('eh-day').textContent = db.day;
  $('eh-mon').textContent = db.mon;
  $('eh-age').textContent = ageLabel(e.ageRating);
  if (e.ageRating < 18) $('eh-age').classList.add('age-16');
  $('eh-title').textContent = e.title;
  $('eh-descr').textContent = e.descr || '';
  if (e.posterUrl) {
    const img = document.createElement('img');
    img.src = e.posterUrl;
    img.alt = e.title;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    $('eh-poster').prepend(img);
    $('eh-poster').classList.add('has-img');
  }
  $('eh-lineup').innerHTML = (e.lineup || [])
    .map((n) => `<span class="badge">${esc(n)}</span>`)
    .join('');
  const rows = [
    ['Когда', fmtWhen(e.startsAt)],
    ['Где', `${e.venue} · ${SITE.cities[e.city] || e.city}`],
    ['Адрес', e.address || 'придёт в билете'],
    ['Возраст', `${ageLabel(e.ageRating)}${e.ageRating < 18 ? ' · без алкоголя' : ' · по паспорту'}`],
  ];
  if (e.ageRating < 18) {
    rows.push(['Регламент', `двери ${SITE.doorsOpen} · старт ${SITE.showStart} · финиш ${SITE.showEnd}, домой засветло`]);
  }
  $('eh-meta').innerHTML = rows
    .map(([k, v]) => `<div class="eh-meta-item"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
  $('event-root').hidden = false;
}

function renderWaves() {
  const e = store.event;
  if (!e) return;
  const ws = waveStates(e.waves);
  const sold = totalSold(e.waves);
  const going = goingCount(e.id, Date.parse(e.startsAt), sold, Date.now());
  $('ev-going').innerHTML = `уже ${plural(going, 'идёт', 'идут', 'идут')} <b>${going}</b> ${plural(going, 'человек', 'человека', 'человек')}`;
  $('ev-wp-rows').innerHTML = ws
    .map((w) => {
      const pct = Math.round((w.sold / w.quota) * 100);
      let note;
      if (w.state === 'past') note = 'распродана';
      else if (w.state === 'active') note = `осталось <b>${w.left}</b> по этой цене`;
      else note = 'следующая цена';
      return `
        <div class="wave-row is-${w.state}">
          <div class="wave-name">${esc(w.name)}<small class="wave-left">${note}</small></div>
          <div></div>
          <div class="wave-price">${w.priceRub} ₽</div>
          <div class="wave-bar"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join('');

  const a = activeWave(e.waves);
  if (!store.wave || (a && store.wave.waveNo !== a.waveNo && !store.sending)) store.wave = a;
  const soldOut = !a;
  for (const btn of [$('buy-open'), $('sticky-buy')]) {
    btn.disabled = soldOut;
    btn.textContent = soldOut ? 'Все билеты проданы' : `Купить билет · ${a.priceRub} ₽`;
  }
  updateTotal();
}

// ---------- Шторка ----------
function bindSheet() {
  const open = () => {
    if (!store.wave) return;
    document.body.classList.add('sheet-open');
    if (SITE.paymentDemo) $('demo-pay-note').classList.remove('hidden');
    renderAttendees();
    updateTotal();
  };
  const close = () => {
    document.body.classList.remove('sheet-open');
    if (store.showingDone) resetAfterSuccess();
  };
  $('buy-open').onclick = open;
  $('sticky-buy').onclick = open;
  $('sheet-close').onclick = close;
  $('sheet-backdrop').onclick = close;
  $('success-close').onclick = close;
  $('fallback-close').onclick = close;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

function showPane(name) {
  $('pane-form').classList.toggle('hidden', name !== 'form');
  $('pane-success').classList.toggle('hidden', name !== 'success');
  $('pane-fallback').classList.toggle('hidden', name !== 'fallback');
}

function resetAfterSuccess() {
  store.showingDone = false;
  store.qty = 1;
  store.attendees = [{ name: '', minor: false }];
  showPane('form');
  renderAttendees();
  updateTotal();
}

// ---------- Форма ----------
function bindForm() {
  $('qty-minus').onclick = () => setQty(store.qty - 1);
  $('qty-plus').onclick = () => setQty(store.qty + 1);
  $('f-phone').oninput = (e) => { store.phone = e.target.value; clearErr('phone'); };
  $('f-tg').oninput = (e) => { store.tg = e.target.value; };
  $('f-consent').onchange = (e) => { store.consent = e.target.checked; clearErr('consent'); };
  $('submit-order').onclick = submitOrder;
}

function setQty(q) {
  const qty = Math.min(10, Math.max(1, q));
  if (qty === store.qty) return;
  store.qty = qty;
  while (store.attendees.length < qty) store.attendees.push({ name: '', minor: false });
  store.attendees.length = qty;
  renderAttendees();
  updateTotal();
}

// Перерисовка списка гостей только по смене qty; ввод хранится в store.
function renderAttendees() {
  const e = store.event;
  // Тумблер «нет 18» осмыслен только на смешанных 16+ ивентах:
  // на 14+ браслет надевают всем, на 18+ несовершеннолетним нельзя.
  const minorAllowed = e.ageRating === 16;
  $('qty-val').textContent = String(store.qty);
  $('qty-minus').disabled = store.qty <= 1;
  $('qty-plus').disabled = store.qty >= 10;
  $('attendees').innerHTML = store.attendees
    .map(
      (a, i) => `
      <div class="field" data-i="${i}">
        <label for="att-${i}">${i === 0 ? 'Твоё имя и фамилия' : `Гость ${i + 1} — имя и фамилия`}</label>
        <input type="text" id="att-${i}" value="${esc(a.name)}" placeholder="Как в паспорте" autocomplete="${i === 0 ? 'name' : 'off'}" />
        <div class="err" id="err-att-${i}">Напиши имя — билет именной</div>
        ${minorAllowed ? `
        <label class="minor-toggle">
          <input type="checkbox" id="minor-${i}" ${a.minor ? 'checked' : ''} />
          <span>Нет 18 — надо будет надеть браслет на входе</span>
        </label>` : ''}
      </div>`
    )
    .join('');
  store.attendees.forEach((a, i) => {
    $(`att-${i}`).oninput = (ev) => { a.name = ev.target.value; clearAttErr(i); };
    const m = $(`minor-${i}`);
    if (m) m.onchange = (ev) => { a.minor = ev.target.checked; };
  });
}

function updateTotal() {
  const w = store.wave;
  $('ot-label').textContent = `${store.qty} ${plural(store.qty, 'билет', 'билета', 'билетов')}${w ? ` · ${w.name.toLowerCase()}` : ''}`;
  $('ot-sum').textContent = w ? `${w.priceRub * store.qty} ₽` : '— ₽';
  $('submit-order').textContent = !w
    ? 'Билетов нет'
    : SITE.paymentDemo
      ? `Получить билеты · ${w.priceRub * store.qty} ₽ (демо)`
      : `Оплатить ${w.priceRub * store.qty} ₽`;
  $('submit-order').disabled = !w || store.sending;
  $('sh-title').textContent = store.event ? `Билеты · ${store.event.title}` : 'Билеты';
}

function clearErr(k) {
  const el = $(`err-${k}`);
  if (el) el.style.display = 'none';
  $(`f-${k}`)?.closest('.field')?.classList.remove('is-error');
}
function clearAttErr(i) { const el = $(`err-att-${i}`); if (el) el.style.display = 'none'; $(`att-${i}`)?.closest('.field')?.classList.remove('is-error'); }
function showFieldErr(fieldEl, errEl, msg) {
  if (msg && errEl) errEl.textContent = msg;
  if (errEl) errEl.style.display = 'block';
  fieldEl?.closest('.field')?.classList.add('is-error');
}

function validate() {
  let firstBad = null;
  store.attendees.forEach((a, i) => {
    if (a.name.trim().length < 2) {
      showFieldErr($(`att-${i}`), $(`err-att-${i}`));
      firstBad = firstBad || $(`att-${i}`);
    }
  });
  if (!normalizePhone(store.phone)) {
    showFieldErr($('f-phone'), $('err-phone'));
    firstBad = firstBad || $('f-phone');
  }
  if (!store.consent) {
    $('err-consent').style.display = 'block';
    firstBad = firstBad || $('f-consent');
  } else {
    $('err-consent').style.display = 'none';
  }
  if (firstBad) firstBad.focus();
  return !firstBad;
}

async function submitOrder() {
  if (store.sending || !store.wave) return;
  if (!validate()) return;
  store.sending = true;
  $('submit-order').disabled = true;
  $('submit-order').textContent = 'Оформляем…';

  const body = {
    event_id: store.event.id,
    wave_no: store.wave.waveNo,
    buyer: {
      name: store.attendees[0].name.trim(),
      phone: store.phone,
      tg: store.tg.trim(),
    },
    attendees: store.attendees.map((a) => ({ name: a.name.trim(), minor: a.minor })),
    consent: store.consent,
    website: $('f-website').value, // honeypot
    utm: { src: new URLSearchParams(location.search).get('src') || 'site' },
  };

  let resp = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const r = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    resp = { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    resp = null;
  }
  store.sending = false;
  updateTotal();

  // сервер недоступен/упал — фолбэк в Telegram, никакой «ошибки 500»
  if (!resp || !resp.json || (resp.status >= 500)) return showFallback();

  const j = resp.json;
  if (j.ok) {
    if (handlePayment(j.payment) === 'redirect') return;
    return showSuccess(j);
  }
  if (j.error === 'wave_sold_out') return handleSoldOut(j.next_wave);
  if (j.error === 'validation') {
    if (j.fields?.phone) showFieldErr($('f-phone'), $('err-phone'), j.fields.phone);
    if (j.fields?.consent) $('err-consent').style.display = 'block';
    (j.attendees || []).forEach((er) => {
      if (er.i >= 0) showFieldErr($(`att-${er.i}`), $(`err-att-${er.i}`), er.code === 'minor_forbidden' ? 'На 18+ только совершеннолетние' : undefined);
    });
    if (j.attendees?.some((er) => er.code === 'minor_forbidden')) {
      alertNote('На тусовку 18+ билеты для несовершеннолетних не продаются.');
    }
    return;
  }
  if (j.error === 'sales_closed' || j.error === 'not_found') {
    return alertNote('Продажи на эту тусовку уже закрыты.');
  }
  showFallback();
}

function handleSoldOut(nextWave) {
  const e = store.event;
  // подтягиваем свежие остатки, чтобы лестница не врала
  loadEvents().then(({ events }) => {
    const fresh = events.find((x) => x.id === e.id);
    if (fresh) { store.event.waves = fresh.waves; renderWaves(); }
  });
  if (!nextWave) {
    store.wave = null;
    updateTotal();
    return alertNote('Только что забрали последние билеты. Следи за анонсами — бывают возвраты.');
  }
  store.wave = { waveNo: nextWave.waveNo, name: nextWave.name, priceRub: nextWave.priceRub };
  updateTotal();
  alertNote(
    `Пока ты заполнял форму, волна закончилась — цена теперь ${nextWave.priceRub} ₽. ` +
    `Осталось ${nextWave.left} ${plural(nextWave.left, 'билет', 'билета', 'билетов')}. Сумма обновлена.`
  );
}

function alertNote(text) {
  const n = $('wave-note');
  n.textContent = text;
  n.classList.remove('hidden');
  n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showSuccess(j) {
  store.showingDone = true;
  if (SITE.paymentDemo) {
    document.querySelector('#pane-success .success-note').textContent =
      'Демо-покупка прошла (деньги не списывались). Каждому гостю — свой именной QR: открой билет и отправь его владельцу.';
  }
  $('success-list').innerHTML = (j.tickets || [])
    .map(
      (t) => `
      <a href="${esc(t.url)}" target="_blank" rel="noopener">
        <span>${esc(t.holder_name)}</span>
        <span class="st-open">открыть билет</span>
      </a>`
    )
    .join('');
  showPane('success');
}

function showFallback() {
  const e = store.event;
  const names = store.attendees.map((a) => a.name.trim()).filter(Boolean).join(', ');
  const text =
    `Привет! Хочу ${store.qty} ${plural(store.qty, 'билет', 'билета', 'билетов')} на ${e.title} (${fmtWhen(e.startsAt)}). ` +
    `Имена: ${names}. Телефон: ${store.phone}. Онлайн-оплата не сработала — оформите вручную?`;
  $('fallback-tg').href = `https://t.me/${SITE.tgManager}?text=${encodeURIComponent(text)}`;
  showPane('fallback');
}
