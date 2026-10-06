// Продвижение: ссылка на ночь, метки источников с QR-постерами, анонс
// подписчикам бота и таблица «откуда гости».
import {
  $, state, api, on, visible, nightById, setNight, isPublic, phaseOf, esc, icon, toast, confirmDlg, busy,
  copyText, siteUrl, rub, plural, fmtWhen, sleep, download,
} from './core.js';
import { qrSvg } from '../qr.js';
import { SITE } from '../data/config.js';

const SRC_LABEL = {
  site: 'Сайт без метки',
  door: 'Касса на входе',
  tgbot: 'Бот Telegram',
  tgbc: 'Анонс в боте',
};

export function show() {
  bindOnce();
  render();
  refreshBroadcast();
}
on('night', () => {
  if (!visible('promo')) return;
  render();
  refreshBroadcast();
});
on('events', () => visible('promo') && render());
on('stats', () => visible('promo') && renderSources());

function render() {
  const e = nightById(state.night);
  const pub = e && isPublic(e);
  $('pr-link').textContent = e ? siteUrl(e) : '—';
  $('pr-copy').disabled = !pub;
  $('src-copy').disabled = !e;
  $('src-qr').disabled = !e;
  $('src-note').textContent = e && !pub ? 'Ночь ещё не опубликована — ссылки заработают после публикации.' : $('src-note').textContent;
  $('bc-link').textContent = `t.me/${SITE.telegramBot}?start=notify`;
  renderSubs(state.subs);
  renderSources();
}

function renderSubs(n) {
  $('bc-subs').textContent = String(n);
  $('bc-subs-l').textContent = plural(n, 'подписчик', 'подписчика', 'подписчиков');
}

// ---------- метки и QR ----------
function srcLink() {
  const tag = $('src-tag').value.trim().toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!tag || !state.night) return null;
  return { tag, url: `${location.origin}/e/${encodeURIComponent(state.night)}?src=${encodeURIComponent(tag)}` };
}

// PNG-постер A4: крупный QR на страницу ночи с меткой и подпись бренда.
// Сканы с него считаются в «Откуда гости».
function posterPng({ tag, url }) {
  return new Promise((resolve, reject) => {
    const holder = document.createElement('div');
    holder.innerHTML = qrSvg(url, { ecc: 'M', margin: 2 });
    const svgEl = holder.querySelector('svg');
    const vb = svgEl.viewBox.baseVal;
    const W = 1240;
    const H = 1754;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const img = new Image();
    const blobUrl = URL.createObjectURL(new Blob([svgEl.outerHTML], { type: 'image/svg+xml' }));
    img.onload = () => {
      const ev = nightById(state.night);
      ctx.fillStyle = '#0a0a0c';
      ctx.textAlign = 'center';
      ctx.font = 'bold 110px Oswald, "Arial Narrow", sans-serif';
      ctx.fillText('PROJECT X', W / 2, 190);
      ctx.fillStyle = '#e51a20';
      ctx.fillRect(W / 2 - 60, 230, 120, 10);
      ctx.fillStyle = '#0a0a0c';
      ctx.font = 'bold 54px Manrope, sans-serif';
      ctx.fillText(ev ? ev.title : '', W / 2, 340, W - 160);
      ctx.font = '40px Manrope, sans-serif';
      ctx.fillStyle = '#444';
      ctx.fillText(ev ? fmtWhen(ev.startsAt).toLowerCase() : '', W / 2, 410, W - 160);
      const size = 860;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, (W - size) / 2, 470, size, (size * vb.height) / vb.width);
      ctx.fillStyle = '#0a0a0c';
      ctx.font = 'bold 60px Manrope, sans-serif';
      ctx.fillText('Наведи камеру — проходка за минуту', W / 2, 1470, W - 120);
      ctx.font = '34px Manrope, sans-serif';
      ctx.fillStyle = '#777';
      ctx.fillText(url.replace(/^https?:\/\//, ''), W / 2, 1560, W - 120);
      ctx.font = '28px Manrope, sans-serif';
      ctx.fillText(`метка: ${tag}`, W / 2, 1620);
      URL.revokeObjectURL(blobUrl);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('qr'));
    };
    img.src = blobUrl;
  });
}

// ---------- анонс подписчикам ----------
let bcRunning = false;

async function refreshBroadcast() {
  const id = state.night;
  const e = nightById(id);
  const btn = $('bc-go');
  if (!e) {
    btn.disabled = true;
    return;
  }
  const r = await api('/api/tg-webhook', { method: 'POST', body: { action: 'broadcast_status', event_id: id } });
  if (state.night !== id || bcRunning) return;
  if (r.ok) {
    state.subs = Number(r.j.subs || 0);
    renderSubs(state.subs);
    renderBc(r.j);
  }
  const onsale = ['onsale', 'soldout', 'live'].includes(phaseOf(e)) && e.status === 'onsale';
  const done = r.ok && r.j.done;
  btn.disabled = !onsale || done || !state.subs || (r.ok && r.j.bot === false);
  btn.innerHTML = `${icon(done ? 'check' : 'send')}${done ? 'Анонс разослан' : 'Разослать анонс'}`;
  $('bc-note').textContent = r.ok && r.j.bot === false
    ? 'Бот не подключён: в Vercel нет TELEGRAM_BOT_TOKEN.'
    : !onsale ? 'Анонс можно разослать для ночи в продаже.'
      : !state.subs ? 'Подписчиков пока нет — их собирает кнопка «Узнать первым» на сайте и ссылка ниже.' : '';
}

function renderBc(st) {
  const prog = $('bc-prog');
  if (!st || !st.started) {
    prog.hidden = true;
    return;
  }
  prog.hidden = false;
  const sent = Number(st.sent || 0);
  const failed = Number(st.failed || 0);
  const total = Math.max(Number(st.total || 0), sent + failed);
  const pct = st.done ? 100 : total ? Math.round(((sent + failed) / total) * 100) : 0;
  prog.querySelector('i').style.width = `${pct}%`;
  $('bc-prog-t').textContent = st.done
    ? `Разослано: ${sent}${failed ? ` · не доставлено ${failed} (бот заблокирован — отписали)` : ''}`
    : `Отправлено ${sent + failed} из ${total}…`;
}

export async function startBroadcast(eventId) {
  if (bcRunning) return;
  const e = nightById(eventId);
  if (!e) return;
  if (e.status !== 'onsale') {
    toast('Разослать можно только ночь в продаже', 'err');
    return;
  }
  if (state.night !== eventId) setNight(eventId);
  const st = await api('/api/tg-webhook', { method: 'POST', body: { action: 'broadcast_status', event_id: eventId } });
  if (st.ok && st.j.bot === false) {
    toast('Бот не подключён: нет TELEGRAM_BOT_TOKEN', 'err');
    return;
  }
  if (st.ok && st.j.done) {
    toast('Анонс этой ночи уже разослан', 'info');
    renderBc(st.j);
    return;
  }
  const subs = st.ok ? Number(st.j.subs || 0) : state.subs;
  if (!subs) {
    toast('Подписчиков пока нет', 'info');
    return;
  }
  const ok = await confirmDlg({
    title: 'Разослать анонс?',
    html: `<p>Анонс «${esc(e.title)}» с афишей и кнопкой брони получат <b>${subs}</b> ${plural(subs, 'подписчик', 'подписчика', 'подписчиков')} бота.</p>
      <p class="small muted">Каждый получит одно сообщение. Повторно эту ночь разослать нельзя — проверь афишу и цены.</p>`,
    ok: 'Разослать',
  });
  if (!ok) return;
  bcRunning = true;
  const btn = $('bc-go');
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    for (let i = 0; i < 200; i++) {
      const r = await api('/api/tg-webhook', { method: 'POST', body: { action: 'broadcast', event_id: eventId }, timeout: 60000 });
      if (!r.ok) {
        toast(r.message || 'Рассылка прервалась — нажми ещё раз, она продолжится', 'err', 7000);
        break;
      }
      renderBc({ started: true, ...r.j });
      if (r.j.done) {
        toast(`Анонс разослан: ${r.j.sent} ${plural(r.j.sent, 'сообщение', 'сообщения', 'сообщений')}`);
        break;
      }
      await sleep(r.j.busy ? 5000 : 300);
    }
  } finally {
    bcRunning = false;
    btn.classList.remove('is-busy');
    btn.disabled = false;
    refreshBroadcast();
  }
}

// ---------- откуда гости ----------
function renderSources() {
  const host = $('sources-table');
  const s = state.stats;
  if (!s || s.event_id !== state.night) {
    host.innerHTML = '<div class="sk" style="height:120px"></div>';
    return;
  }
  const list = s.sources || [];
  if (!list.length) {
    host.innerHTML = `<div class="empty">${icon('megaphone')}<b>Броней пока нет</b><span class="small">Раздай промоутерам ссылки с метками — здесь будет видно, кто сколько продал.</span></div>`;
    return;
  }
  const max = Math.max(1, ...list.map((r) => r.paid));
  host.innerHTML = `<table class="table"><thead><tr><th>Источник</th><th class="r">Оплачено</th><th class="r">Ждут</th><th class="r">Выручка</th><th class="barc"></th></tr></thead><tbody>
    ${list.map((r) => `<tr><td>${esc(SRC_LABEL[r.src] || r.src)}</td><td class="r">${r.paid}</td><td class="r">${r.pending || ''}</td>
      <td class="r">${esc(rub(r.rub))}</td><td class="barc"><div class="meter"><i style="width:${Math.max(3, Math.round((r.paid / max) * 100))}%"></i></div></td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- обработчики ----------
let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  $('pr-copy').onclick = async () => {
    const e = nightById(state.night);
    if (!e) return;
    if (await copyText(siteUrl(e))) toast('Ссылка скопирована');
  };
  $('src-copy').onclick = async () => {
    const l = srcLink();
    if (!l) {
      $('src-tag').focus();
      toast('Впиши метку — латиницей или по-русски, без пробелов', 'info');
      return;
    }
    const okCopy = await copyText(l.url);
    $('src-note').textContent = l.url;
    if (okCopy) toast('Ссылка с меткой скопирована');
  };
  $('src-qr').onclick = async () => {
    const l = srcLink();
    if (!l) {
      $('src-tag').focus();
      toast('Впиши метку — по ней будет видно, сколько продал постер', 'info');
      return;
    }
    await busy($('src-qr'), async () => {
      try {
        const png = await posterPng(l);
        download(`projectx-qr-${l.tag}.png`, png);
        $('src-note').textContent = `Постер с меткой «${l.tag}» скачан — печатай на A4.`;
      } catch {
        toast('Не получилось нарисовать постер', 'err');
      }
    });
  };
  $('src-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('src-copy').click(); });
  $('bc-go').onclick = () => startBroadcast(state.night);
}
