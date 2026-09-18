// Экран «бронь оформлена → переведи по СБП → я перевёл». Один модуль на
// страницу ночи (сразу после брони) и страницу проходки (пока не оплачена):
// одинаковый вид, одна логика, одна кнопка «Я перевёл».
import { SITE } from './data/config.js';
import { esc } from './events-load.js';

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
  return `
  <div class="pay-box ${claimed ? 'is-claimed' : ''}" id="pay-box">
    <div class="pay-kicker">${claimed ? 'Ждём подтверждение' : 'Оплата переводом'}</div>
    <div class="pay-sum">${esc(String(order.amountRub))} ₽</div>
    <div class="pay-rows">
      <div class="pay-row"><span>СБП по номеру</span><b>${esc(t.phone || '—')}</b></div>
      ${t.bank ? `<div class="pay-row"><span>Банк получателя</span><b>${t.bankKey ? `<i class="bank-badge bank-${esc(t.bankKey)}" aria-hidden="true"></i>` : ''}${esc(t.bank)}</b></div>` : ''}
      ${t.recipient ? `<div class="pay-row"><span>Получатель</span><b>${esc(t.recipient)}</b></div>` : ''}
      <div class="pay-row"><span>Код в комментарии</span><b class="pay-code" id="pay-code">${esc(order.payCode || '')}</b></div>
    </div>
    <button class="btn btn-ghost btn-block" id="pay-copy" type="button">Скопировать код</button>
    <p class="pay-note">${esc(t.note || '')}${order.expiresAt && !claimed ? ` Бронь держим до <b>${esc(fmtDeadline(order.expiresAt))}</b>.` : ''}</p>
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
  const copy = $('pay-copy');
  if (copy) copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(order.payCode || '');
      copy.textContent = 'Скопировано';
    } catch {
      copy.textContent = 'Выдели код и скопируй';
    }
    setTimeout(() => { copy.textContent = 'Скопировать код'; }, 2500);
  };
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
        : 'Не получилось передать. Напиши нам в директ, приложи скрин перевода.';
    st.classList.remove('hidden');
  };
}
