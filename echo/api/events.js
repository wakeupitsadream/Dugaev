// Публичная афиша: события + волны с остатками. При недоступной БД молча
// отдаёт сид с детерминированной демо-симуляцией — гость ошибок не видит.
import { EVENTS } from '../assets/data/events.js';
import { demoWaves } from '../assets/waves.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;

  if (hasDb()) {
    try {
      const rows = await withTimeout(db().query(
        `SELECT e.id, e.brand, e.title, e.city, e.venue, e.address,
                e.starts_at, e.ends_at, e.age_rating, e.status, e.poster_url, e.descr, e.lineup,
                coalesce(
                  json_agg(json_build_object(
                    'waveNo', w.wave_no, 'name', w.name,
                    'priceRub', w.price_rub, 'quota', w.quota, 'sold', w.sold
                  ) ORDER BY w.wave_no) FILTER (WHERE w.id IS NOT NULL),
                  '[]'
                ) AS waves
         FROM events e
         LEFT JOIN price_waves w ON w.event_id = e.id
         WHERE e.status IN ('onsale', 'soldout', 'past')
         GROUP BY e.id
         ORDER BY e.starts_at`
      ), 4000);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
      return ok(res, { events: rows.rows ? rows.rows.map(mapRow) : rows.map(mapRow) });
    } catch (err) {
      console.warn('events: БД недоступна, отдаю сид:', err.message);
    }
  }
  res.setHeader('Cache-Control', 's-maxage=30');
  ok(res, {
    degraded: true,
    events: EVENTS.map((e) => ({ ...e, waves: demoWaves(e, Date.now()) })),
  });
}

function mapRow(r) {
  return {
    id: r.id,
    brand: r.brand,
    title: r.title,
    city: r.city,
    venue: r.venue,
    address: r.address,
    startsAt: toIso(r.starts_at),
    endsAt: toIso(r.ends_at),
    ageRating: Number(r.age_rating),
    status: r.status,
    posterUrl: r.poster_url,
    descr: r.descr,
    lineup: Array.isArray(r.lineup) ? r.lineup : [],
    waves: (r.waves || []).map((w) => ({
      waveNo: Number(w.waveNo),
      name: w.name,
      priceRub: Number(w.priceRub),
      quota: Number(w.quota),
      sold: Number(w.sold),
    })),
  };
}

function toIso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}
