// Оформление проходок. Один атомарный SQL-стейтмент (CTE): списание квоты
// волны → заказ → N именных билетов. Нет строки из w — волна распродана,
// ничего не создано. Цена берётся ТОЛЬКО из БД.
//
// Режим оплаты (PAYMENT_MODE, см. _lib/booking.js):
//   transfer — бронь: заказ 'pending' с кодом брони и сроком, билеты
//              'reserved'. Гость переводит по СБП, владелец подтверждает
//              (касса /api/walkin action=confirm или кнопка в Telegram).
//   demo     — проходка выдаётся сразу (демо-стенд, тесты).
//
// POST { action: 'claim', order_id } — гость нажал «Я перевёл»: заказ
// помечается, владельцу уходит уведомление с кнопкой подтверждения.
import { validateAttendees, normalizePhone } from '../assets/ticket-format.js';
import { db, hasDb } from './_lib/db.js';
import { ticketId, orderId, payCode } from './_lib/ids.js';
import { makeToken, primarySecret } from './_lib/sign.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner, tgBotUsername } from './_lib/tg.js';
import { paymentMode, holdMinutes, isOrderId, transferText } from './_lib/booking.js';

import { ORDER_SQL, NEXT_WAVE_SQL, EXPIRE_SQL } from './_lib/queries.js';

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

  const sql = db();

  let event;
  try {
    // сгоревшие брони освобождают места до того, как мы попробуем занять свои
    await sql.query(EXPIRE_SQL);
    const rows = await sql.query(
      `SELECT id, title, city, venue, starts_at, age_rating, status FROM events WHERE id = $1`,
      [eventId]
    );
    event = (rows.rows || rows)[0];
  } catch (err) {
    console.warn('order: БД недоступна:', err.message);
    return fail(res, 503, 'db_unavailable', 'Онлайн-оформление сейчас недоступно');
  }
  if (!event) return fail(res, 404, 'not_found', 'Такой тусовки нет');
  if (event.status !== 'onsale' || new Date(event.starts_at) <= new Date()) {
    return fail(res, 410, 'sales_closed', 'Продажи на эту тусовку закрыты');
  }

  const av = validateAttendees(attendees, Number(event.age_rating));
  if (!av.ok) {
    const minor = av.errors.some((e) => e.code === 'minor_forbidden');
    return fail(res, 400, 'validation',
      minor ? 'Вечеринка 18+ — проходки несовершеннолетним не продаются' : 'Заполни имена всех гостей',
      { attendees: av.errors });
  }

  const qty = attendees.length;
  const names = attendees.map((a) => String(a.name).trim().slice(0, 80));
  const ages = attendees.map((a) => (a.minor && Number(event.age_rating) < 18 ? 'minor' : 'adult'));

  const transfer = paymentMode() === 'transfer';
  const provider = transfer ? 'transfer' : 'stub';
  const hold = transfer ? holdMinutes(event.starts_at) : 0;

  // Коллизия id билета (48 бит) или кода брони почти невероятна, но UNIQUE + повтор — обязаны
  let created = 0;
  let priceRub = null;
  let oid = null;
  let tids = [];
  let code = null;
  let expiresAt = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    oid = orderId();
    tids = names.map(() => ticketId());
    code = transfer ? payCode() : null;
    try {
      const rows = await sql.query(ORDER_SQL, [
        qty, eventId, waveNo, oid, buyerName, phone, buyerTg,
        utm ? JSON.stringify(utm) : null, tids, names, ages, provider, hold, code, false,
      ]);
      const r = (rows.rows || rows)[0] || {};
      priceRub = r.price_rub === null ? null : Number(r.price_rub);
      created = Number(r.created || 0);
      expiresAt = r.expires_at ? new Date(r.expires_at).toISOString() : null;
      break;
    } catch (err) {
      if (/duplicate key/i.test(String(err.message)) && attempt < 2) continue;
      console.error('order failed:', err);
      return fail(res, 503, 'db_unavailable', 'Онлайн-оформление сейчас недоступно');
    }
  }

  if (priceRub === null || created !== qty) {
    // волна распродана (или мест меньше, чем просят) — предлагаем следующую цену
    let nextWave = null;
    try {
      const rows = await sql.query(NEXT_WAVE_SQL, [eventId]);
      const nw = (rows.rows || rows)[0];
      if (nw) {
        nextWave = { waveNo: Number(nw.wave_no), name: nw.name, priceRub: Number(nw.price_rub), left: Number(nw.left) };
      }
    } catch { /* не критично */ }
    return fail(res, 409, 'wave_sold_out',
      nextWave ? 'Эта волна закончилась — есть следующая' : 'Все проходки проданы',
      { next_wave: nextWave });
  }

  const secret = primarySecret();
  const tickets = tids.map((id, i) => ({
    id,
    holder_name: names[i],
    url: `/t/${makeToken(id, secret)}`,
  }));

  const amount = priceRub * qty;
  await notifyOwner(
    transfer
      ? `🕒 Бронь ${code}: ${qty} × ${priceRub} ₽ = ${amount} ₽ · ждём перевод\n` +
        `${event.title}\nГость: ${buyerName}, ${phone}${buyerTg ? ', @' + buyerTg : ''}\n` +
        `Имена: ${names.join(', ')}\nСрок брони: ${hold} мин · заказ ${oid}`
      : `💸 Продажа: ${qty} × ${priceRub} ₽ = ${amount} ₽\n` +
        `${event.title} · ${event.venue}\n` +
        `Покупатель: ${buyerName}, ${phone}${buyerTg ? ', @' + buyerTg : ''}\n` +
        `Гости: ${names.join(', ')}\nЗаказ ${oid}`
  );

  ok(res, {
    order_id: oid,
    amount_rub: amount,
    pay_code: code,
    expires_at: expiresAt,
    hold_minutes: hold,
    bot: tgBotUsername(),
    payment: { provider, status: transfer ? 'pending' : 'paid' },
    tickets,
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
