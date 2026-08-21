// Чек-ин: атомарный UPDATE — билет отмечается ровно один раз, гонка двух
// сканеров невозможна. Поддерживает офлайн-очередь: body.at — время нажатия
// «Впустить под запись» на устройстве админа (для досинхронизации).
import { verifyToken, ticketSecrets } from './_lib/sign.js';
import { isAdmin } from './_lib/auth.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { normalizeManualId } from '../assets/ticket-format.js';
import { CHECKIN_SQL } from './_lib/queries.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');

  const b = req.body || {};
  const by = String(b.by || '').slice(0, 64) || null;

  // токен (со сканера) или голый id (ручной ввод / офлайн-очередь)
  let id = null;
  if (b.token) {
    const v = verifyToken(String(b.token), ticketSecrets());
    if (!v.valid) return fail(res, 404, 'bad_sig', 'Подпись не сходится — подделка');
    id = v.id;
  } else if (b.id) {
    id = normalizeManualId(String(b.id));
    if (!id) return fail(res, 400, 'validation', 'Некорректный номер билета');
  } else {
    return fail(res, 400, 'validation', 'Нужен token или id');
  }

  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД недоступна — работай по офлайн-списку');

  const at = b.at && !Number.isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : null;

  try {
    const sql = db();
    const rows = await withTimeout(sql.query(CHECKIN_SQL, [id, at, by]), 5000);
    const r = (rows.rows || rows)[0];

    if (r) {
      await logScan(sql, id, 'ok', by);
      return ok(res, {
        first: true,
        holder_name: r.holder_name,
        age_cat: r.age_cat,
        checked_in_at: new Date(r.checked_in_at).toISOString(),
      });
    }

    // не обновилось: уже использован / отозван / не существует
    const prev = await sql.query(
      `SELECT holder_name, status, checked_in_at, checked_by FROM tickets WHERE id = $1`,
      [id]
    );
    const p = (prev.rows || prev)[0];
    if (!p) {
      await logScan(sql, id, 'not_found', by);
      return fail(res, 404, 'not_found', 'Билет не найден');
    }
    if (p.status !== 'active') {
      await logScan(sql, id, p.status, by);
      return fail(res, 409, 'revoked', 'Билет отозван или возвращён', { status: p.status });
    }
    await logScan(sql, id, 'repeat', by);
    return ok(res, {
      first: false,
      holder_name: p.holder_name,
      checked_in_at: new Date(p.checked_in_at).toISOString(),
      checked_by: p.checked_by,
    });
  } catch (err) {
    console.warn('checkin: БД недоступна:', err.message);
    return fail(res, 503, 'db_unavailable', 'БД недоступна — впусти под запись, синхронизируем позже');
  }
}

async function logScan(sql, ticketId, result, by) {
  try {
    await sql.query(`INSERT INTO scan_log (ticket_id, result, scanned_by) VALUES ($1, $2, $3)`, [ticketId, result, by]);
  } catch { /* лог не должен ломать вход */ }
}
