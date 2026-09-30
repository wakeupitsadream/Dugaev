// Публичная афиша: события + волны с остатками. При недоступной БД молча
// отдаёт сид с детерминированной демо-симуляцией — гость ошибок не видит.
import { EVENTS } from '../assets/data/events.js';
import { demoWaves } from '../assets/waves.js';
import { addressIsPublic, publicRevealAt } from '../assets/secret-place.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, onlyMethod } from './_lib/respond.js';
import { EXPIRE_SQL } from './_lib/queries.js';
import { paymentMode } from './_lib/booking.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;

  if (hasDb()) {
    try {
      // сгоревшие брони возвращают места до того, как афиша покажет остатки:
      // иначе «всё продано» висело бы до следующего заказа или открытия панели
      try { await withTimeout(db().query(EXPIRE_SQL), 2000); } catch { /* не критично для афиши */ }
      const rows = await withTimeout(db().query(
        `SELECT e.id, e.brand, e.title, e.city, e.venue, e.address, e.secret, e.capacity,
                e.starts_at, e.ends_at, e.age_rating, e.status, e.poster_url, e.descr, e.lineup,
                coalesce(
                  json_agg(json_build_object(
                    'waveNo', w.wave_no, 'name', w.name,
                    'priceRub', w.price_rub, 'quota', w.quota, 'sold', w.sold
                  ) ORDER BY w.wave_no) FILTER (WHERE w.id IS NOT NULL AND w.public),
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
    events: EVENTS.map((e) => ({
      ...e,
      address: !e.secret || addressIsPublic(e) ? e.address : null,
      addressPublicAt: e.secret ? publicRevealAt(e.startsAt) : null,
      // боевой режим: при недоступной БД остатки не выдумываем — sold = 0
      waves: paymentMode() === 'demo'
        ? demoWaves({ ...e, waves: e.waves.filter((w) => w.public !== false) }, Date.now())
        : e.waves.filter((w) => w.public !== false).map((w) => ({ waveNo: w.waveNo, name: w.name, priceRub: w.priceRub, quota: w.quota, sold: 0 })),
    })),
  });
}

function mapRow(r) {
  return {
    id: r.id,
    brand: r.brand,
    title: r.title,
    city: r.city,
    venue: r.venue,
    // SECRET PLACE (флаг secret у ночи): адрес уходит в публичную афишу только
    // за сутки до старта. Купившим он виден сразу — через /api/ticket по
    // подписанному токену. Открытая ночь показывает адрес всем и сразу.
    address: !r.secret || addressIsPublic({ startsAt: r.starts_at, status: r.status }) ? r.address : null,
    addressPublicAt: r.secret ? publicRevealAt(r.starts_at) : null,
    secret: Boolean(r.secret),
    capacity: r.capacity == null ? null : Number(r.capacity),
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
