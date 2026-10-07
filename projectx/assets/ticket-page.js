// Гостевой билет: QR строится локально из токена и работает даже офлайн;
// детали (имя, ивент) приходят из API и кэшируются в localStorage —
// повторное открытие без сети показывает полный билет.
import { parseToken, formatTicketCode, fmtTicketWhen, fmtTime, ageLabel } from './ticket-format.js';
import { qrSvg } from './qr.js';
import { esc } from './events-load.js';
import { SITE } from './data/config.js';
import { payBlockHtml, bindPayBlock } from './booking-ui.js';

const $ = (id) => document.getElementById(id);

init();

function tokenFromUrl() {
  const m = location.pathname.match(/^\/t\/([^/?#]+)/);
  const raw = m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get('token');
  return raw ? raw.trim() : null;
}

async function init() {
  const raw = tokenFromUrl();
  const parsed = parseToken(raw || '');
  if (!parsed) {
    $('t-missing').hidden = false;
    return;
  }
  const token = `${parsed.id}.${parsed.sig}`;

  // QR — сразу, без сети: кодирует URL страницы сканирования
  const scanUrl = `${location.origin}/s/${token}`;
  $('t-qr').innerHTML = qrSvg(scanUrl);
  $('t-code').textContent = formatTicketCode(parsed.id);
  $('ticket-card').hidden = false;

  const cacheKey = `th_ticket_${parsed.id}`;
  let data = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000); // первое открытие на медленной сети — ждём дольше
    const r = await fetch(`/api/ticket?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (r.status === 404) {
      $('ticket-card').hidden = true;
      $('t-missing').hidden = false;
      return;
    }
    if (j && j.ok && j.ticket) {
      data = { ...j.ticket, bot: j.bot || null };
      try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* private mode */ }
    }
  } catch { /* офлайн — идём в кэш */ }

  if (!data) {
    try { data = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { data = null; }
  }
  pollAgain = () => pollStatus(parsed, token, cacheKey);
  render(parsed, data);
  bindActions(parsed, data);
  // Бронь ждёт подтверждения: опрашиваем статус, чтобы проходка «ожила»
  // сама, без перезагрузки — гость держит экран открытым у входа. Сгоревшая
  // бронь с «Я перевёл» тоже может ожить: владелец подтвердит, если места есть.
  if (waiting(data)) pollStatus(parsed, token, cacheKey);
}

let pollAgain = () => {};
const waiting = (t) => t?.status === 'reserved' || (t?.status === 'expired' && Boolean(t.order?.claimedAt));
let polling = false;

function pollStatus(parsed, token, cacheKey) {
  if (polling) return;
  polling = true;
  let stopped = false;
  const tick = async () => {
    if (stopped || document.hidden) return schedule();
    try {
      const r = await fetch(`/api/ticket?token=${encodeURIComponent(token)}`);
      const j = await r.json().catch(() => null);
      if (j?.ok && j.ticket && !waiting(j.ticket)) {
        stopped = true;
        polling = false;
        const data = { ...j.ticket, bot: j.bot || null };
        try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* ignore */ }
        render(parsed, data);
        bindActions(parsed, data);
        return;
      }
    } catch { /* сеть мигнула — попробуем ещё */ }
    schedule();
  };
  const schedule = () => { if (!stopped) setTimeout(tick, 15_000); };
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped) tick(); });
}

function render(parsed, t) {
  if (!t) {
    // подпись валидна, деталей нет (первое открытие офлайн) — QR всё равно рабочий
    $('t-name').textContent = 'Именная проходка';
    $('t-meta').innerHTML = 'Детали подтянутся, когда появится интернет. <button class="act-link" id="t-retry" type="button">Обновить</button>';
    const retry = $('t-retry');
    if (retry) retry.onclick = () => location.reload();
    return;
  }
  $('t-event').textContent = t.event.title;
  $('t-name').textContent = t.holderName;
  $('t-meta').innerHTML =
    `${esc(fmtTicketWhen(t.event.startsAt))} · ${esc(SITE.cities[t.event.city] || t.event.city)}<br />` +
    // площадка = адрес: если адрес уже содержит venue, не дублируем
    `${t.event.address && t.event.address.includes(t.event.venue) ? esc(t.event.address) : `${esc(t.event.venue)}${t.event.address ? ' · ' + esc(t.event.address) : ''}`}`;

  const card = $('ticket-card');
  const reserved = t.status === 'reserved';
  const dead = t.status === 'expired' || t.status === 'cancelled';
  card.classList.toggle('is-reserved', reserved);
  card.classList.toggle('is-dead', dead);

  // Бронь ещё не оплачена: реквизиты и «Я перевёл» прямо в проходке.
  // QR уже есть — на входе по нему примут оплату наличными.
  const pay = $('t-pay');
  if (pay) {
    if (reserved && t.order) {
      pay.innerHTML = payBlockHtml(t.order, t.bot || null);
      pay.hidden = false;
      bindPayBlock(t.order, { onClaimed: (at) => { t.order.claimedAt = at; } });
    } else if (dead) {
      const again = `<a class="btn btn-ghost btn-block" href="/e/${esc(t.event.id)}">Забронировать заново</a>`;
      const help = SITE.telegramUrl
        ? ` <a href="${esc(SITE.telegramUrl)}" target="_blank" rel="noopener">Напиши боту PROJECT X</a> и приложи скрин перевода — разберёмся.`
        : '';
      if (t.status === 'cancelled') {
        pay.innerHTML =
          `<div class="pay-box"><div class="pay-kicker">Бронь отменена</div>` +
          `<p class="pay-note">Перевод по этой брони не нашли, места вернулись в продажу.${help || ' Если ты переводил деньги — напиши нам со скрином перевода.'}</p>${again}</div>`;
      } else if (t.order?.claimedAt) {
        pay.innerHTML =
          `<div class="pay-box is-claimed"><div class="pay-kicker">Ждём подтверждение</div>` +
          `<p class="pay-note">Срок брони вышел, но ты сообщил о переводе — организатор проверит. Если места остались, проходка оживёт прямо здесь; если нет — с тобой свяжутся.</p>${again}</div>`;
      } else {
        // перевод мог прийти позже срока: «Я перевёл» работает и здесь
        pay.innerHTML =
          `<div class="pay-box" id="pay-box"><div class="pay-kicker">Бронь сгорела</div>` +
          `<p class="pay-note">Срок брони вышел, места вернулись в продажу. Уже перевёл деньги? Нажми «Я перевёл» — организатор проверит: если места остались, проходка оживёт здесь же.</p>` +
          `<button class="btn btn-acid btn-block" id="pay-claim" type="button">Я перевёл</button>` +
          `<div class="pay-status hidden" id="pay-status"></div>${again}</div>`;
        bindPayBlock(t.order, { onClaimed: (at) => { t.order.claimedAt = at; pollAgain(); } });
      }
      pay.hidden = false;
    } else {
      pay.hidden = true;
      pay.innerHTML = '';
    }
  }

  // SECRET PLACE: у владельца проходки адрес есть сразу — это и есть привилегия
  // купившего. Показываем его отдельным блоком с картой, а не строкой в мета.
  const place = $('t-place');
  if (place) {
    if (t.event.address) {
      const q = encodeURIComponent(`${t.event.address}, ${SITE.cities[t.event.city] || t.event.city}`);
      place.innerHTML =
        `<div class="tp-kicker">Адрес — только у тебя</div>` +
        `<div class="tp-addr">${esc(t.event.address)}</div>` +
        `<div class="tp-links"><a href="https://yandex.ru/maps/?text=${q}" target="_blank" rel="noopener">Яндекс Карты</a>` +
        `<a href="https://2gis.ru/search/${q}" target="_blank" rel="noopener">2ГИС</a></div>`;
      place.hidden = false;
    } else if (reserved && t.event.secret) {
      place.innerHTML =
        `<div class="tp-kicker">SECRET PLACE</div>` +
        `<div class="tp-addr">Адрес откроется после оплаты</div>` +
        `<div class="tp-note">Как только подтвердим перевод, адрес появится прямо здесь — раньше, чем его узнает город.</div>`;
      place.hidden = false;
    } else if (t.event.secret) {
      place.innerHTML =
        `<div class="tp-kicker">SECRET PLACE</div>` +
        `<div class="tp-addr">Адрес появится здесь</div>` +
        `<div class="tp-note">Открой проходку в день ночи — адрес придёт в неё. Городу его объявим только за сутки до старта.</div>`;
      place.hidden = false;
    } else {
      place.hidden = true;
    }
  }

  const badges = [
    `<span class="badge badge-age ${t.event.ageRating < 18 ? 'age-16' : ''}">${ageLabel(t.event.ageRating)}</span>`,
    `<span class="badge">${esc(t.waveName || 'проходка')}</span>`,
  ];
  if (t.event.ageRating < 18) {
    badges.push('<span class="badge">0% алкоголя</span>');
  }
  if (t.ageCat === 'minor' && t.event.ageRating === 16) {
    badges.push('<span class="badge" style="border-color: var(--warn); color: var(--warn);">браслет на входе</span>');
  }
  $('t-badges').innerHTML = badges.join('');

  const strip = $('t-strip');
  strip.classList.remove('hidden', 'revoked', 'used', 'reserved', 'expired');
  strip.classList.add('hidden');
  if (t.status === 'revoked' || t.status === 'refunded') {
    strip.textContent = t.status === 'refunded' ? 'Проходка возвращена — вход по ней не сработает' : 'Проходка отозвана — напиши нам, если это ошибка';
    strip.classList.remove('hidden');
    strip.classList.add('revoked');
  } else if (reserved) {
    strip.textContent = t.order?.claimedAt ? 'Ждём подтверждение оплаты' : 'Ожидает оплаты — QR пока не активен';
    strip.classList.remove('hidden');
    strip.classList.add('reserved');
  } else if (dead) {
    strip.textContent = t.status === 'cancelled' ? 'Бронь отменена' : 'Бронь сгорела — места вернулись в продажу';
    strip.classList.remove('hidden');
    strip.classList.add('expired');
  } else if (t.checkedInAt) {
    strip.textContent = `Использован в ${fmtTime(t.checkedInAt)} — повторный вход по нему не сработает`;
    strip.classList.remove('hidden');
    strip.classList.add('used');
  }
}

function bindActions(parsed, t) {
  $('t-save').onclick = () => savePng(parsed, t);
  if (navigator.share) {
    const share = $('t-share');
    share.hidden = false;
    share.onclick = () => {
      navigator.share({
        title: 'Твоя проходка — PROJECT X',
        text: t ? `Проходка на ${t.event.title} для ${t.holderName}` : 'Твоя проходка PROJECT X',
        url: location.href,
      }).catch(() => {});
    };
  }
}

// SVG → canvas → PNG: скриншот-независимое сохранение билета в галерею
function savePng(parsed, t) {
  const svgEl = $('t-qr').querySelector('svg');
  if (!svgEl) return;
  const scale = 12;
  const vb = svgEl.viewBox.baseVal;
  const pad = 80;
  const canvas = document.createElement('canvas');
  canvas.width = vb.width * scale + pad * 2;
  canvas.height = vb.height * scale + pad * 2 + 140;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, pad, pad, vb.width * scale, vb.height * scale);
    ctx.fillStyle = '#0a0a0c';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    const code = formatTicketCode(parsed.id);
    ctx.fillText(`PROJECT X · ${code}`, canvas.width / 2, canvas.height - 88);
    ctx.font = '32px sans-serif';
    if (t) ctx.fillText(`${t.holderName} · ${fmtTicketWhen(t.event.startsAt)}`, canvas.width / 2, canvas.height - 40);
    URL.revokeObjectURL(url);
    const name = `projectx-${parsed.id}.png`;
    // системный «Поделиться» умеет «Сохранить изображение» и работает во
    // встроенных браузерах Instagram и Telegram, где download молча игнорируется
    canvas.toBlob(async (blob) => {
      const file = blob ? new File([blob], name, { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Проходка PROJECT X' }); return; } catch { /* отмена — покажем картинку */ }
      }
      const a = document.createElement('a');
      a.download = name;
      a.href = canvas.toDataURL('image/png');
      a.click();
    }, 'image/png');
  };
  img.src = url;
}
