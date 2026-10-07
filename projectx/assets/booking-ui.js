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

// start — подписанная ссылка на бронь от сервера (bot_start / botStart): голый
// номер заказа бот не принимает, его видят все гости компании
export function botLink(bot, start) {
  return bot && start ? `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(start)}` : null;
}

// order: { id, payCode, amountRub, qty, expiresAt, claimedAt, botStart }, bot: username|null
export function payBlockHtml(order, bot, opts = {}) {
  const t = SITE.transfer || {};
  const claimed = Boolean(order.claimedAt);
  const link = botLink(bot, order.botStart);
  const qty = Number(order.qty || 0);
  return `
  <div class="pay-box ${claimed ? 'is-claimed' : ''}" id="pay-box">
    <div class="pay-kicker">${claimed ? 'Ждём подтверждение' : 'Оплата переводом'}</div>
    <div class="pay-sum" id="pay-sum">${fmtRub(order.amountRub)} ₽</div>
    ${qty > 1 ? `<p class="pay-note">Одним переводом за все ${qty} проходки платит тот, кто бронировал. Если платишь ты — укажи код брони.</p>` : ''}
    <div class="pay-rows">
      <div class="pay-row"><span>СБП по номеру</span><b id="pay-phone">${esc(t.phone || '—')}</b></div>
      ${t.bank ? `<div class="pay-row"><span>Банк получателя</span><b>${t.bankKey ? `<i class="bank-badge bank-${esc(t.bankKey)}" aria-hidden="true"></i>` : ''}${esc(t.bank)}</b></div>` : ''}
      ${t.recipient ? `<div class="pay-row"><span>Получатель</span><b>${esc(t.recipient)}</b></div>` : ''}
      <div class="pay-row"><span>Код в комментарии</span><b class="pay-code" id="pay-code">${esc(order.payCode || '')}</b></div>
    </div>
    <div class="pay-copy">
      <span class="pay-copy-l">Скопировать</span>
      <div class="pay-copy-row">
        <button class="btn btn-ghost" id="pay-copy" type="button">Код</button>
        <button class="btn btn-ghost" id="pay-copy-phone" type="button">Номер</button>
        <button class="btn btn-ghost" id="pay-copy-sum" type="button">Сумму</button>
      </div>
      <p class="pay-copy-note" id="pay-copy-note" aria-live="polite"></p>
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
  // Подпись кнопки не меняется — меняется только отметка рядом: длинное
  // «Скопировано» раздвигало ряд, и весь блок оплаты уезжал за край экрана
  const note = $('pay-copy-note');
  let noteTimer = 0;
  const say = (text) => {
    if (!note) return;
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note.textContent = ''; }, 2600);
  };
  const copyBtn = (id, value, what, sourceId) => {
    const b = $(id);
    if (!b) return;
    b.onclick = async () => {
      for (const other of document.querySelectorAll('.pay-copy-row .btn')) other.classList.remove('is-done');
      try {
        await navigator.clipboard.writeText(value);
        b.classList.add('is-done');
        say(`${what} скопирован${what === 'Сумма' ? 'а' : ''} — вставь в приложении банка`);
        setTimeout(() => b.classList.remove('is-done'), 2600);
      } catch {
        // буфер недоступен (встроенный браузер) — выделяем значение, копирует сам человек
        const src = sourceId && $(sourceId);
        if (src && window.getSelection) {
          const range = document.createRange();
          range.selectNodeContents(src);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        say(`Не получилось скопировать — ${what.toLowerCase()} выделен${what === 'Сумма' ? 'а' : ''}, скопируй вручную`);
      }
    };
  };
  copyBtn('pay-copy', order.payCode || '', 'Код', 'pay-code');
  copyBtn('pay-copy-phone', String(t.phone || '').replace(/[^\d+]/g, ''), 'Номер', 'pay-phone');
  copyBtn('pay-copy-sum', String(order.amountRub || ''), 'Сумма', 'pay-sum');
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
      st.textContent = j.late
        ? 'Срок брони уже вышел, но заявку мы передали: если места ещё есть, организатор подтвердит перевод, если нет — свяжется с тобой.'
        : 'Спасибо! Как только увидим перевод, проходка станет активной. Обычно это несколько минут.';
      st.classList.remove('hidden');
      onClaimed?.(j.claimed_at);
      return;
    }
    claim.disabled = false;
    claim.textContent = 'Я перевёл';
    st.textContent = j?.status === 'paid'
      ? 'Оплата уже подтверждена — обнови страницу.'
      : j?.status === 'cancelled'
        ? 'Бронь отменена — забронируй заново или напиши нам, если уже перевёл.'
        : 'Не получилось передать. Напиши нам в Telegram и приложи скрин перевода.';
    st.classList.remove('hidden');
  };
}
