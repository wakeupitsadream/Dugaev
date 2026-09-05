// Афиша из админки: создать/отредактировать событие и его волны цен.
// У PROJECT X нет Telegram-канала, поэтому источник афиши — эта форма,
// а не TG-конвейер. Защищено ADMIN_KEY.
//
// GET  /api/event-upsert            → список событий ВКЛЮЧАЯ черновики
//   (обычная /api/events их прячет — иначе черновик пропадал бы навсегда)
// POST /api/event-upsert  body: { id?, title, date, timeStart, timeEnd,
//   ageRating, venue, address?, descr?, status, waves: [{waveNo,name,priceRub,quota}] }
//
// Инварианты: цену/квоту читает и пишет только сервер; id существующего
// события не меняется (иначе оборвутся выданные QR); квота не опускается
// ниже проданного; волна с продажами не удаляется.
import { db, hasDb } from './_lib/db.js';
import { isAdmin } from './_lib/auth.js';
import { ok, fail, noStore } from './_lib/respond.js';
import { parseEventForm } from './_lib/event-form.js';
import {
  EVENT_UPSERT_SQL,
  WAVE_UPSERT_SQL,
  WAVES_PRUNE_SQL,
  ADMIN_EVENTS_SQL,
} from './_lib/queries.js';

const rowsOf = (r) => r.rows || r;

export default async function handler(req, res) {
  noStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается');
  }
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'DATABASE_URL не настроен');

  const sql = db();

  if (req.method === 'GET') {
    try {
      const rows = rowsOf(await sql.query(ADMIN_EVENTS_SQL));
      return ok(res, {
        events: rows.map((r) => ({
          id: r.id,
          title: r.title,
          city: r.city,
          venue: r.venue,
          address: r.address,
          startsAt: new Date(r.starts_at).toISOString(),
          endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
          ageRating: Number(r.age_rating),
          status: r.status,
          descr: r.descr,
          waves: typeof r.waves === 'string' ? JSON.parse(r.waves) : r.waves,
        })),
      });
    } catch (err) {
      console.error('event list failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД недоступна');
    }
  }

  // ---- POST: сохранение ----
  const wantedId = String(req.body?.id || '').trim();
  let existing = null;
  if (wantedId) {
    try {
      const evRows = rowsOf(await sql.query(`SELECT id FROM events WHERE id = $1`, [wantedId]));
      if (!evRows.length) return fail(res, 404, 'not_found', 'Такого события нет');
      const wRows = rowsOf(
        await sql.query(`SELECT wave_no, sold FROM price_waves WHERE event_id = $1`, [wantedId])
      );
      existing = { id: wantedId, waves: wRows.map((w) => ({ waveNo: Number(w.wave_no), sold: Number(w.sold) })) };
    } catch (err) {
      console.error('event load failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД недоступна');
    }
  }

  const parsed = parseEventForm(req.body, { nowMs: Date.now(), existing });
  if (!parsed.ok) {
    return fail(res, 400, 'validation', parsed.errors[0].message, { fields: parsed.errors });
  }
  const { event: e, waves, prune, warnings } = parsed;

  try {
    await sql.query(EVENT_UPSERT_SQL, [
      e.id, e.brand, e.title, e.city, e.venue, e.address, e.startsAt, e.endsAt,
      e.ageRating, e.status, null, e.descr, null,
    ]);
    const saved = [];
    for (const w of waves) {
      const r = rowsOf(await sql.query(WAVE_UPSERT_SQL, [e.id, w.waveNo, w.name, w.priceRub, w.quota]));
      const row = r[0];
      if (row) saved.push({ waveNo: Number(row.wave_no), quota: Number(row.quota), sold: Number(row.sold) });
    }
    if (prune.length) {
      await sql.query(WAVES_PRUNE_SQL, [e.id, waves.map((w) => w.waveNo)]);
    }
    return ok(res, {
      event_id: e.id,
      created: !existing,
      status: e.status,
      waves: saved,
      warnings,
    });
  } catch (err) {
    console.error('event upsert failed:', err);
    return fail(res, 500, 'upsert_failed', 'Не удалось сохранить событие');
  }
}
