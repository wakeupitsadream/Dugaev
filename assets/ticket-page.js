// Гостевой билет: QR строится локально из токена и работает даже офлайн;
// детали (имя, ивент) приходят из API и кэшируются в localStorage —
// повторное открытие без сети показывает полный билет.
import { parseToken, formatTicketCode, fmtTicketWhen, fmtTime, ageLabel } from './ticket-format.js';
import { qrSvg } from './qr.js';
import { esc } from './events-load.js';
import { SITE } from './data/config.js';

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
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`/api/ticket?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (r.status === 404) {
      $('ticket-card').hidden = true;
      $('t-missing').hidden = false;
      return;
    }
    if (j && j.ok && j.ticket) {
      data = j.ticket;
      try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* private mode */ }
    }
  } catch { /* офлайн — идём в кэш */ }

  if (!data) {
    try { data = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { data = null; }
  }
  render(parsed, data);
  bindActions(parsed, data);
}

function render(parsed, t) {
  if (!t) {
    // подпись валидна, деталей нет (первое открытие офлайн) — QR всё равно рабочий
    $('t-name').textContent = 'Именной билет';
    $('t-meta').textContent = 'Детали подтянутся, когда появится интернет';
    return;
  }
  $('t-event').textContent = t.event.title;
  $('t-name').textContent = t.holderName;
  $('t-meta').innerHTML =
    `${esc(fmtTicketWhen(t.event.startsAt))} · ${esc(SITE.cities[t.event.city] || t.event.city)}<br />` +
    `${esc(t.event.venue)}${t.event.address ? ' · ' + esc(t.event.address) : ''}`;

  const badges = [
    `<span class="badge badge-age ${t.event.ageRating < 18 ? 'age-16' : ''}">${ageLabel(t.event.ageRating)}</span>`,
    `<span class="badge">${esc(t.waveName || 'билет')}</span>`,
  ];
  if (t.event.ageRating < 18) {
    badges.push('<span class="badge">0% алкоголя</span>');
  }
  if (t.ageCat === 'minor' && t.event.ageRating === 16) {
    badges.push('<span class="badge" style="border-color: var(--warn); color: var(--warn);">браслет на входе</span>');
  }
  $('t-badges').innerHTML = badges.join('');

  const strip = $('t-strip');
  if (t.status === 'revoked' || t.status === 'refunded') {
    strip.textContent = 'Билет отозван — напиши нам, если это ошибка';
    strip.classList.remove('hidden');
    strip.classList.add('revoked');
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
        title: 'Твой билет — TRAP HOUSE',
        text: t ? `Билет на ${t.event.title} для ${t.holderName}` : 'Твой билет TRAP HOUSE',
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
    ctx.fillText(`TRAP HOUSE · ${code}`, canvas.width / 2, canvas.height - 88);
    ctx.font = '32px sans-serif';
    if (t) ctx.fillText(`${t.holderName} · ${fmtTicketWhen(t.event.startsAt)}`, canvas.width / 2, canvas.height - 40);
    URL.revokeObjectURL(url);
    const a = document.createElement('a');
    a.download = `traphouse-${parsed.id}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = url;
}
