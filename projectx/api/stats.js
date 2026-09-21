// Агрегаты для админки и TG-бота владельца (X-Admin-Key ИЛИ X-Bot-Token).
// ?event_id=... — разрез по ивенту; без него — сводка по всем.
// ?list=1 — приложить список билетов (офлайн-список для двери).
// ?include_drafts=1 — показать в сводке и черновики (нужно разделу
//   «События» в админке: созданный черновик иначе исчезал бы из UI).
// Ключ двери (DOOR_KEY) открывает только офлайн-список конкретной ночи
// (?event_id=...&list=1) — без выручки и статистики.
// v6: pending — ожидающие подтверждения брони (сгоревшие сначала списываются),
//     sources — продажи по меткам источников.
import { isAdmin, isBot, roleOf } from './_lib/auth.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { EXPIRE_SQL, PENDING_SQL, SOURCES_SQL } from './_lib/queries.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'GET')) return;
  const admin = isAdmin(req) || isBot(req);
  const door = !admin && roleOf(req) === 'door';
  if (!admin && !door) return fail(res, 403, 'forbidden', 'Нужен админ-ключ или токен бота');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');

  const sql = db();
  const eventId = String(req.query.event_id || '');
  const includeDrafts = String(req.query.include_drafts || '') === '1';

  if (door) {
    // дверь: только список гостей ночи для офлайн-режима сканера
    if (!eventId || req.query.list !== '1') return fail(res, 403, 'forbidden', 'Ключ двери открывает только список гостей');
    try {
      const ev = (await sql.query(`SELECT id, title, starts_at FROM events WHERE id = $1`, [eventId]));
      const e = (ev.rows || ev)[0];
      if (!e) return fail(res, 404, 'not_found', 'Ночь не найдена');
      const rows = await sql.query(
        `SELECT id, holder_name, age_cat, status, checked_in_at FROM tickets WHERE event_id = $1 ORDER BY holder_name`,
        [eventId]
      );
      return ok(res, {
        event_id: eventId,
        title: e.title,
        starts_at: new Date(e.starts_at).toISOString(),
        tickets: (rows.rows || rows).map((t) => ({
          id: t.id, holder_name: t.holder_name, age_cat: t.age_cat, status: t.status,
          checked_in_at: t.checked_in_at ? new Date(t.checked_in_at).toISOString() : null,
        })),
      });
    } catch (err) {
      console.warn('stats(door) failed:', err.message);
      return fail(res, 503, 'db_unavailable', 'БД недоступна');
    }
  }

  try {
    if (!eventId) {
      const rows = await withTimeout(sql.query(
        `SELECT e.id, e.title, e.city, e.starts_at, e.status, e.age_rating,
                count(t.id) FILTER (WHERE t.status = 'active')::int AS sold,
                count(t.id) FILTER (WHERE t.status = 'reserved')::int AS reserved,
                count(t.id) FILTER (WHERE t.checked_in_at IS NOT NULL)::int AS checked_in,
                coalesce((SELECT sum(o.amount_rub) FROM orders o
                          WHERE o.event_id = e.id AND o.status = 'paid'), 0)::int AS revenue_rub
         FROM events e
         LEFT JOIN tickets t ON t.event_id = e.id
         WHERE ($1::bool OR e.status <> 'draft')
         GROUP BY e.id ORDER BY e.starts_at`,
        [includeDrafts]
      ), 6000);
      return ok(res, { events: (rows.rows || rows) });
    }

    // сгоревшие брони списываются перед подсчётом — иначе «ожидают» врут
    try { await sql.query(EXPIRE_SQL); } catch { /* не критично для сводки */ }

    const [summary, byWave, curve, scans, byDay, byProvider, pending, sources, evRow] = await Promise.all([
      sql.query(
        `SELECT count(t.id) FILTER (WHERE t.status IN ('active'))::int AS sold,
                count(t.id) FILTER (WHERE t.status = 'reserved')::int AS reserved,
                count(t.id) FILTER (WHERE t.checked_in_at IS NOT NULL)::int AS checked_in,
                count(t.id) FILTER (WHERE t.age_cat = 'minor' AND t.status = 'active')::int AS minors,
                coalesce((SELECT sum(o.amount_rub) FROM orders o
                          WHERE o.event_id = $1 AND o.status = 'paid'), 0)::int AS revenue_rub,
                coalesce((SELECT sum(o.amount_rub) FROM orders o
                          WHERE o.event_id = $1 AND o.status = 'pending'), 0)::int AS pending_rub
         FROM tickets t WHERE t.event_id = $1`,
        [eventId]
      ),
      sql.query(
        `SELECT wave_no, name, price_rub, quota, sold, public FROM price_waves
         WHERE event_id = $1 ORDER BY wave_no`,
        [eventId]
      ),
      sql.query(
        `SELECT to_timestamp(floor(extract(epoch FROM checked_in_at) / 600) * 600) AS t,
                count(*)::int AS n
         FROM tickets WHERE event_id = $1 AND checked_in_at IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        [eventId]
      ),
      sql.query(
        `SELECT s.result, s.scanned_by, s.at, t.holder_name
         FROM scan_log s LEFT JOIN tickets t ON t.id = s.ticket_id
         WHERE t.event_id = $1 OR s.ticket_id IS NULL
         ORDER BY s.at DESC LIMIT 25`,
        [eventId]
      ),
      sql.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d,
                sum(qty)::int AS n, sum(amount_rub)::int AS rub
         FROM orders
         WHERE event_id = $1 AND status = 'paid' AND created_at > now() - interval '14 days'
         GROUP BY 1 ORDER BY 1`,
        [eventId]
      ),
      sql.query(
        `SELECT provider, count(*)::int AS orders, sum(qty)::int AS n, sum(amount_rub)::int AS rub
         FROM orders WHERE event_id = $1 AND status = 'paid'
         GROUP BY provider`,
        [eventId]
      ),
      sql.query(PENDING_SQL, [eventId]),
      sql.query(SOURCES_SQL, [eventId]),
      sql.query(`SELECT title, starts_at, capacity, secret, address, venue FROM events WHERE id = $1`, [eventId]),
    ]);

    const ev = (evRow.rows || evRow)[0] || {};
    const out = {
      event_id: eventId,
      title: ev.title || null,
      capacity: ev.capacity == null ? null : Number(ev.capacity),
      secret: Boolean(ev.secret),
      ...((summary.rows || summary)[0] || {}),
      by_wave: (byWave.rows || byWave),
      pending: (pending.rows || pending).map((o) => ({
        id: o.id,
        pay_code: o.pay_code,
        buyer_name: o.buyer_name,
        buyer_phone: o.buyer_phone,
        buyer_tg: o.buyer_tg,
        qty: Number(o.qty),
        amount_rub: Number(o.amount_rub),
        created_at: new Date(o.created_at).toISOString(),
        expires_at: o.expires_at ? new Date(o.expires_at).toISOString() : null,
        claimed_at: o.claimed_at ? new Date(o.claimed_at).toISOString() : null,
        tg: Boolean(o.tg),
        tickets: (typeof o.tickets === 'string' ? JSON.parse(o.tickets) : o.tickets) || [],
      })),
      sources: (sources.rows || sources).map((r) => ({
        src: r.src, paid: Number(r.paid), pending: Number(r.pending), rub: Number(r.rub),
      })),
      checkin_curve: (curve.rows || curve).map((c) => ({
        t: new Date(c.t).toISOString(),
        n: Number(c.n),
      })),
      sales_by_day: (byDay.rows || byDay).map((r) => ({ d: r.d, n: Number(r.n), rub: Number(r.rub) })),
      by_provider: (byProvider.rows || byProvider).map((r) => ({
        provider: r.provider, orders: Number(r.orders), n: Number(r.n), rub: Number(r.rub),
      })),
      last_scans: (scans.rows || scans).map((s) => ({
        result: s.result,
        by: s.scanned_by,
        at: new Date(s.at).toISOString(),
        holder: s.holder_name,
      })),
    };

    // ?orders=1 — оплаченные заказы ночи: продавец выбивает по ним чеки
    // в «Мой налог» (панель отдаёт CSV), бухгалтерия сверяет с выпиской
    if (req.query.orders === '1') {
      const rows = await sql.query(
        `SELECT o.id, o.pay_code, o.qty, o.amount_rub, o.buyer_name, o.buyer_phone, o.provider,
                o.confirmed_by, o.paid_at, o.created_at, o.utm
         FROM orders o WHERE o.event_id = $1 AND o.status = 'paid' ORDER BY o.paid_at, o.created_at`,
        [eventId]
      );
      out.orders = (rows.rows || rows).map((o) => {
        const utm = typeof o.utm === 'string' ? JSON.parse(o.utm) : (o.utm || {});
        return {
          id: o.id,
          pay_code: o.pay_code,
          qty: Number(o.qty),
          amount_rub: Number(o.amount_rub),
          buyer_name: o.buyer_name,
          buyer_phone: o.buyer_phone,
          provider: o.provider,
          confirmed_by: o.confirmed_by,
          paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null,
          created_at: new Date(o.created_at).toISOString(),
          src: utm && utm.src ? String(utm.src) : '',
        };
      });
    }
    if (req.query.list === '1') {
      const rows = await sql.query(
        `SELECT id, holder_name, age_cat, status, checked_in_at
         FROM tickets WHERE event_id = $1 ORDER BY holder_name`,
        [eventId]
      );
      out.tickets = (rows.rows || rows).map((t) => ({
        id: t.id,
        holder_name: t.holder_name,
        age_cat: t.age_cat,
        status: t.status,
        checked_in_at: t.checked_in_at ? new Date(t.checked_in_at).toISOString() : null,
      }));
    }
    return ok(res, out);
  } catch (err) {
    console.warn('stats failed:', err.message);
    return fail(res, 503, 'db_unavailable', 'БД недоступна');
  }
}
