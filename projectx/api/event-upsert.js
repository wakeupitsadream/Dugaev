// Мероприятия из панели. Защищено ADMIN_KEY.
//
// GET  /api/event-upsert → { events (включая черновики), ai, subs }
//   ai — подключён ли ИИ для разбора постов, subs — подписчиков анонсов в боте
// POST /api/event-upsert
//   { action: 'analyze', text }   → черновик формы из текста поста
//   { action: 'delete', id }      → удалить мероприятие без броней
//   { action: 'early', id, qty, price } → ранний доступ для подписчиков бота:
//     закрытая волна, ночь в статусе 'early'; превью рассылки — владельцу в Telegram
//   { id?, title, date, timeStart, timeEnd, ageRating, status, venue,
//     address?, secret?, descr?, capacity?, posterUrl?, lineup?, program?,
//     waves: [{waveNo,name,priceRub,quota,public?}] } → сохранить
//
// Инварианты: цену/квоту читает и пишет только сервер; id существующего
// события не меняется (иначе оборвутся выданные QR); квота не опускается
// ниже проданного; волна с продажами не удаляется.
import { db, hasDb, ensureSchema, withTimeout } from './_lib/db.js';
import { isAdmin } from './_lib/auth.js';
import { ok, fail, noStore } from './_lib/respond.js';
import { parseEventForm } from './_lib/event-form.js';
import { ADMIN_EVENTS_SQL } from './_lib/queries.js';
import { loadExisting, saveEvent, deleteEvent, publishCheck, openEarly } from './_lib/event-store.js';
import { analyzePost } from './_lib/analyze.js';
import { extractorAvailable } from './_lib/extract.js';
import { notifyOwner, tgApi, tgCall } from './_lib/tg.js';
import { siteOrigin } from './_lib/booking.js';
import { subsCount, publishedNotice, sendPreview } from './_lib/broadcast.js';

const rowsOf = (r) => r.rows || r;
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export default async function handler(req, res) {
  noStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается');
  }
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');

  const action = req.method === 'POST' ? String(req.body?.action || 'save') : 'list';
  // разбор поста работает и без базы: правила — чистая функция
  if (action === 'analyze') return analyze(req, res);
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'DATABASE_URL не настроен');

  const sql = db();
  try {
    await ensureSchema(sql); // колонки программы и таблица афиш появились после первого «Инициализировать БД»
  } catch { /* ensureSchema сам глушит ошибки по стейтментам */ }

  if (action === 'list') return list(res, sql);
  if (action === 'delete') return remove(req, res, sql);
  if (action === 'early') return early(req, res, sql);
  if (action === 'check') {
    const r = await publishCheck(sql, String(req.body?.id || ''));
    return r.ok ? ok(res, {}) : fail(res, 409, 'not_publishable', r.message);
  }
  return save(req, res, sql);
}

async function list(res, sql) {
  try {
    const rows = rowsOf(await withTimeout(sql.query(ADMIN_EVENTS_SQL), 8000));
    let subs = 0;
    try {
      subs = Number(rowsOf(await sql.query(`SELECT count(*)::int AS n FROM tg_subs WHERE active`))[0]?.n || 0);
    } catch { /* таблицы ещё нет — подписчиков ноль */ }
    return ok(res, {
      ai: extractorAvailable(),
      subs,
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
        secret: Boolean(r.secret),
        capacity: r.capacity == null ? null : Number(r.capacity),
        posterUrl: r.poster_url || null,
        lineup: json(r.lineup) || [],
        program: json(r.program) || [],
        pending: Number(r.pending || 0),
        revenue: Number(r.revenue || 0),
        waves: json(r.waves) || [],
      })),
    });
  } catch (err) {
    console.error('event list failed:', err);
    return fail(res, 503, 'db_unavailable', 'БД недоступна');
  }
}

async function analyze(req, res) {
  const text = String(req.body?.text || '').slice(0, 5000);
  if (text.trim().length < 10) return fail(res, 400, 'validation', 'Вставь текст поста — хотя бы пару строк');
  let known = [];
  if (hasDb()) {
    try {
      const rows = rowsOf(await withTimeout(db().query(
        `SELECT id, title, starts_at FROM events WHERE status IN ('onsale','draft') ORDER BY starts_at LIMIT 20`
      ), 3000));
      known = rows.map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at }));
    } catch { /* не критично */ }
  }
  const r = await analyzePost(text, { nowMs: Date.now(), known });
  return ok(res, { draft: r.draft, found: r.found, notes: r.notes, engine: r.engine, ai_failed: Boolean(r.aiFailed) });
}

async function remove(req, res, sql) {
  const id = String(req.body?.id || '').trim();
  if (!id) return fail(res, 400, 'validation', 'Нужен id мероприятия');
  try {
    const r = await deleteEvent(sql, id);
    return r.ok ? ok(res, { deleted: id }) : fail(res, 409, 'not_deletable', r.message);
  } catch (err) {
    console.error('event delete failed:', err);
    return fail(res, 503, 'db_unavailable', 'БД недоступна');
  }
}

async function save(req, res, sql) {
  const wantedId = String(req.body?.id || '').trim();
  let existing = null;
  if (wantedId) {
    try {
      existing = await loadExisting(sql, wantedId);
      if (!existing) return fail(res, 404, 'not_found', 'Такого события нет');
    } catch (err) {
      console.error('event load failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД недоступна');
    }
  }

  const parsed = parseEventForm(req.body, { nowMs: Date.now(), existing });
  if (!parsed.ok) {
    return fail(res, 400, 'validation', parsed.errors[0].message, { fields: parsed.errors });
  }
  const e = parsed.event;

  // новое событие с таким же названием и датой уже есть — не затираем его молча
  if (!existing) {
    try {
      const dup = rowsOf(await sql.query(`SELECT id FROM events WHERE id = $1`, [e.id]));
      if (dup.length) return fail(res, 409, 'exists', `Событие ${e.id} уже есть — выбери его в списке и поправь`, { event_id: e.id });
    } catch (err) {
      console.error('event dup check failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД недоступна');
    }
  }

  try {
    const r = await saveEvent(sql, parsed);
    const published = e.status === 'onsale' && (!existing || existing.status !== 'onsale');
    // опубликовали из панели — владельцу в Telegram то же, что после кнопки
    // в боте: ссылка и предложение разослать анонс подписчикам
    let notified = false;
    if (published) {
      try {
        const notice = publishedNotice(siteOrigin(req), e.id, e.title, await subsCount(sql));
        notified = Boolean(await notifyOwner(notice.text, notice.markup));
      } catch (err) {
        console.warn('publish notice failed:', err.message);
      }
    }
    return ok(res, {
      event_id: e.id,
      created: !existing,
      status: e.status,
      published,
      notified,
      waves: r.waves,
      warnings: r.warnings,
    });
  } catch (err) {
    console.error('event upsert failed:', err);
    return fail(res, 500, 'upsert_failed', 'Не удалось сохранить событие');
  }
}

async function early(req, res, sql) {
  const id = String(req.body?.id || '').trim();
  const qty = Number(req.body?.qty);
  const price = Number(req.body?.price);
  if (!id) return fail(res, 400, 'validation', 'Нужен id мероприятия');
  try {
    const r = await openEarly(sql, id, qty, price, Date.now());
    if (!r.ok) return fail(res, 409, 'not_allowed', r.message);
    // превью рассылки — владельцу в бот: отправить сейчас или по времени — оттуда
    let previewed = false;
    const owner = process.env.TELEGRAM_CHAT_ID;
    if (owner && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const p = await sendPreview({ sql, tg: tgApi, call: tgCall, nowMs: Date.now(), origin: siteOrigin(req) }, owner, id, 'early');
        previewed = Boolean(p.ok);
      } catch (err) {
        console.warn('early preview failed:', err.message);
      }
    }
    return ok(res, { event_id: id, status: 'early', previewed });
  } catch (err) {
    console.error('early failed:', err);
    return fail(res, 503, 'db_unavailable', 'БД недоступна');
  }
}
