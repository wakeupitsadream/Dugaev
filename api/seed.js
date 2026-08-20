// Идемпотентная инициализация БД: применяет DDL и upsert-ит афишу из
// assets/data/events.js. Защищено ADMIN_KEY. body: { demoSold: true } —
// проставить волнам демо-продажи (лестница FOMO для показа демо).
import { SCHEMA } from '../db/schema.js';
import { EVENTS } from '../assets/data/events.js';
import { demoWaves } from '../assets/waves.js';
import { db, hasDb } from './_lib/db.js';
import { isAdmin } from './_lib/auth.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'DATABASE_URL не настроен');

  const demoSold = Boolean(req.body && req.body.demoSold);
  const sql = db();
  try {
    for (const stmt of SCHEMA) await sql.query(stmt);

    for (const e of EVENTS) {
      await sql.query(
        `INSERT INTO events (id, brand, title, city, venue, address, starts_at, ends_at, age_rating, status, poster_url, descr, lineup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           brand=EXCLUDED.brand, title=EXCLUDED.title, city=EXCLUDED.city,
           venue=EXCLUDED.venue, address=EXCLUDED.address, starts_at=EXCLUDED.starts_at,
           ends_at=EXCLUDED.ends_at, age_rating=EXCLUDED.age_rating, status=EXCLUDED.status,
           poster_url=EXCLUDED.poster_url, descr=EXCLUDED.descr, lineup=EXCLUDED.lineup`,
        [e.id, e.brand, e.title, e.city, e.venue, e.address || null, e.startsAt, e.endsAt || null,
         e.ageRating, e.status, e.posterUrl || null, e.descr || null, JSON.stringify(e.lineup || [])]
      );
      for (const w of e.waves) {
        await sql.query(
          `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (event_id, wave_no) DO UPDATE SET
             name=EXCLUDED.name, price_rub=EXCLUDED.price_rub, quota=EXCLUDED.quota`,
          [e.id, w.waveNo, w.name, w.priceRub, w.quota]
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
