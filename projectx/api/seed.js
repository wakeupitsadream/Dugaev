// Идемпотентная инициализация БД: применяет DDL и upsert-ит афишу из
// assets/data/events.js. Защищено ADMIN_KEY.
// body: { demoSold: true }    — проставить волнам демо-продажи (показ демо);
// body: { cleanupTest: true } — удалить данные боевого самотеста
//   (заказы с телефоном +70000000000) и вернуть квоты волн.
import { SCHEMA } from '../db/schema.js';
import { EVENTS } from '../assets/data/events.js';
import { demoWaves } from '../assets/waves.js';
import { db, hasDb } from './_lib/db.js';
import { isAdmin } from './_lib/auth.js';
import { paymentMode, TEST_PHONE } from './_lib/booking.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'DATABASE_URL не настроен');

  const sql = db();

  // уборка после боевого самотеста: только тестовый телефон, ничего больше
  if (req.body && req.body.cleanupTest) {
    try {
      const rows = await sql.query(CLEANUP_TEST_SQL);
      return ok(res, { cleaned: (rows.rows || rows).length });
    } catch (err) {
      console.error('cleanupTest failed:', err);
      return fail(res, 500, 'cleanup_failed', 'Не удалось убрать тестовые данные');
    }
  }

  // выдуманные продажи — только на демо-стенде: в боевом режиме галочка игнорируется
  const demoSold = Boolean(req.body && req.body.demoSold) && paymentMode() === 'demo';
  try {
    for (const stmt of SCHEMA) await sql.query(stmt);

    for (const e of EVENTS) {
      await sql.query(
        `INSERT INTO events (id, brand, title, city, venue, address, starts_at, ends_at, age_rating, status, poster_url, descr, lineup, secret, capacity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
           poster_url=COALESCE(EXCLUDED.poster_url, events.poster_url),
           lineup=EXCLUDED.lineup,
           capacity=COALESCE(events.capacity, EXCLUDED.capacity)`,
        [e.id, e.brand, e.title, e.city, e.venue, e.address || null, e.startsAt, e.endsAt || null,
         e.ageRating, e.status, e.posterUrl || null, e.descr || null, JSON.stringify(e.lineup || []),
         Boolean(e.secret), e.capacity || null]
      );
      for (const w of e.waves) {
        await sql.query(
          `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (event_id, wave_no) DO NOTHING`,
          [e.id, w.waveNo, w.name, w.priceRub, w.quota, w.public !== false]
        );
      }
      if (demoSold && e.status === 'onsale') {
        for (const w of demoWaves(e, Date.now())) {
          await sql.query(
            `UPDATE price_waves SET sold = LEAST(quota, $3) WHERE event_id = $1 AND wave_no = $2`,
            [e.id, w.waveNo, w.sold]
          );
        }
      }
    }
    ok(res, { seeded: EVENTS.length, demoSold });
  } catch (err) {
    console.error('seed failed:', err);
    fail(res, 500, 'seed_failed', 'Не удалось применить схему/данные');
  }
}

// Телефон, которым помечаются заказы самотеста (см. admin.html)
export { TEST_PHONE };

// Один атомарный стейтмент: вернуть квоты волн, снести сканы, билеты и
// заказы самотеста. Чужие данные не трогаются по определению WHERE.
export const CLEANUP_TEST_SQL = `
WITH doomed AS (
  SELECT id, wave_id, qty, status FROM orders WHERE buyer_phone = '${TEST_PHONE}'
),
dec AS (
  UPDATE price_waves w SET sold = GREATEST(0, w.sold - d.total)
  FROM (SELECT o.wave_id, count(t.id)::int AS total
        FROM doomed o JOIN tickets t ON t.order_id = o.id
        WHERE t.status IN ('active', 'reserved')
        GROUP BY o.wave_id) d
  WHERE w.id = d.wave_id
  RETURNING w.id
),
del_links AS (
  DELETE FROM tg_links WHERE order_id IN (SELECT id FROM doomed)
),
del_scan AS (
  DELETE FROM scan_log WHERE ticket_id IN (
    SELECT t.id FROM tickets t WHERE t.order_id IN (SELECT id FROM doomed)
  )
),
del_tickets AS (
  DELETE FROM tickets WHERE order_id IN (SELECT id FROM doomed)
)
DELETE FROM orders WHERE id IN (SELECT id FROM doomed)
RETURNING id`;
