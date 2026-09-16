// Касса: всё, что делают руками владелец и дверь. Один эндпоинт, действие
// в body.action (потолок serverless-функций на Vercel Hobby — 12):
//   walkin  — гость платит на входе: заказ + билет сразу 'paid'/'active',
//             опционально чек-ин (дверь, админ)
//   confirm — подтвердить оплату брони: перевод пришёл или наличные на
//             входе; билеты становятся 'active' (дверь, админ)
//   cancel  — отменить неоплаченную бронь, вернуть места (админ)
//   void    — аннулировать проходку: возврат/отзыв, место вернуть (админ)
//   rename  — переоформить проходку на другого человека (дверь, админ)
import { db, hasDb } from './_lib/db.js';
import { ticketId, orderId } from './_lib/ids.js';
import { makeToken, primarySecret } from './_lib/sign.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { roleOf, staffName } from './_lib/auth.js';
import { notifyOwner } from './_lib/tg.js';
import { normalizePayCode, isOrderId, deliverTickets, tellGuest, siteOrigin } from './_lib/booking.js';
import {
  ORDER_SQL, CHECKIN_SQL, NEXT_WAVE_SQL, CONFIRM_SQL, CANCEL_SQL, VOID_SQL, RENAME_SQL,
} from './_lib/queries.js';

const rowsOf = (r) => r.rows || r;

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;
  const role = roleOf(req);
  if (!role) return fail(res, 403, 'forbidden', 'Нужен ключ двери или админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');

  const b = req.body || {};
  const action = String(b.action || 'walkin');
  const by = String(b.by || '').trim().slice(0, 64) || staffName(req) || (role === 'door' ? 'дверь' : 'касса');

  if (action === 'walkin') return walkin(req, res, b, by);
  if (action === 'confirm') return confirm(req, res, b, by);
  if (role !== 'admin' && action !== 'rename') {
    return fail(res, 403, 'forbidden', 'Это действие доступно только владельцу');
  }
  if (action === 'cancel') return cancel(req, res, b, by);
  if (action === 'void') return voidTicket(req, res, b, by);
  if (action === 'rename') return rename(req, res, b, by);
  return fail(res, 400, 'validation', 'Неизвестное действие');
}

async function walkin(req, res, b, by) {
  const eventId = String(b.event_id || '');
  const waveNo = Number(b.wave_no);
  const name = String(b.name || '').trim().slice(0, 80);
  const doCheckin = b.checkin !== false; // на кассе гость обычно сразу заходит
  const src = String(b.src || 'door').slice(0, 32);

  if (!eventId || !Number.isInteger(waveNo)) return fail(res, 400, 'validation', 'Некорректный запрос');
  if (name.length < 2) return fail(res, 400, 'validation', 'Имя гостя — минимум 2 символа', { fields: { name: 'Как зовут гостя?' } });

  const sql = db();
  let created = 0;
  let priceRub = null;
  let oid = null;
  let tid = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    oid = orderId();
    tid = ticketId();
    try {
      const rows = await sql.query(ORDER_SQL, [
        1, eventId, waveNo, oid, name, 'касса', null,
        JSON.stringify({ src }), [tid], [name], ['adult'], 'door', 0, null, true,
      ]);
      const r = rowsOf(rows)[0] || {};
      priceRub = r.price_rub === null ? null : Number(r.price_rub);
      created = Number(r.created || 0);
      break;
    } catch (err) {
      if (/duplicate key/i.test(String(err.message)) && attempt < 2) continue;
      console.error('walkin failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД не ответила — попробуй ещё раз');
    }
  }

  if (priceRub === null || created !== 1) {
    let nextWave = null;
    try {
      const nw = rowsOf(await sql.query(NEXT_WAVE_SQL, [eventId]))[0];
      if (nw) nextWave = { waveNo: Number(nw.wave_no), name: nw.name, priceRub: Number(nw.price_rub), left: Number(nw.left) };
    } catch { /* не критично */ }
    return fail(res, 409, 'wave_sold_out',
      nextWave ? 'Эта волна распродана — выбери следующую' : 'Мест больше нет',
      { next_wave: nextWave });
  }

  let checkedInAt = null;
  if (doCheckin) {
    try {
      const r = rowsOf(await sql.query(CHECKIN_SQL, [tid, null, by]))[0];
      if (r) checkedInAt = new Date(r.checked_in_at).toISOString();
    } catch (e) {
      console.warn('walkin checkin failed:', e.message);
    }
  }

  await notifyOwner(
    `🎟 Касса: ${name} · ${priceRub} ₽${checkedInAt ? ' · впущен' : ''}\nСобытие: ${eventId}\nОформил: ${by}`
  );

  ok(res, {
    order_id: oid,
    price_rub: priceRub,
    checked_in_at: checkedInAt,
    ticket: { id: tid, holder_name: name, url: `/t/${makeToken(tid, primarySecret())}` },
  });
}

// Подтвердить оплату брони: по номеру заказа или по коду брони (как в
// комментарии к переводу). provider: 'transfer' — деньги пришли переводом,
// 'door' — гость заплатил на входе. ticket_id — сразу впустить этого гостя.
async function confirm(req, res, b, by) {
  const sql = db();
  let oid = String(b.order_id || '');
  if (!isOrderId(oid)) {
    const code = normalizePayCode(b.pay_code);
    if (!code) return fail(res, 400, 'validation', 'Нужен номер заказа или код брони вида PX-7F3K');
    const found = rowsOf(await sql.query(`SELECT id FROM orders WHERE pay_code = $1`, [code]))[0];
    if (!found) return fail(res, 404, 'not_found', `Брони с кодом ${code} нет`);
    oid = found.id;
  }
  const provider = b.provider === 'door' ? 'door' : b.provider === 'transfer' ? 'transfer' : null;

  let o;
  try {
    o = rowsOf(await sql.query(CONFIRM_SQL, [oid, by, provider]))[0];
  } catch (err) {
    console.error('confirm failed:', err);
    return fail(res, 503, 'db_unavailable', 'БД не ответила — попробуй ещё раз');
  }
  if (!o) {
    const st = rowsOf(await sql.query(`SELECT status FROM orders WHERE id = $1`, [oid]))[0];
    const status = st ? st.status : 'not_found';
    const why = {
      paid: 'Эта бронь уже оплачена',
      expired: 'Бронь сгорела — оформи гостя заново через кассу',
      cancelled: 'Бронь отменена — оформи гостя заново через кассу',
      not_found: 'Такой брони нет',
    }[status] || 'Бронь нельзя подтвердить';
    return fail(res, 409, 'not_pending', why, { status });
  }
  const tickets = (typeof o.tickets === 'string' ? JSON.parse(o.tickets) : o.tickets) || [];

  // дверь: подтвердил и сразу впустил того, кто стоит перед тобой
  let checkedInAt = null;
  const wanted = String(b.ticket_id || '').toLowerCase();
  if (wanted && tickets.some((t) => t.id === wanted)) {
    try {
      const r = rowsOf(await sql.query(CHECKIN_SQL, [wanted, null, by]))[0];
      if (r) checkedInAt = new Date(r.checked_in_at).toISOString();
    } catch (e) {
      console.warn('confirm checkin failed:', e.message);
    }
  }

  const origin = siteOrigin(req);
  await notifyOwner(
    `✅ Оплата подтверждена: ${o.pay_code || o.id} · ${o.amount_rub} ₽ · ${o.qty} шт. ` +
      `(${provider === 'door' ? 'на входе' : 'перевод'})\n${o.buyer_name}, ${o.buyer_phone}\nПодтвердил: ${by}`
  );
  await deliverTickets(o.tg_chat_id, o, tickets, origin);

  ok(res, {
    order_id: o.id,
    pay_code: o.pay_code,
    amount_rub: Number(o.amount_rub),
    checked_in_at: checkedInAt,
    tickets: tickets.map((t) => ({ id: t.id, holder_name: t.holder_name, url: `/t/${makeToken(t.id, primarySecret())}` })),
  });
}

async function cancel(req, res, b, by) {
  const oid = String(b.order_id || '');
  if (!isOrderId(oid)) return fail(res, 400, 'validation', 'Некорректный номер брони');
  const o = rowsOf(await db().query(CANCEL_SQL, [oid]))[0];
  if (!o) return fail(res, 409, 'not_pending', 'Отменить можно только неоплаченную бронь');
  await notifyOwner(`✖ Бронь ${oid} отменена (${by}) — места возвращены в продажу`);
  await tellGuest(o.tg_chat_id, 'Бронь отменена, места вернулись в продажу. Если это ошибка — напиши нам в директ.');
  ok(res, { order_id: oid, cancelled: true });
}

async function voidTicket(req, res, b, by) {
  const id = String(b.ticket_id || '').toLowerCase();
  if (!/^[0-9a-z]{10}$/.test(id)) return fail(res, 400, 'validation', 'Некорректный номер проходки');
  const status = b.status === 'refunded' ? 'refunded' : 'revoked';
  const note = String(b.note || '').trim().slice(0, 120) || null;
  const t = rowsOf(await db().query(VOID_SQL, [id, status, note ? `${note} (${by})` : by]))[0];
  if (!t) return fail(res, 409, 'not_voidable', 'Проходку нельзя аннулировать: её нет, она уже использована или отозвана');
  await notifyOwner(`🚫 Проходка ${id} (${t.holder_name}) ${status === 'refunded' ? 'возвращена' : 'аннулирована'}${note ? ': ' + note : ''} — ${by}`);
  ok(res, { ticket_id: id, status });
}

async function rename(req, res, b, by) {
  const id = String(b.ticket_id || '').toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  if (!/^[0-9a-z]{10}$/.test(id)) return fail(res, 400, 'validation', 'Некорректный номер проходки');
  if (name.length < 2) return fail(res, 400, 'validation', 'Имя — минимум 2 символа');
  const t = rowsOf(await db().query(RENAME_SQL, [id, name]))[0];
  if (!t) return fail(res, 409, 'not_editable', 'Переоформить нельзя: проходка использована или отозвана');
  await notifyOwner(`✏️ Проходка ${id} переоформлена на ${name} — ${by}`);
  ok(res, { ticket_id: id, holder_name: t.holder_name });
}
