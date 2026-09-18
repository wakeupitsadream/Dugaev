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
import { normalizePhone } from '../assets/ticket-format.js';
import { db, hasDb } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner, tgBotUsername } from './_lib/tg.js';
import { isOrderId } from './_lib/booking.js';
import { placeOrder, ownerNotice } from './_lib/order-core.js';

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
  const buyerName = String(buyer.name || '').trim();
  const buyerTg = String(buyer.tg || '').trim().replace(/^@/, '').slice(0, 64) || null;
  const utm = typeof b.utm === 'object' && b.utm ? { src: String(b.utm.src || '').slice(0, 32) } : null;

  const fieldErrors = {};
  if (!eventId || !Number.isInteger(waveNo)) return fail(res, 400, 'validation', 'Некорректный запрос');
  if (buyerName.length < 2) fieldErrors.name = 'Как тебя зовут?';
  if (!phone) fieldErrors.phone = 'Нужен телефон в формате +7...';
  if (b.consent !== true) fieldErrors.consent = 'Нужно согласие на обработку данных';
  if (Object.keys(fieldErrors).length) {
    return fail(res, 400, 'validation', 'Проверь поля', { fields: fieldErrors });
  }

  if (!hasDb()) {
    return fail(res, 503, 'db_unavailable', 'Онлайн-оформление сейчас недоступно');
  }

  const r = await placeOrder(db(), { eventId, waveNo, buyerName, phone, buyerTg, utm, attendees });
  if (!r.ok) return fail(res, r.status, r.error, r.message, r.extra || {});
  const { event, order } = r;
  await notifyOwner(ownerNotice(event, order, 'сайт'));

  ok(res, {
    order_id: order.id,
    amount_rub: order.amount,
    pay_code: order.code,
    expires_at: order.expiresAt,
    hold_minutes: order.hold,
    bot: tgBotUsername(),
    payment: { provider: order.provider, status: order.transfer ? 'pending' : 'paid' },
    tickets: order.tickets,
  });
}

// Гость нажал «Я перевёл». Заказ перестаёт сгорать по таймеру (решает
// владелец), владельцу — уведомление с кнопками подтверждения.
async function claim(req, res, b) {
  const oid = String(b.order_id || '');
  if (!isOrderId(oid)) return fail(res, 400, 'validation', 'Некорректный номер брони');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'Сервис недоступен');
  try {
    const rows = await db().query(
      `UPDATE orders SET claimed_at = COALESCE(claimed_at, now())
       WHERE id = $1 AND status = 'pending'
       RETURNING id, pay_code, amount_rub, qty, buyer_name, buyer_phone, claimed_at, event_id`,
      [oid]
    );
    const o = (rows.rows || rows)[0];
    if (!o) {
      // уже подтверждена, сгорела или отменена — страница проходки покажет актуальный статус
      const st = await db().query(`SELECT status FROM orders WHERE id = $1`, [oid]);
      const s = (st.rows || st)[0];
      return fail(res, 409, 'not_pending', 'Бронь уже обработана', { status: s ? s.status : 'not_found' });
    }
    await notifyOwner(
      `💸 Гость сообщил о переводе\n${o.pay_code} · ${o.amount_rub} ₽ · ${o.qty} шт.\n` +
        `${o.buyer_name}, ${o.buyer_phone}\n\nПроверь поступление в банке и подтверди:`,
      {
        inline_keyboard: [[
          { text: `✅ Подтвердить ${o.pay_code}`, callback_data: `pay:${o.id}` },
          { text: '✖ Не пришло', callback_data: `nopay:${o.id}` },
        ]],
      }
    );
    return ok(res, { claimed_at: new Date(o.claimed_at).toISOString(), pay_code: o.pay_code });
  } catch (err) {
    console.warn('claim failed:', err.message);
    return fail(res, 503, 'db_unavailable', 'Сервис недоступен');
  }
}
