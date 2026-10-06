// Брони, ожидающие оплаты переводом: подтвердить, отменить, подтвердить по
// коду из комментария к переводу, выгрузить оплаты в CSV.
import {
  $, qsa, state, api, on, visible, loadStats, nightById, setNight, esc, icon, toast, confirmDlg, busy, download,
  fmtTime, fmtPhone, plural, rub,
} from './core.js';
import { SITE } from '../data/config.js';
import { ordersCsv, csvFileName } from '../csv.js';

export function show() {
  bindOnce();
  render();
}
on('stats', () => {
  renderBadge();
  if (visible('orders')) render();
});
on('night', () => {
  renderBadge();
  if (visible('orders')) render();
});

const cur = () => (state.stats && state.stats.event_id === state.night ? state.stats : null);

function renderBadge() {
  const s = cur();
  const n = s ? (s.pending || []).length : 0;
  for (const b of qsa('[data-badge="pending"]')) {
    b.textContent = String(n);
    b.hidden = !n;
  }
}

function sorted(list) {
  // «Я перевёл» — сверху: эти гости уже ждут подтверждения
  return [...list].sort((a, b) => Number(Boolean(b.claimed_at)) - Number(Boolean(a.claimed_at)) || Date.parse(a.created_at) - Date.parse(b.created_at));
}

function leftText(o) {
  if (o.claimed_at) return `<span class="tag tag-warn">нажал «Я перевёл»</span> в ${esc(fmtTime(o.claimed_at))} — проверь банк`;
  if (!o.expires_at) return '';
  const left = Math.round((Date.parse(o.expires_at) - Date.now()) / 60000);
  if (left <= 0) return 'срок вышел — бронь сгорит при следующем обновлении';
  return left >= 60 ? `сгорит через ${Math.floor(left / 60)} ч ${left % 60} мин` : `сгорит через ${left} мин`;
}

function render() {
  const s = cur();
  const host = $('pending-list');
  if (!s) {
    host.innerHTML = '<div class="sk" style="height:84px"></div>';
    return;
  }
  const list = sorted(s.pending || []);
  $('pend-count').textContent = String(list.length);
  const sum = list.reduce((a, o) => a + o.amount_rub, 0);
  $('pend-sum').textContent = list.length ? `на ${rub(sum)}` : '';
  if (!list.length) {
    host.dataset.sig = '';
    const others = state.events.filter((e) => e.id !== state.night && Number(e.pending) > 0);
    host.innerHTML = `<div class="empty">${icon('check')}<b>Никто не ждёт</b><span class="small">Новые брони появятся здесь — и придут тебе в Telegram.</span>
      ${others.length ? `<button class="b b-ghost b-sm" type="button" data-other="${esc(others[0].id)}">Ещё ${others[0].pending} ${plural(Number(others[0].pending), 'бронь', 'брони', 'броней')} на «${esc(others[0].title)}» →</button>` : ''}</div>`;
    const ob = host.querySelector('[data-other]');
    if (ob) ob.onclick = () => setNight(ob.dataset.other);
    return;
  }
  // список не перестраивается под пальцем: состав и статусы те же —
  // обновляем только таймеры, иначе новый «Я перевёл» сдвигал бы строки
  const sig = list.map((o) => `${o.id}:${o.claimed_at ? 'c' : 'p'}`).join('|');
  if (host.dataset.sig === sig) {
    for (const o of list) {
      const el = host.querySelector(`.pend[data-id="${CSS.escape(o.id)}"] .pend-left`);
      if (el) el.innerHTML = leftText(o);
    }
    return;
  }
  host.dataset.sig = sig;
  host.innerHTML = list.map((o) => {
    const names = (o.tickets || []).map((t) => t.holder_name).join(', ');
    const tg = o.buyer_tg ? `<a href="https://t.me/${encodeURIComponent(o.buyer_tg)}" target="_blank" rel="noopener">@${esc(o.buyer_tg)}</a>` : '';
    return `<div class="pend${o.claimed_at ? ' is-claimed' : ''}" data-id="${esc(o.id)}" data-code="${esc(o.pay_code || o.id)}" data-sum="${o.amount_rub}" data-who="${esc(o.buyer_name)}">
      <div class="pend-code">${esc(o.pay_code || '—')}</div>
      <div class="pend-main">
        <div class="pend-who">${esc(o.buyer_name)} · <a href="tel:${esc(o.buyer_phone)}">${esc(fmtPhone(o.buyer_phone))}</a>${tg ? ` · ${tg}` : ''}${o.tg ? ' · <span class="tag">в боте</span>' : ''}</div>
        <div class="pend-what">${o.qty} × ${esc(rub(o.amount_rub / o.qty))} = <b>${esc(rub(o.amount_rub))}</b> · ${esc(names)}</div>
        <div class="pend-left">${leftText(o)}</div>
      </div>
      <div class="pend-acts">
        <button class="b b-ok b-sm" data-act="confirm" type="button">${icon('check')}Подтвердить</button>
        <button class="b b-ghost b-sm" data-act="cancel" type="button">Отменить</button>
      </div>
    </div>`;
  }).join('');
}

async function act(kind, row, btn) {
  const code = row.dataset.code;
  const sum = rub(Number(row.dataset.sum));
  const who = row.dataset.who;
  const ok = kind === 'confirm'
    ? await confirmDlg({
      title: `Подтвердить ${code}?`,
      html: `<p><b>${esc(sum)}</b> · ${esc(who)}</p><p class="small muted">Проверь, что перевод с кодом ${esc(code)} пришёл в банк. После подтверждения бот пришлёт гостю проходки.</p>`,
      ok: 'Перевод пришёл', kind: 'ok',
    })
    : await confirmDlg({
      title: `Отменить бронь ${code}?`,
      text: 'Места вернутся в продажу, гостю в боте придёт сообщение об отмене.',
      ok: 'Отменить бронь', cancel: 'Не отменять', danger: true,
    });
  if (!ok) return;
  const r = await busy(btn, () => api('/api/walkin', {
    method: 'POST',
    body: kind === 'confirm'
      ? { action: 'confirm', order_id: row.dataset.id, provider: 'transfer', by: state.name }
      : { action: 'cancel', order_id: row.dataset.id, by: state.name },
  }));
  if (!r.ok) toast(r.message || 'Не получилось — проверь сеть', 'err', 6000);
  else toast(kind === 'confirm' ? `${code}: оплата подтверждена — проходки у гостя` : `${code}: бронь отменена`);
  $('pending-list').dataset.sig = '';
  loadStats();
}

async function confirmByCode() {
  const input = $('pc-code');
  const code = input.value.trim();
  if (!code) {
    input.focus();
    return;
  }
  const r = await busy($('pc-confirm'), () => api('/api/walkin', {
    method: 'POST',
    body: { action: 'confirm', pay_code: code, provider: 'transfer', by: state.name },
  }));
  if (r.ok) {
    $('pc-note').textContent = `Подтверждено: ${r.j.pay_code} · ${rub(r.j.amount_rub)}${r.j.restored ? ' · бронь была сгоревшей, восстановлена' : ''}`;
    toast(`${r.j.pay_code}: оплата подтверждена`);
    input.value = '';
    loadStats();
  } else {
    $('pc-note').textContent = r.message || 'Не получилось — проверь сеть';
  }
}

// Оплаченные заказы ночи → CSV: продавец выбивает по ним чеки в «Мой
// налог», файл открывается в Excel без импорта (BOM, «;»)
async function exportCsv() {
  const id = state.night;
  if (!id) return;
  const r = await busy($('btn-export'), () => api(`/api/stats?event_id=${encodeURIComponent(id)}&orders=1`, { timeout: 20000 }));
  if (!r.ok) {
    toast(`Выгрузка не удалась: ${r.message}`, 'err');
    return;
  }
  const orders = r.j.orders || [];
  download(csvFileName(id), new Blob([ordersCsv(orders, { tz: SITE.tz })], { type: 'text/csv;charset=utf-8' }));
  const e = nightById(id);
  toast(`Оплат в файле: ${orders.length}${e ? ` · ${e.title}` : ''}`);
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  $('pending-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const row = b && b.closest('.pend');
    if (row) act(b.dataset.act, row, b);
  });
  $('pc-confirm').onclick = confirmByCode;
  $('pc-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmByCode(); });
  $('btn-export').onclick = exportCsv;
  // таймеры «сгорит через» тикают и без новых данных
  setInterval(() => {
    if (!visible('orders')) return;
    const s = cur();
    if (!s) return;
    for (const o of s.pending || []) {
      const el = document.querySelector(`.pend[data-id="${CSS.escape(o.id)}"] .pend-left`);
      if (el) el.innerHTML = leftText(o);
    }
  }, 30_000);
}
