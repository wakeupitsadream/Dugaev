// Проверка ключей. Сравнение — timingSafeEqual, ключи передаются только
// в заголовках (не в URL — не текут в логи).
//
// Роли (v6): ADMIN_KEY — владелец (всё), DOOR_KEY — дверь (сканер, чек-ин,
// касса на входе, приём оплаты, офлайн-список). У хостес на входе нет
// доступа к статистике, кассе по дням и правке ночей; ушёл сотрудник —
// меняется один ключ, а не оба.
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const keyOf = (req) => String(req.headers['x-admin-key'] || '');

export function isAdmin(req) {
  return safeEqual(keyOf(req), process.env.ADMIN_KEY || '');
}

// Дверь: свой ключ ИЛИ админский (владелец на дверях — обычное дело)
export function isDoor(req) {
  return isAdmin(req) || safeEqual(keyOf(req), process.env.DOOR_KEY || '');
}

export function roleOf(req) {
  if (isAdmin(req)) return 'admin';
  if (safeEqual(keyOf(req), process.env.DOOR_KEY || '')) return 'door';
  return null;
}

export function isBot(req) {
  return safeEqual(String(req.headers['x-bot-token'] || ''), process.env.BOT_API_TOKEN || '');
}

// Имя сотрудника из заголовка (кириллица едет через encodeURIComponent)
export function staffName(req) {
  const raw = String(req.headers['x-admin-name'] || '');
  try {
    return decodeURIComponent(raw).slice(0, 64) || null;
  } catch {
    return raw.slice(0, 64) || null;
  }
}
