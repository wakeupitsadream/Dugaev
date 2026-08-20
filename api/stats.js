// Агрегаты для админки и TG-бота владельца (X-Admin-Key ИЛИ X-Bot-Token).
// ?event_id=... — разрез по ивенту; без него — сводка по всем.
// ?list=1 — приложить список билетов (офлайн-список для двери).
import { isAdmin, isBot } from './_lib/auth.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'GET')) return;
  if (!isAdmin(req) && !isBot(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ или токен бота');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');

  const sql = db();
  const eventId = String(req.query.event_id || '');

  try {
    if (!eventId) {
      const rows = await withTimeout(sql.query(
        `SELECT e.id, e.title, e.city, e.starts_at, e.status, e.age_rating,
                count(t.id) FILTER (WHERE t.status <> 'refunded')::int AS sold,
                count(t.id) FILTER (WHERE t.checked_in_at IS NOT NULL)::int AS checked_in,
                coalesce((SELECT sum(o.amount_rub) FROM orders o
                          WHERE o.event_id = e.id AND o.status = 'paid'), 0)::int AS revenue_rub
         FROM events e
         LEFT JOIN tickets t ON t.event_id = e.id
         WHERE e.status <> 'draft'
         GROUP BY e.id ORDER BY e.starts_at`
      ), 6000);
      return ok(res, { events: (rows.rows || rows) });
    }

    const [summary, byWave, curve, scans] = await Promise.all([
      sql.query(
        `SELECT count(t.id) FILTER (WHERE t.status <> 'refunded')::int AS sold,
                count(t.id) FILTER (WHERE t.checked_in_at IS NOT NULL)::int AS checked_in,
                count(t.id) FILTER (WHERE t.age_cat = 'minor' AND t.status <> 'refunded')::int AS minors,
                coalesce((SELECT sum(o.amount_rub) FROM orders o
                          WHERE o.event_id = $1 AND o.status = 'paid'), 0)::int AS revenue_rub
         FROM tickets t WHERE t.event_id = $1`,
        [eventId]
      ),
      sql.query(
        `SELECT wave_no, name, price_rub, quota, sold FROM price_waves
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
    ]);

    const out = {
      event_id: eventId,
      ...((summary.rows || summary)[0] || {}),
      by_wave: (byWave.rows || byWave),
      checkin_curve: (curve.rows || curve).map((c) => ({
        t: new Date(c.t).toISOString(),
        n: Number(c.n),
      })),
      last_scans: (scans.rows || scans).map((s) => ({
        result: s.result,
        by: s.scanned_by,
        at: new Date(s.at).toISOString(),
        holder: s.holder_name,
      })),
    };

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
