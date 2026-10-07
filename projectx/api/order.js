// Оформление проходок с сайта. Само оформление — в _lib/order-core.js
// (одно ядро на сайт и бота): атомарный SQL (CTE) списывает квоту волны,
// создаёт заказ и N именных билетов; цена берётся ТОЛЬКО из БД.
//
// Режим оплаты (PAYMENT_MODE, см. _lib/booking.js):
//   transfer — бронь: заказ 'pending' с кодом брони и сроком, билеты
//              'reserved'. Гость переводит по СБП, владелец подтверждает
//              (касса /api/walkin action=confirm или кнопка в Telegram).
//   demo     — проходка выдаётся сразу (демо-стенд, тесты).
//
// POST { action: 'claim', order_id } — гость нажал «Я перевёл»: заказ
// помечается, владельцу уходит уведомление с кнопкой подтверждения.
import { createHash } from 'node:crypto';
import { normalizePhone, formatRuPhoneDigits } from '../assets/ticket-format.js';
import { db, hasDb } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner, tgBotUsername } from './_lib/tg.js';
import { isOrderId, TEST_PHONE, orderStart } from './_lib/booking.js';
import { CLAIM_SQL } from './_lib/queries.js';
import { isAdmin } from './_lib/auth.js';
import { placeOrder, ownerNotice, ownerNoticeMarkup } from './_lib/order-core.js';

// Адрес гостя в базе не храним — только короткий хеш для лимита броней
function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.socket?.remoteAddress || '');
  if (!ip) return '';
  return createHash('sha256').update(`${ip}|${process.env.TICKET_SECRET || ''}`).digest('hex').slice(0, 16);
}

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;

  const b = req.body || {};
  if (b.action === 'claim') return claim(req, res, b);

  // honeypot: боты заполняют скрытое поле — отвечаем «успехом», квоты не жжём
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return ok(res, { order_id: 'ord_thanks', payment: { provider: 'stub', status: 'paid' }, tickets: [] });
  }

  const eventId = String(b.event_id || '');
  const waveNo = Number(b.wave_no);
  const buyer = b.buyer || {};
  const attendees = Array.isArray(b.attendees) ? b.attendees : [];
  const phone = normalizePhone(String(buyer.phone || ''));
  const buyerName = String(buyer.name || '').trim().slice(0, 80);
  const buyerTg = String(buyer.tg || '').trim().replace(/^@/, '').slice(0, 64) || null;
  const utm = typeof b.utm === 'object' && b.utm ? { src: String(b.utm.src || '').slice(0, 32) } : null;

  const fieldErrors = {};
  if (!eventId || !Number.isInteger(waveNo) || waveNo < 1 || waveNo > 32767) return fail(res, 400, 'validation', 'Некорректный запрос');
  if (buyerName.length < 2) fieldErrors.name = 'Как тебя зовут?';
  if (!phone) fieldErrors.phone = 'Нужен телефон в формате +7...';
  else if (phone === TEST_PHONE && !isAdmin(req)) fieldErrors.phone = 'Укажи настоящий номер';
  if (b.consent !== true) fieldErrors.consent = 'Нужно согласие на обработку данных';
  if (Object.keys(fieldErrors).length) {
    return fail(res, 400, 'validation', 'Проверь поля', { fields: fieldErrors });
  }

  if (!hasDb()) {
    return fail(res, 503, 'db_unavailable', 'Онлайн-оформление сейчас недоступно');
  }

  const r = await placeOrder(db(), { eventId, waveNo, buyerName, phone, buyerTg, utm, attendees, iph: ipHash(req) });
  if (!r.ok) return fail(res, r.status, r.error, r.message, r.extra || {});
  const { event, order } = r;
  await notifyOwner(ownerNotice(event, order, 'сайт'), ownerNoticeMarkup(order));

  ok(res, {
    order_id: order.id,
    amount_rub: order.amount,
    pay_code: order.code,
    expires_at: order.expiresAt,
    hold_minutes: order.hold,
    bot: tgBotUsername(),
    // ссылка в бот подписана: голый номер заказа видят все гости компании
    bot_start: order.transfer ? orderStart(order.id) : null,
    payment: { provider: order.provider, status: order.transfer ? 'pending' : 'paid' },
    tickets: order.tickets,
  });
}

// Гость нажал «Я перевёл». Заказ перестаёт сгорать по таймеру (решает
// владелец), владельцу — уведомление с кнопками подтверждения. Сгоревшую
// бронь тоже можно заявить — как в боте: перевод мог прийти позже срока,
// «Подтвердить» у владельца вернёт места, если они остались.
async function claim(req, res, b) {
  const oid = String(b.order_id || '');
  if (!isOrderId(oid)) return fail(res, 400, 'validation', 'Некорректный номер брони');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'Сервис недоступен');
  try {
    // одна бронь — одно уведомление за 10 минут (условие внутри CLAIM_SQL),
    // иначе кнопкой можно заспамить чат владельца
    const o = rowsOf(await db().query(CLAIM_SQL, [oid]))[0];
    if (!o) {
      const c = rowsOf(await db().query(`SELECT status, claimed_at FROM orders WHERE id = $1`, [oid]))[0];
      if (c && ['pending', 'expired'].includes(c.status) && c.claimed_at) {
        return ok(res, { claimed_at: new Date(c.claimed_at).toISOString(), repeated: true });
      }
      // уже подтверждена или отменена — страница проходки покажет актуальный статус
      return fail(res, 409, 'not_pending', 'Бронь уже обработана', { status: c ? c.status : 'not_found' });
    }
    const late = o.status === 'expired';
    await notifyOwner(
      `💸 Гость сообщил о переводе\n${o.pay_code} · ${o.amount_rub} ₽ · ${o.qty} шт.\n` +
        `${o.buyer_name}, ${fmtPhone(o.buyer_phone)}\n` +
        (late ? '⚠️ Бронь уже сгорела: «Подтвердить» вернёт места, если они ещё есть.\n' : '') +
        '\nПроверь поступление в банке и подтверди:',
      {
        inline_keyboard: [[
          { text: `✅ Подтвердить ${o.pay_code}`, callback_data: `pay:${o.id}` },
          { text: '✖ Не пришло', callback_data: `nopay:${o.id}` },
        ]],
      }
    );
    return ok(res, { claimed_at: new Date(o.claimed_at).toISOString(), pay_code: o.pay_code, late });
  } catch (err) {
    console.warn('claim failed:', err.message);
    return fail(res, 503, 'db_unavailable', 'Сервис недоступен');
  }
}

const rowsOf = (r) => (r && r.rows) || r || [];
const fmtPhone = (p) => (/^\+7\d{10}$/.test(String(p)) ? `+7 ${formatRuPhoneDigits(String(p).slice(2))}` : String(p || ''));
