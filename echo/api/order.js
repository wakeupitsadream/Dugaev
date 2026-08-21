// Покупка билетов. Один атомарный SQL-стейтмент (CTE):
// списание квоты волны → заказ → N именных билетов. Нет строки из w —
// волна распродана, ничего не создано. Цена берётся ТОЛЬКО из БД.
// Оплата v1 — stub (мгновенно paid); контракт под ЮKassa/СБП описан
// в assets/payment.js.
import { validateAttendees, normalizePhone } from '../assets/ticket-format.js';
import { db, hasDb } from './_lib/db.js';
import { ticketId, orderId } from './_lib/ids.js';
import { makeToken, primarySecret } from './_lib/sign.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner } from './_lib/tg.js';

import { ORDER_SQL, NEXT_WAVE_SQL } from './_lib/queries.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;

  const b = req.body || {};

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
      minor ? 'На тусовку 18+ билеты для несовершеннолетних не продаются' : 'Заполни имена всех гостей',
      { attendees: av.errors });
  }

  const qty = attendees.length;
  const names = attendees.map((a) => String(a.name).trim().slice(0, 80));
  const ages = attendees.map((a) => (a.minor && Number(event.age_rating) < 18 ? 'minor' : 'adult'));

  // Коллизия id билета (48 бит) почти невероятна, но UNIQUE + повтор — обязаны
  let created = 0;
  let priceRub = null;
  let oid = null;
  let tids = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    oid = orderId();
    tids = names.map(() => ticketId());
    try {
      const rows = await sql.query(ORDER_SQL, [
        qty, eventId, waveNo, oid, buyerName, phone, buyerTg,
        utm ? JSON.stringify(utm) : null, tids, names, ages, 'stub',
      ]);
      const r = (rows.rows || rows)[0] || {};
      priceRub = r.price_rub === null ? null : Number(r.price_rub);
      created = Number(r.created || 0);
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
      nextWave ? 'Эта волна закончилась — есть следующая' : 'Все билеты проданы',
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
    `💸 Продажа: ${qty} × ${priceRub} ₽ = ${amount} ₽\n` +
    `${event.title} · ${event.venue}\n` +
    `Покупатель: ${buyerName}, ${phone}${buyerTg ? ', @' + buyerTg : ''}\n` +
    `Гости: ${names.join(', ')}\nЗаказ ${oid}`
  );

  ok(res, {
    order_id: oid,
    amount_rub: amount,
    payment: { provider: 'stub', status: 'paid' },
    tickets,
  });
}
