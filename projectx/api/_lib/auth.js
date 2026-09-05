// Проверка админ-ключа и токена бота. Сравнение — timingSafeEqual,
// ключи передаются только в заголовках (не в URL — не текут в логи).
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function isAdmin(req) {
  return safeEqual(String(req.headers['x-admin-key'] || ''), process.env.ADMIN_KEY || '');
}

export function isBot(req) {
  return safeEqual(String(req.headers['x-bot-token'] || ''), process.env.BOT_API_TOKEN || '');
}
