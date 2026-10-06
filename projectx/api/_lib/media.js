// Афиши в базе: загрузка из панели и из Telegram, выдача по id.
// id — хеш содержимого, поэтому одна и та же картинка не дублируется,
// а ответ /api/poster?id=… можно кэшировать навсегда.
import { createHash } from 'node:crypto';
import { tgApi } from './tg.js';

export const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const MIMES = ['image/jpeg', 'image/png', 'image/webp'];

// Тип по первым байтам, а не по заявленному: в базу попадают только картинки
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const mediaId = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 24);
export const mediaUrl = (id) => `/api/poster?id=${id}`;

// buf → { ok, url, id } | { ok:false, error, message }
export async function storeMedia(sql, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'empty', message: 'Пустой файл' };
  if (buf.length > MAX_MEDIA_BYTES) return { ok: false, error: 'too_big', message: 'Картинка больше 3 МБ — сожми её' };
  const mime = sniffMime(buf);
  if (!mime || !MIMES.includes(mime)) return { ok: false, error: 'bad_type', message: 'Нужна картинка JPG, PNG или WebP' };
  const id = mediaId(buf);
  await sql.query(
    `INSERT INTO media (id, mime, data, bytes) VALUES ($1, $2, decode($3, 'base64'), $4) ON CONFLICT (id) DO NOTHING`,
    [id, mime, buf.toString('base64'), buf.length]
  );
  return { ok: true, id, url: mediaUrl(id), mime, bytes: buf.length };
}

export async function loadMedia(sql, id) {
  if (!/^[0-9a-f]{24}$/.test(String(id || ''))) return null;
  const rows = await sql.query(`SELECT mime, encode(data, 'base64') AS b64 FROM media WHERE id = $1`, [id]);
  const r = (rows.rows || rows)[0];
  return r ? { mime: r.mime, buf: Buffer.from(r.b64, 'base64') } : null;
}

// Файл из Telegram по file_id (самый большой размер фото) — для афиши,
// присланной боту. Токен наружу не уходит.
export async function fetchTelegramFile(fileId, timeoutMs = 8000) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !fileId) return null;
  const file = await tgApi('getFile', { file_id: fileId });
  if (!file || !file.file_path) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
