// Страница ивента + чекаут. Состояние формы живёт в store (переживает
// перерисовки), экран успеха держится флагом showingDone.
import { SITE } from './data/config.js';
import { makeSheetDraggable } from './sheet-drag.js';
import { initChrome, closeMenu } from './chrome.js';
import { springTo } from './spring.js';
import { loadEvents, esc } from './events-load.js';
import { waveStates, activeWave, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel, normalizePhone, stripRuPhone, formatRuPhoneDigits } from './ticket-format.js';
import { handlePayment } from './payment.js';
import { addressIsPublic } from './secret-place.js';

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
  initChrome();
  const { events } = await loadEvents();
  const e = events.find((x) => x.id === slug());
  if (!e) {
    $('event-missing').hidden = false;
    $('sticky-cta').classList.add('hidden');
    return;
  }
  store.event = e;
  store.wave = activeWave(e.waves);
  restoreForm();
  renderEvent();
  renderWaves();
  bindSheet();
  bindForm();
  renderSavedTickets();
  // Счётчик волн живой, но пока человек заполняет форму или ждёт ответа,
  // цена и надпись на кнопке под ним меняться не должны — это его сделка.
  setInterval(() => {
    if (document.body.classList.contains('sheet-open') || store.sending) return;
    renderWaves();
  }, 60_000);
}

function renderEvent() {
  const e = store.event;
  // Данные пришли — только теперь кнопки могут что-то обещать
  for (const id of ['buy-open', 'sticky-buy']) $(id).disabled = false;
  document.title = `${e.title} — проходки · PROJECT X`;
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
    ['Адрес', e.address
      ? e.address
      : `в проходке сразу после покупки${addressIsPublic(e) ? '' : ' · всем остальным за сутки до ночи'}`],
    ['Возраст', `${ageLabel(e.ageRating)}${e.ageRating < 18 ? ' · без алкоголя' : ' · по паспорту'}`],
  ];
  rows.push(['Регламент', `двери ${SITE.doorsOpen} · старт ${SITE.showStart} · до утра`]);
  $('eh-meta').innerHTML = rows
    .map(([k, v]) => `<div class="eh-meta-item"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
  $('event-root').hidden = false;
}

function renderWaves() {
  const e = store.event;
  if (!e) return;
  if (e.status === 'past') {
    // Ночь прошла: ни счётчика «уже идут», ни лестницы цен — только выход на афишу
    $('ev-going').textContent = 'как это было';
    $('ev-wp-rows').innerHTML = '<p class="muted" style="margin:0">Эта ночь уже прошла. Ближайшие — на афише.</p>';
    store.wave = null;
    for (const btn of [$('buy-open'), $('sticky-buy')]) {
      btn.disabled = false;
      btn.textContent = 'Смотреть афишу';
      btn.onclick = () => { location.href = '/afisha'; };
    }
    return;
  }
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
          <div class="wave-bar"><i style="transform:scaleX(${(pct / 100).toFixed(3)})"></i></div>
        </div>`;
    })
    .join('');

  const a = activeWave(e.waves);
  if (!store.wave || (a && store.wave.waveNo !== a.waveNo && !store.sending)) store.wave = a;
  const soldOut = !a;
  for (const btn of [$('buy-open'), $('sticky-buy')]) {
    btn.disabled = soldOut;
    btn.textContent = soldOut ? 'Все проходки проданы' : `Взять проходку · ${a.priceRub} ₽`;
  }
  updateTotal();
}

// ---------- Шторка ----------
function bindSheet() {
  const sheet = $('sheet');
  // Шторку можно тянуть пальцем: жест ведёт лист 1:1, бросок уносит его по
  // инерции, анимацию можно перехватить на любом кадре (assets/sheet-drag.js).
  const drag = makeSheetDraggable({
    sheet,
    // Пока заказ уходит на сервер, лист не отпускаем: экран успеха со ссылками
    // на проходки рисуется именно здесь, и закрыть его в этот момент — значит
    // забрать у человека то, за что он только что заплатил.
    isOpen: () => document.body.classList.contains('sheet-open') && !store.sending,
    onClose: () => finishClose(),
  });

  let viaHistory = false;
  const finishClose = () => {
    document.body.classList.remove('sheet-open');
    if (history.state?.sheet && !viaHistory) history.back();
    unlockScroll();
    // Закрытый лист исчезает и для клавиатуры со скринридером: без этого он
    // остаётся в порядке обхода — человек «проваливается» в невидимую форму.
    sheet.inert = true;
    pageLayers().forEach((el) => { el.inert = false; });
    returnFocus();
    if (store.showingDone) resetAfterSuccess();
  };

  const open = () => {
    if (!store.wave) return;
    lockScroll();
    sheet.inert = false;
    // Пока лист открыт, страницы под ним для обхода не существует: Tab ходит
    // по кругу внутри диалога, как и положено модальному окну.
    pageLayers().forEach((el) => { el.inert = true; });
    lastFocused = document.activeElement;
    if (SITE.paymentDemo) $('demo-pay-note').classList.remove('hidden');
    renderAttendees();
    updateTotal();
    // Замер положения листа — до навешивания класса, иначе стиль уже «схлопнет»
    // трансформацию к нулю и пружине будет не с чего стартовать.
    drag.open(() => document.body.classList.add('sheet-open'));
    if (!history.state?.sheet) history.pushState({ sheet: 1 }, '');
    // Фокус — на сам диалог, а не на первое поле: автофокус в текстовое поле
    // на телефоне мгновенно поднимает клавиатуру и закрывает половину листа.
    sheet.focus({ preventScroll: true });
  };
  // закрытие любым способом идёт тем же путём, что и жест — лист уходит вниз
  const close = () => {
    if (store.sending) {
      // отвечаем на нажатие, но не закрываем: заказ в полёте
      alertNote('Заказ уже уходит — секунду.', 'info');
      return;
    }
    drag.close();
  };

  $('buy-open').onclick = open;
  $('sticky-buy').onclick = open;
  for (const id of ['header-buy', 'menu-buy']) {
    const el = $(id);
    if (!el) continue;
    el.href = '#buy';
    el.onclick = (ev) => { ev.preventDefault(); closeMenu(); open(); };
  }
  // Системная «назад» (Android, стрелка in-app браузера) закрывает лист, а не
  // уводит со страницы: открытие кладёт запись в историю, popstate её снимает.
  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('sheet-open')) { viaHistory = true; close(); viaHistory = false; }
  });
  $('sheet-close').onclick = close;
  $('sheet-backdrop').onclick = close;
  $('success-close').onclick = close;
  $('fallback-close').onclick = close;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.classList.contains('sheet-open')) close();
  });
}

// Слои страницы, которые модальный лист выключает на время своей работы.
const pageLayers = () =>
  ['.site-header', 'main', '.site-footer', '#sticky-cta']
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);

let lastFocused = null;
function returnFocus() {
  const el = lastFocused;
  lastFocused = null;
  if (el && document.contains(el)) el.focus({ preventScroll: true });
}

// Фон за открытой шторкой прокручиваться не должен — иначе человек теряет
// место, к которому вернётся. Положение страницы запоминаем и возвращаем.
let scrollLockY = 0;
function lockScroll() {
  scrollLockY = window.scrollY;
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add('scroll-locked');
}
function unlockScroll() {
  if (!document.body.classList.contains('scroll-locked')) return;
  document.body.classList.remove('scroll-locked');
  document.body.style.top = '';
  // Мгновенно: у html глобально scroll-behavior: smooth, и обычный scrollTo
  // заставлял страницу плавно «уползать» на место после каждого закрытия.
  window.scrollTo({ top: scrollLockY, left: 0, behavior: 'instant' });
}

function showPane(name) {
  $('pane-form').classList.toggle('hidden', name !== 'form');
  $('pane-success').classList.toggle('hidden', name !== 'success');
  $('pane-fallback').classList.toggle('hidden', name !== 'fallback');
}

// Панели разной высоты, и мгновенная подмена дёргает верхний край листа на
// пол-экрана — читается как «что-то сломалось». Лист доезжает до новой высоты
// сам: замерили до, замерили после, прошли расстояние пружиной.
let heightSpring = null;
function swapPane(name) {
  const sheet = $('sheet');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Настольная раскладка — боковая панель во всю высоту окна: задавать ей
  // height значит выбить её из распорки top/bottom. Там панель не «растёт».
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  if (reduced || !mobile || !sheet) return showPane(name);

  const from = sheet.getBoundingClientRect().height;
  showPane(name);
  sheet.style.height = 'auto';
  const to = sheet.getBoundingClientRect().height;
  sheet.style.height = '';
  if (Math.abs(to - from) < 4) return;

  heightSpring?.stop();
  const prevOverflow = sheet.style.overflowY;
  sheet.style.overflowY = 'hidden';
  sheet.style.height = `${from}px`;      // без окна в один кадр на «естественной» высоте
  sheet.classList.add('is-dragging');     // тяжёлое стекло на время роста уступает плотному фону
  heightSpring = springTo({
    from,
    to,
    damping: 1,
    response: 0.32,
    onUpdate: (v) => { sheet.style.height = `${v}px`; },
    onRest: () => {
      sheet.style.height = '';
      sheet.style.overflowY = prevOverflow;
      heightSpring = null;
      requestAnimationFrame(() => sheet.classList.remove('is-dragging'));
    },
  });
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
  // фиксированный «+7»: в поле живут только 10 цифр, форматируются на лету
  $('f-phone').oninput = (e) => {
    store.phone = stripRuPhone(e.target.value);
    e.target.value = formatRuPhoneDigits(store.phone);
    clearErr('phone');
    persistForm();
  };
  $('f-phone').onblur = () => {
    // Начатый, но недобранный номер — уже ошибка: показываем сразу, а не на кнопке
    if (store.phone && !normalizePhone('+7' + store.phone)) showFieldErr($('f-phone'), $('err-phone'));
  };
  $('f-tg').oninput = (e) => { store.tg = e.target.value; persistForm(); };
  $('f-consent').onchange = (e) => {
    store.consent = e.target.checked;
    clearErr('consent');
    e.target.closest('.check')?.classList.remove('is-error');
  };
  $('submit-order').onclick = submitOrder;
}

// Форма живёт в sessionStorage: in-app браузер Instagram перезагружает страницу,
// стоит отойти в чат за фамилией друга — набранное не должно пропасть.
function formKey() { return `px_form_${store.event?.id}`; }
function persistForm() {
  try {
    sessionStorage.setItem(formKey(), JSON.stringify({ qty: store.qty, attendees: store.attendees, phone: store.phone, tg: store.tg }));
  } catch { /* приватный режим */ }
}
function restoreForm() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(formKey()) || 'null');
    if (!saved) return;
    store.qty = Math.min(10, Math.max(1, Number(saved.qty) || 1));
    store.attendees = Array.isArray(saved.attendees) && saved.attendees.length
      ? saved.attendees.slice(0, store.qty).map((a) => ({ name: String(a.name || ''), minor: Boolean(a.minor) }))
      : [{ name: '', minor: false }];
    while (store.attendees.length < store.qty) store.attendees.push({ name: '', minor: false });
    store.phone = String(saved.phone || '');
    store.tg = String(saved.tg || '');
    $('f-phone').value = formatRuPhoneDigits(store.phone);
    $('f-tg').value = store.tg;
  } catch { /* нечитаемое — начинаем с чистой */ }
}
function forgetForm() { try { sessionStorage.removeItem(formKey()); } catch { /* ок */ } }

function setQty(q) {
  const qty = Math.min(10, Math.max(1, q));
  if (qty === store.qty) return;
  store.qty = qty;
  while (store.attendees.length < qty) store.attendees.push({ name: '', minor: false });
  store.attendees.length = qty;
  renderAttendees();
  updateTotal();
  persistForm();
}

// Одна строка гостя. Собирается разметкой, но заводится ровно один раз —
// дальше живёт своей жизнью и не пересоздаётся.
function attendeeRow(i, minorAllowed) {
  const row = document.createElement('div');
  row.className = 'field';
  row.dataset.i = String(i);
  row.innerHTML = `
      <label for="att-${i}">${i === 0 ? 'Твоё имя и фамилия' : `Гость ${i + 1} — имя и фамилия`}</label>
      <input type="text" id="att-${i}" placeholder="Как в паспорте" autocomplete="${i === 0 ? 'name' : 'off'}" />
      <div class="err" id="err-att-${i}" role="alert">Напиши имя — проходка именная</div>
      ${minorAllowed ? `
      <label class="minor-toggle">
        <input type="checkbox" id="minor-${i}" />
        <span>Нет 18 — надо будет надеть браслет на входе</span>
      </label>` : ''}`;
  const input = row.querySelector(`#att-${i}`);
  input.oninput = () => {
    if (store.attendees[i]) store.attendees[i].name = input.value;
    clearAttErr(i);
    persistForm();
  };
  // Проверяем на уходе из поля, а не залпом на кнопке: человек узнаёт о
  // проблеме там, где может её сразу поправить. Пустое поле, до которого ещё
  // не дошли, не ругаем — это не ошибка, это «ещё не заполнено».
  input.onblur = () => {
    const v = (store.attendees[i]?.name || '').trim();
    if (v && v.length < 2) showFieldErr(input, $(`err-att-${i}`));
  };
  const m = row.querySelector(`#minor-${i}`);
  if (m) m.onchange = () => { if (store.attendees[i]) store.attendees[i].minor = m.checked; };
  return row;
}

// Список гостей меняется по разнице, а не пересобирается целиком: полная
// перерисовка вырывает каретку из поля, в котором печатают, роняет фокус и
// сбрасывает состояние клавиатуры на телефоне.
function renderAttendees() {
  const e = store.event;
  // Тумблер «нет 18» осмыслен только на смешанных 16+ ивентах:
  // на 14+ браслет надевают всем, на 18+ несовершеннолетним нельзя.
  const minorAllowed = e.ageRating === 16;
  $('qty-val').textContent = String(store.qty);
  $('qty-minus').disabled = store.qty <= 1;
  $('qty-plus').disabled = store.qty >= 10;

  const box = $('attendees');
  while (box.children.length > store.attendees.length) box.lastElementChild.remove();
  while (box.children.length < store.attendees.length) box.appendChild(attendeeRow(box.children.length, minorAllowed));

  store.attendees.forEach((a, i) => {
    const input = $(`att-${i}`);
    if (input && input.value !== a.name) input.value = a.name;
    const m = $(`minor-${i}`);
    if (m && m.checked !== a.minor) m.checked = a.minor;
  });
}

function updateTotal() {
  const w = store.wave;
  $('ot-label').textContent = `${store.qty} ${plural(store.qty, 'проходка', 'проходки', 'проходок')}${w ? ` · ${w.name.toLowerCase()}` : ''}`;
  $('ot-sum').textContent = w ? `${w.priceRub * store.qty} ₽` : '— ₽';
  $('submit-order').textContent = !w
    ? 'Проходок нет'
    : SITE.paymentDemo
      ? `Получить проходки · ${w.priceRub * store.qty} ₽ (демо)`
      : `Оплатить ${w.priceRub * store.qty} ₽`;
  $('submit-order').disabled = !w || store.sending;
  const note = $('submit-note');
  if (note && w) note.textContent = `Нажимая «${SITE.paymentDemo ? 'Получить проходки' : 'Оплатить'}», ты подтверждаешь, что тебе есть 18, и принимаешь правила входа.`;
  $('sh-title').textContent = store.event ? `Проходки · ${store.event.title}` : 'Проходки';
}

function clearErr(k) {
  const el = $(`err-${k}`);
  if (el) el.classList.remove('is-on');
  $(`f-${k}`)?.closest('.field')?.classList.remove('is-error');
}
function clearAttErr(i) { const el = $(`err-att-${i}`); if (el) el.classList.remove('is-on'); $(`att-${i}`)?.closest('.field')?.classList.remove('is-error'); }
function showFieldErr(fieldEl, errEl, msg) {
  if (msg && errEl) errEl.textContent = msg;
  if (errEl) errEl.classList.add('is-on');
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
  if (!normalizePhone('+7' + store.phone)) {
    showFieldErr($('f-phone'), $('err-phone'));
    firstBad = firstBad || $('f-phone');
  }
  const consentBox = $('f-consent').closest('.check');
  if (!store.consent) {
    $('err-consent').classList.add('is-on');
    consentBox?.classList.add('is-error');
    firstBad = firstBad || $('f-consent');
  } else {
    $('err-consent').classList.remove('is-on');
    consentBox?.classList.remove('is-error');
  }
  if (firstBad) firstBad.focus();
  return !firstBad;
}

async function submitOrder() {
  if (store.sending || !store.wave) return;
  if (!validate()) return;
  store.sending = true;
  const btn = $('submit-order');
  // Не disabled: заблокированная кнопка перестаёт принимать ввод вовсе, а
  // человеку нужно видеть, что процесс идёт, и иметь право передумать.
  btn.classList.add('is-busy');
  btn.textContent = 'Оформляем…';
  const cancelBtn = $('submit-cancel');
  const cancelTimer = setTimeout(() => cancelBtn?.classList.remove('hidden'), 3000);

  const body = {
    event_id: store.event.id,
    wave_no: store.wave.waveNo,
    buyer: {
      name: store.attendees[0].name.trim(),
      phone: '+7' + store.phone,
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
    store.ctrl = ctrl;
    if (cancelBtn) cancelBtn.onclick = () => ctrl.abort();
    // 8 секунд: дольше на ночной мобильной сети всё равно читается как отказ,
    // а ручное оформление в директ уже готово и ждёт.
    const timer = setTimeout(() => ctrl.abort(), 8_000);
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
  store.ctrl = null;
  clearTimeout(cancelTimer);
  cancelBtn?.classList.add('hidden');
  btn.classList.remove('is-busy');
  updateTotal();

  // сервер недоступен/упал — фолбэк в директ Instagram, никакой «ошибки 500»
  if (!resp || !resp.json || (resp.status >= 500)) return showFallback();

  const j = resp.json;
  if (j.ok) {
    if (handlePayment(j.payment) === 'redirect') {
      // Браузер уже уходит на страницу оплаты, но уход не мгновенный: на
      // медленной сети окно в пару секунд хватает, чтобы нажать ещё раз и
      // оформить второй заказ. До самого перехода кнопка занята.
      store.sending = true;
      btn.classList.add('is-busy');
      btn.textContent = 'Переносим на оплату…';
      btn.disabled = true;
      return;
    }
    return showSuccess(j);
  }
  if (j.error === 'wave_sold_out') return handleSoldOut(j.next_wave);
  if (j.error === 'validation') {
    if (j.fields?.phone) showFieldErr($('f-phone'), $('err-phone'), j.fields.phone);
    if (j.fields?.consent) $('err-consent').classList.add('is-on');
    (j.attendees || []).forEach((er) => {
      if (er.i >= 0) showFieldErr($(`att-${er.i}`), $(`err-att-${er.i}`), er.code === 'minor_forbidden' ? 'На 18+ только совершеннолетние' : undefined);
    });
    if (j.attendees?.some((er) => er.code === 'minor_forbidden')) {
      alertNote('Вечеринка 18+ — проходки несовершеннолетним не продаются.', 'error');
    }
    return;
  }
  if (j.error === 'sales_closed' || j.error === 'not_found') {
    // Тупик без выхода — худшее, что можно показать человеку с деньгами в
    // руках. Продажи закрылись — значит, ведём к другим ночам, а не к стене.
    store.wave = null;
    updateTotal();
    return alertNote(
      'Продажи на эту ночь закрылись, пока ты заполнял форму. Ближайшие ночи — на афише.',
      'error',
      { href: '/#afisha', label: 'Посмотреть афишу' }
    );
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
    return alertNote('Только что забрали последние проходки. Следи за анонсами — бывают возвраты.', 'error', { href: '/#afisha', label: 'Другие ночи на афише' });
  }
  store.wave = { waveNo: nextWave.waveNo, name: nextWave.name, priceRub: nextWave.priceRub };
  updateTotal();
  alertNote(
    `Пока ты заполнял форму, волна закончилась — цена теперь ${nextWave.priceRub} ₽. ` +
    `Осталось ${nextWave.left} ${plural(nextWave.left, 'проходка', 'проходки', 'проходок')}. Сумма обновлена.`
  );
}

// Обратная связь бывает четырёх видов, и «янтарная плашка на всё» их
// смешивает: человек не отличает «цена изменилась» от «дальше хода нет».
// kind: 'info' — что-то произошло, 'warn' — сделка изменилась, требует
// внимания, 'error' — так не получится.
function alertNote(text, kind = 'warn', action = null) {
  const n = $('wave-note');
  n.classList.remove('note-info', 'note-warn', 'note-error');
  n.classList.add(`note-${kind}`);
  n.textContent = text;
  if (action) {
    const a = document.createElement('a');
    a.className = 'btn btn-ghost btn-block';
    a.style.marginTop = '12px';
    a.href = action.href;
    a.textContent = action.label;
    n.appendChild(a);
  }
  n.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  n.classList.remove('hidden');
  n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showSuccess(j) {
  store.showingDone = true;
  forgetForm();
  if (SITE.paymentDemo) {
    document.querySelector('#pane-success .success-note').textContent =
      'Демо-покупка прошла (деньги не списывались). Каждому гостю — свой именной QR: открой проходку и отправь её владельцу.';
  }
  // Дубликат ссылок на случай, если лист закроют: единственный экземпляр
  // «моих проходок» на сайте не должен исчезать вместе со шторкой.
  try {
    localStorage.setItem(
      `px_tickets_${store.event.id}`,
      JSON.stringify({ at: Date.now(), tickets: j.tickets || [] })
    );
  } catch { /* приватный режим — не беда, экран успеха всё равно показан */ }
  renderSavedTickets();

  $('success-list').innerHTML = (j.tickets || [])
    .map(
      (t) => `
      <a href="${esc(t.url)}" target="_blank" rel="noopener">
        <span>${esc(t.holder_name)}</span>
        <span class="st-open">открыть проходку</span>
      </a>`
    )
    .join('');
  swapPane('success');
}

// Проходки, купленные на этой странице, остаются доступными и после закрытия
// шторки: единственная ссылка на именной QR не должна жить в одном модальном окне.
function renderSavedTickets() {
  const host = $('saved-tickets');
  if (!host || !store.event) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(`px_tickets_${store.event.id}`) || 'null');
  } catch { /* нечитаемое хранилище — просто не показываем блок */ }
  const list = saved?.tickets || [];
  if (!list.length) {
    host.hidden = true;
    return;
  }
  host.innerHTML =
    `<div class="st-head">Твои проходки на эту ночь</div>` +
    list
      .map(
        (t) => `
      <a href="${esc(t.url)}">
        <span>${esc(t.holder_name)}</span>
        <span class="st-open">открыть</span>
      </a>`
      )
      .join('');
  host.hidden = false;
}

function showFallback() {
  const e = store.event;
  const names = store.attendees.map((a) => a.name.trim()).filter(Boolean).join(', ');
  const text =
    `Привет! Хочу ${store.qty} ${plural(store.qty, 'проходку', 'проходки', 'проходок')} на ${e.title} (${fmtWhen(e.startsAt)}). ` +
    `Имена: ${names}. Телефон: +7${store.phone}. Онлайн-оплата не сработала — оформите вручную?`;
  // в директе нельзя предзаполнить сообщение ссылкой — даём готовый текст рядом
  $('fallback-text').textContent = text;
  const copy = $('fallback-copy');
  copy.textContent = 'Скопировать текст заявки';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Скопировано — вставь в директ';
    } catch {
      copy.textContent = 'Выдели текст выше и скопируй';
    }
  };
  $('fallback-tg').href = SITE.instagramDm;
  swapPane('fallback');
}
