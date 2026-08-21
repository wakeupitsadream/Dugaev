// HMAC-подпись билетных токенов. Секрет живёт только на сервере.
// Токен: "{id}.{sig}", sig = base32(HMAC-SHA256(secret, id)[0..12)) — 96 бит:
// достаточно, чтобы перебор был невозможен, и коротко для читаемого QR.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { encodeBase32 } from './ids.js';

const SIG_BYTES = 12;

export function signId(id, secret) {
  const mac = createHmac('sha256', secret).update(String(id)).digest();
  return encodeBase32(mac.subarray(0, SIG_BYTES)); // 20 символов
}

export function makeToken(id, secret) {
  return `${id}.${signId(id, secret)}`;
}

// Секреты: [актуальный, старый] — ротация без инвалидации проданных билетов.
export function verifyToken(token, secrets) {
  if (typeof token !== 'string') return { valid: false, id: null };
  const dot = token.indexOf('.');
  if (dot === -1) return { valid: false, id: null };
  const id = token.slice(0, dot).toLowerCase();
  const sig = token.slice(dot + 1).toLowerCase();
  if (!/^[0-9a-z]{10}$/.test(id) || !/^[0-9a-z]{20}$/.test(sig)) {
    return { valid: false, id: null };
  }
  const given = Buffer.from(sig);
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(signId(id, secret));
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { valid: true, id };
    }
  }
  return { valid: false, id: null };
}

// Без TICKET_SECRET в env работаем на дев-секрете (демо не должно ломаться),
// но боевой запуск без настоящего секрета невозможен — см. BRIEF.md.
const DEV_SECRET = 'th-dev-secret-replace-me';

export function primarySecret(env = process.env) {
  if (!env.TICKET_SECRET) console.warn('TICKET_SECRET не задан — используется дев-секрет');
  return env.TICKET_SECRET || DEV_SECRET;
}

export function ticketSecrets(env = process.env) {
  const list = [env.TICKET_SECRET, env.TICKET_SECRET_OLD].filter(Boolean);
  return list.length ? list : [DEV_SECRET];
}
