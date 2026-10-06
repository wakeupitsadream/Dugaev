// Афиши.
// GET  /api/poster?id=<hash>  — картинка из базы (загружена в панели или
//      присланная боту); id — хеш содержимого, кэш вечный.
// GET  /api/poster?fid=<file_id> — старые черновики из канала: стрим с
//      серверов Telegram (токен бота наружу не уходит).
// POST /api/poster (админ) { data: base64 | dataURL } → { url }
//      Панель сама уменьшает картинку до ~1350 px и JPEG, поэтому запрос
//      укладывается в лимит тела функции (4,5 МБ).
import { tgApi } from './_lib/tg.js';
import { fail, ok, noStore } from './_lib/respond.js';
import { db, hasDb, ensureSchema, withTimeout } from './_lib/db.js';
import { isAdmin } from './_lib/auth.js';
import { loadMedia, storeMedia } from './_lib/media.js';

export default async function handler(req, res) {
  if (req.method === 'POST') return upload(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return fail(res, 405, 'method_not_allowed', 'Метод не поддерживается');
  }
  const id = String(req.query.id || '');
  if (id) return fromDb(req, res, id);
  return fromTelegram(req, res);
}

async function fromDb(req, res, id) {
  if (!/^[0-9a-f]{24}$/.test(id)) return fail(res, 400, 'validation', 'Некорректный id картинки');
  if (!hasDb()) return fail(res, 404, 'not_found', 'Картинка недоступна');
  try {
    const m = await withTimeout(loadMedia(db(), id), 5000);
    if (!m) return fail(res, 404, 'not_found', 'Картинки нет');
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.status(200).end(m.buf);
  } catch (e) {
    console.warn('poster(db) failed:', e.message);
    noStore(res);
    fail(res, 503, 'db_unavailable', 'База не ответила');
  }
}

async function fromTelegram(req, res) {
  const fid = String(req.query.fid || '');
  if (!/^[A-Za-z0-9_-]{20,150}$/.test(fid)) return fail(res, 400, 'validation', 'Некорректный id файла');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return fail(res, 404, 'not_found', 'Файл недоступен');
  try {
    const file = await tgApi('getFile', { file_id: fid });
    if (!file || !file.file_path) return fail(res, 404, 'not_found', 'Файл недоступен');
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!r.ok) return fail(res, 404, 'not_found', 'Файл недоступен');
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).end(buf);
  } catch (e) {
    console.warn('poster failed:', e.message);
    fail(res, 404, 'not_found', 'Файл недоступен');
  }
}

async function upload(req, res) {
  noStore(res);
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');
  const raw = String(req.body?.data || '');
  const b64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, '');
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return fail(res, 400, 'validation', 'Нужна картинка в base64');
  const buf = Buffer.from(b64, 'base64');
  try {
    const sql = db();
    await ensureSchema(sql);
    const r = await storeMedia(sql, buf);
    if (!r.ok) return fail(res, 400, r.error, r.message);
    return ok(res, { url: r.url, id: r.id, bytes: r.bytes, mime: r.mime });
  } catch (e) {
    console.error('poster upload failed:', e.message);
    return fail(res, 503, 'db_unavailable', 'Не удалось сохранить картинку');
  }
}
