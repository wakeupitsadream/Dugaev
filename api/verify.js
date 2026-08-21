// Верификация билета на входе. Два режима:
//  - без админ-ключа: только sig_valid + название ивента (гостевая заставка);
//  - с X-Admin-Key: полный статус + запись попытки в scan_log.
// Ручной поиск по голому id (?id=...&manual=1) — только с админ-ключом.
// БД лежит → sig_valid без статуса (янтарный режим на клиенте).
import { verifyToken, ticketSecrets } from './_lib/sign.js';
import { isAdmin } from './_lib/auth.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'GET')) return;

  const admin = isAdmin(req);
  // ключ прислали, но он неверный — явный отказ (scan-страница перезапросит PIN);
  // гость ключ не шлёт вовсе и попадает в гостевую ветку
  if (req.headers['x-admin-key'] && !admin) {
    return fail(res, 403, 'forbidden', 'Неверный админ-ключ');
  }
  const manual = req.query.manual === '1';

  let id = null;
  let sigValid = false;
  if (manual) {
    if (!admin) return fail(res, 403, 'forbidden', 'Ручной поиск — только для админа');
    id = String(req.query.id || '').toLowerCase();
    if (!/^[0-9a-z]{10}$/.test(id)) return fail(res, 400, 'validation', 'Некорректный номер');
    sigValid = true; // доверенный поиск
  } else {
    const v = verifyToken(String(req.query.token || ''), ticketSecrets());
    sigValid = v.valid;
    id = v.id;
  }

  if (!admin) {
    // гостевая заставка: не раскрываем ничего, кроме валидности и ивента
    if (!sigValid) return ok(res, { sig_valid: false });
    if (!hasDb()) return ok(res, { sig_valid: true });
    try {
      const rows = await withTimeout(db().query(
        `SELECT e.title, e.starts_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1`,
        [id]
      ), 4000);
      const r = (rows.rows || rows)[0];
      return ok(res, {
        sig_valid: true,
        event: r ? { title: r.title, startsAt: new Date(r.starts_at).toISOString() } : null,
      });
    } catch {
      return ok(res, { sig_valid: true });
    }
  }

  // ---- админ-режим ----
  if (!sigValid) {
    await logScan(null, 'bad_sig', adminName(req));
    return ok(res, { sig_valid: false, found: false, status: 'fake' });
  }
  if (!hasDb()) {
    return ok(res, { sig_valid: true, found: false, status: 'unknown', degraded: true });
  }

  try {
    const rows = await withTimeout(db().query(
      `SELECT t.id, t.holder_name, t.age_cat, t.status, t.checked_in_at, t.checked_by,
              e.title, e.starts_at, e.age_rating, w.name AS wave_name
       FROM tickets t
       JOIN events e ON e.id = t.event_id
       JOIN orders o ON o.id = t.order_id
       JOIN price_waves w ON w.id = o.wave_id
       WHERE t.id = $1`,
      [id]
    ), 4000);
    const r = (rows.rows || rows)[0];
    if (!r) {
      await logScan(id, 'not_found', adminName(req));
      return ok(res, { sig_valid: true, found: false, status: 'not_found' });
    }
    let status = 'active';
    if (r.status === 'revoked' || r.status === 'refunded') status = r.status;
    else if (r.checked_in_at) status = 'checked_in';
    await logScan(id, status === 'active' ? 'ok_preview' : status, adminName(req));
    return ok(res, {
      sig_valid: true,
      found: true,
      status,
      holder_name: r.holder_name,
      age_cat: r.age_cat,
      checked_in_at: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
      checked_by: r.checked_by,
      wave_name: r.wave_name,
      event: {
        title: r.title,
        startsAt: new Date(r.starts_at).toISOString(),
        ageRating: Number(r.age_rating),
      },
    });
  } catch (err) {
    console.warn('verify: БД недоступна:', err.message);
    return ok(res, { sig_valid: true, found: false, status: 'unknown', degraded: true });
  }
}

function adminName(req) {
  const raw = String(req.headers['x-admin-name'] || '');
  try {
    return decodeURIComponent(raw).slice(0, 64) || null;
  } catch {
    return raw.slice(0, 64) || null;
  }
}

async function logScan(ticketId, result, by) {
  if (!hasDb()) return;
  try {
    await db().query(
      `INSERT INTO scan_log (ticket_id, result, scanned_by) VALUES ($1, $2, $3)`,
      [ticketId, result, by]
    );
  } catch { /* лог не должен ломать вход */ }
}
