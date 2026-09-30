// Экран «бронь оформлена → переведи по СБП → я перевёл». Один модуль на
// страницу ночи (сразу после брони) и страницу проходки (пока не оплачена):
// одинаковый вид, одна логика, одна кнопка «Я перевёл».
import { SITE } from './data/config.js';
import { esc } from './events-load.js';
import { fmtRub } from './waves.js';

const $ = (id) => document.getElementById(id);

export function fmtDeadline(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: SITE.tz || 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long',
  });
}

export function botLink(bot, orderId) {
  return bot && orderId ? `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(orderId)}` : null;
}

// order: { id, payCode, amountRub, qty, expiresAt, claimedAt }, bot: username|null
export function payBlockHtml(order, bot, opts = {}) {
  const t = SITE.transfer || {};
  const claimed = Boolean(order.claimedAt);
  const link = botLink(bot, order.id);
  const qty = Number(order.qty || 0);
  return `
  <div class="pay-box ${claimed ? 'is-claimed' : ''}" id="pay-box">
    <div class="pay-kicker">${claimed ? 'Ждём подтверждение' : 'Оплата переводом'}</div>
    <div class="pay-sum">${fmtRub(order.amountRub)} ₽</div>
    ${qty > 1 ? `<p class="pay-note">Одним переводом за все ${qty} проходки платит тот, кто бронировал. Если платишь ты — укажи код брони.</p>` : ''}
    <div class="pay-rows">
      <div class="pay-row"><span>СБП по номеру</span><b>${esc(t.phone || '—')}</b></div>
      ${t.bank ? `<div class="pay-row"><span>Банк получателя</span><b>${t.bankKey ? `<i class="bank-badge bank-${esc(t.bankKey)}" aria-hidden="true"></i>` : ''}${esc(t.bank)}</b></div>` : ''}
      ${t.recipient ? `<div class="pay-row"><span>Получатель</span><b>${esc(t.recipient)}</b></div>` : ''}
      <div class="pay-row"><span>Код в комментарии</span><b class="pay-code" id="pay-code">${esc(order.payCode || '')}</b></div>
    </div>
    <div class="pay-copy-row">
      <button class="btn btn-ghost" id="pay-copy" type="button">Скопировать код</button>
      <button class="btn btn-ghost" id="pay-copy-phone" type="button">Номер</button>
      <button class="btn btn-ghost" id="pay-copy-sum" type="button">Сумму</button>
    </div>
    <ol class="pay-steps">
      <li>Открой приложение своего банка → Переводы → <b>По номеру телефона</b>.</li>
      <li>Номер <b>${esc(t.phone || '')}</b>${t.bank ? `, банк получателя <b>${esc(t.bank)}</b>` : ''}${t.recipient ? ` — получатель покажется как <b>${esc(t.recipient)}</b>${/\.$/.test(t.recipient) ? '' : '.'}` : '.'}</li>
      <li>Сумма <b>${fmtRub(order.amountRub)} ₽</b>. В поле «Сообщение получателю» вставь код <b>${esc(order.payCode || '')}</b>.</li>
      <li>Вернись сюда и нажми <b>«Я перевёл»</b> — бронь перестанет сгорать по таймеру. Забыл код? Не страшно: найдём по сумме и телефону.</li>
    </ol>
    <p class="pay-note">${order.expiresAt && !claimed ? `Бронь держим до <b>${esc(fmtDeadline(order.expiresAt))}</b>.` : ''}</p>
    ${claimed
      ? `<div class="pay-status" id="pay-status">Ты сообщил о переводе — как только мы его увидим, проходка станет активной. Обычно это несколько минут.</div>`
      : `<button class="btn btn-acid btn-block" id="pay-claim" type="button">Я перевёл</button>
         <div class="pay-status hidden" id="pay-status"></div>`}
    ${link ? `<a class="btn btn-ghost btn-block" id="pay-tg" href="${esc(link)}" target="_blank" rel="noopener">Получить проходку в Telegram</a>
             <p class="pay-note">Бот пришлёт проходку и адрес сразу после подтверждения — не надо держать эту страницу открытой.</p>` : ''}
    ${opts.footer || ''}
  </div>`;
}

// Навешивает копирование кода и «Я перевёл». onClaimed(claimedAt) — коллбек.
export function bindPayBlock(order, { onClaimed } = {}) {
  const t = SITE.transfer || {};
  const copyBtn = (id, value, label, fallback) => {
    const b = $(id);
    if (!b) return;
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(value);
        b.textContent = 'Скопировано';
      } catch {
        b.textContent = fallback;
      }
      setTimeout(() => { b.textContent = label; }, 2500);
    };
  };
  copyBtn('pay-copy', order.payCode || '', 'Скопировать код', 'Выдели код и скопируй');
  copyBtn('pay-copy-phone', String(t.phone || '').replace(/[^\d+]/g, ''), 'Номер', 'Выдели номер');
  copyBtn('pay-copy-sum', String(order.amountRub || ''), 'Сумму', 'Выдели сумму');
  const claim = $('pay-claim');
  if (claim) claim.onclick = async () => {
    claim.disabled = true;
    claim.textContent = 'Передаём…';
    let j = null;
    try {
      const r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim', order_id: order.id }),
      });
      j = await r.json().catch(() => null);
    } catch { /* ниже */ }
    const st = $('pay-status');
    if (j?.ok) {
      claim.classList.add('hidden');
      $('pay-box')?.classList.add('is-claimed');
      const k = document.querySelector('#pay-box .pay-kicker');
      if (k) k.textContent = 'Ждём подтверждение';
      st.textContent = 'Спасибо! Как только увидим перевод, проходка станет активной. Обычно это несколько минут.';
      st.classList.remove('hidden');
      onClaimed?.(j.claimed_at);
      return;
    }
    claim.disabled = false;
    claim.textContent = 'Я перевёл';
    st.textContent = j?.status === 'paid'
      ? 'Оплата уже подтверждена — обнови страницу.'
      : j?.status === 'expired' || j?.status === 'cancelled'
        ? 'Бронь уже не активна — забронируй заново.'
        : 'Не получилось передать. Напиши нам в Telegram и приложи скрин перевода.';
    st.classList.remove('hidden');
  };
}
