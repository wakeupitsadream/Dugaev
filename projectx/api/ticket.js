// Данные гостевого билета. Право видеть билет = владение полным подписанным
// токеном. Неверная подпись и несуществующий id неразличимы снаружи
// (нейтральный not_found — от перебора).
import { verifyToken, ticketSecrets } from './_lib/sign.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { addressIsPublic } from '../assets/secret-place.js';
import { tgBotUsername } from './_lib/tg.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'GET')) return;

  const v = verifyToken(String(req.query.token || ''), ticketSecrets());
  if (!v.valid) return fail(res, 404, 'not_found', 'Билет не найден');

  if (!hasDb()) {
    // подпись подлинная, но статус недоступен — страница возьмёт свой кэш
    return ok(res, { degraded: true, ticket: null });
  }

  try {
    const rows = await withTimeout(db().query(
      `SELECT t.id, t.holder_name, t.age_cat, t.status, t.checked_in_at, t.note,
              o.id AS order_id, o.status AS order_status, o.pay_code, o.amount_rub, o.qty,
              o.expires_at, o.claimed_at, o.tg_chat_id,
              w.name AS wave_name,
              e.id AS event_id, e.title, e.city, e.venue, e.address, e.secret,
              e.starts_at, e.age_rating
       FROM tickets t
       JOIN orders o ON o.id = t.order_id
       JOIN price_waves w ON w.id = o.wave_id
       JOIN events e ON e.id = t.event_id
       WHERE t.id = $1`,
      [v.id]
    ), 4000);
    const r = (rows.rows || rows)[0];
    if (!r) return fail(res, 404, 'not_found', 'Билет не найден');
    // SECRET PLACE: адрес — привилегия купившего. Неоплаченная бронь секретной
    // ночи адреса ещё не видит; открытая ночь показывает его всем.
    const paid = r.status !== 'reserved';
    const showAddress = !r.secret || paid || addressIsPublic({ startsAt: r.starts_at, status: 'onsale' });
    return ok(res, {
      bot: tgBotUsername(),
      ticket: {
        id: r.id,
        holderName: r.holder_name,
        ageCat: r.age_cat,
        status: r.status,
        note: r.note || null,
        checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
        waveName: r.wave_name,
        order: {
          id: r.order_id,
          status: r.order_status,
          payCode: r.pay_code,
          amountRub: Number(r.amount_rub),
          qty: Number(r.qty),
          expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
          claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
          tgLinked: Boolean(r.tg_chat_id),
        },
        event: {
          id: r.event_id,
          title: r.title,
          city: r.city,
          venue: r.venue,
          address: showAddress ? r.address : null,
          secret: Boolean(r.secret),
          startsAt: new Date(r.starts_at).toISOString(),
          ageRating: Number(r.age_rating),
        },
      },
    });
  } catch (err) {
    console.warn('ticket: БД недоступна:', err.message);
    return ok(res, { degraded: true, ticket: null });
  }
}
