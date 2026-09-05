// Генерация идентификаторов. base32 Crockford (без i, l, o, u) —
// номер можно продиктовать охране голосом без путаницы.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function encodeBase32(buf) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

// 6 байт → 10 символов, 48 бит энтропии
export function ticketId() {
  return encodeBase32(randomBytes(6));
}

export function orderId() {
  return 'ord_' + encodeBase32(randomBytes(6));
}
