// Афиша-картинка из поста канала. Хранилища файлов у нас нет — стримим
// с серверов Telegram по file_id и отдаём CDN-у Vercel на сутки в кэш.
// Токен бота наружу не утекает: клиент видит только /api/poster?fid=...
import { tgApi } from './_lib/tg.js';
import { fail, onlyMethod } from './_lib/respond.js';

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
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
