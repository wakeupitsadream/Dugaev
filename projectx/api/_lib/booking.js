// Бронь с оплатой переводом — правила, общие для заказа, кассы, бота и
// страницы проходки. Чистые функции + отправка сообщений гостю в Telegram.
//
// Режим оплаты задаёт сервер (PAYMENT_MODE), а не клиент:
//   'transfer' (по умолчанию) — заказ становится бронью, гость переводит
//                               по СБП, владелец подтверждает в админке или
//                               кнопкой в Telegram;
//   'demo'                    — как раньше: проходка выдаётся сразу (демо и тесты).
import { SITE } from '../../assets/data/config.js';
import { makeToken, primarySecret } from './sign.js';
import { tgApi } from './tg.js';

export function paymentMode() {
  return process.env.PAYMENT_MODE === 'demo' ? 'demo' : 'transfer';
}

// Сколько держим неоплаченную бронь: 3 часа, а в день ночи — час,
// чтобы места не висели за теми, кто передумал.
export function holdMinutes(startsAt, nowMs = Date.now()) {
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return 180;
  return t - nowMs <= 24 * 3600_000 ? 60 : 180;
}

// «px-7f3k», «PX7F3K», « px - 7f3k » → «PX-7F3K»; мусор → null
export function normalizePayCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s_]/g, '').replace(/^PX-?/, '');
  return /^[0-9A-Z]{4}$/.test(s) ? `PX-${s}` : null;
}

export const isOrderId = (s) => /^ord_[0-9a-z]{10}$/.test(String(s || ''));

// Реквизиты перевода одной строкой — для бота и уведомлений
export function transferText(amountRub, payCode) {
  const t = SITE.transfer || {};
  const lines = [
    `Сумма: ${amountRub} ₽`,
    t.phone ? `СБП по номеру: ${t.phone}${t.bank ? ` (${t.bank})` : ''}` : null,
    t.recipient ? `Получатель: ${t.recipient}` : null,
    payCode ? `В комментарии к переводу укажи код брони: ${payCode}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export function ticketLinks(tickets, origin) {
  const secret = primarySecret();
  return (tickets || []).map((t) => ({
    id: t.id,
    holder_name: t.holder_name,
    url: `${origin}/t/${makeToken(t.id, secret)}`,
  }));
}

// Абсолютный адрес сайта для ссылок в сообщениях (Telegram открывает их
// во встроенном браузере без VPN).
export function siteOrigin(req) {
  const env = process.env.SITE_ORIGIN;
  if (env) return env.replace(/\/+$/, '');
  const host = String(req?.headers?.host || 'proxject.ru');
  return `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`;
}

// Сообщение гостю в его чат с ботом. Молча ничего не делает без токена
// или без привязанного чата — основной сценарий от этого не зависит.
export async function tellGuest(chatId, text, replyMarkup) {
  if (!chatId) return null;
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }, 3000);
}

// Гостю: проходки после подтверждения оплаты
export async function deliverTickets(chatId, order, tickets, origin) {
  if (!chatId) return null;
  const links = ticketLinks(tickets, origin);
  const lines = links.map((t) => `• ${t.holder_name}: ${t.url}`);
  return tellGuest(
    chatId,
    `✅ Оплата подтверждена — проходки у тебя.\n\n${lines.join('\n')}\n\n` +
      `Открой каждую, сделай скриншот QR и перешли друзьям их именные. ` +
      `На входе — паспорт, двери в ${SITE.doorsOpen || '22:00'}.`
  );
}
