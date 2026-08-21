import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plural, dateBox, fmtWhen, fmtTicketWhen, fmtTime,
  parseToken, formatTicketCode, normalizeManualId, normalizePhone, validateAttendees,
  stripRuPhone, formatRuPhoneDigits,
} from '../assets/ticket-format.js';

test('plural склоняет по-русски', () => {
  assert.equal(plural(1, 'билет', 'билета', 'билетов'), 'билет');
  assert.equal(plural(3, 'билет', 'билета', 'билетов'), 'билета');
  assert.equal(plural(11, 'билет', 'билета', 'билетов'), 'билетов');
  assert.equal(plural(21, 'билет', 'билета', 'билетов'), 'билет');
  assert.equal(plural(105, 'билет', 'билета', 'билетов'), 'билетов');
});

test('датабокс и форматы дат — в поясе Екатеринбурга', () => {
  // 22:00 +05:00 — суббота 29 августа
  const iso = '2026-08-29T22:00:00+05:00';
  assert.deepEqual(dateBox(iso), { day: '29', mon: 'АВГ' });
  assert.equal(fmtWhen(iso), 'СБ · 29 августа · 22:00');
  assert.equal(fmtTicketWhen(iso), '29 августа, 22:00');
  // тот же момент в UTC — дата не должна «уехать»
  assert.deepEqual(dateBox('2026-08-29T17:00:00Z'), { day: '29', mon: 'АВГ' });
  assert.equal(fmtTime('2026-08-29T18:41:00Z'), '23:41');
});

test('parseToken принимает только полный токен', () => {
  const t = parseToken('7k3f9qz2mx.abcdefghjkmnpqrstvwx');
  assert.deepEqual(t, { id: '7k3f9qz2mx', sig: 'abcdefghjkmnpqrstvwx' });
  assert.equal(parseToken('7k3f9qz2mx'), null); // без подписи — нет
  assert.equal(parseToken('short.sig'), null);
  assert.equal(parseToken(''), null);
  assert.equal(parseToken(null), null);
  // верхний регистр нормализуется
  assert.deepEqual(parseToken('7K3F9QZ2MX.ABCDEFGHJKMNPQRSTVWX'), { id: '7k3f9qz2mx', sig: 'abcdefghjkmnpqrstvwx' });
});

test('formatTicketCode группирует 4-4-2', () => {
  assert.equal(formatTicketCode('7k3f9qz2mx'), '7K3F-9QZ2-MX');
});

test('normalizeManualId терпит дефисы, регистр и O/0, I/1', () => {
  assert.equal(normalizeManualId('7K3F-9QZ2-MX'), '7k3f9qz2mx');
  assert.equal(normalizeManualId(' 7k3f 9qz2 mx '), '7k3f9qz2mx');
  assert.equal(normalizeManualId('7K3F-9QZ2-MO'), '7k3f9qz2m0'); // O → 0
  assert.equal(normalizeManualId('abc'), null);
});

test('normalizePhone нормализует форматы РФ', () => {
  assert.equal(normalizePhone('8 (912) 345-67-89'), '+79123456789');
  assert.equal(normalizePhone('+7 912 345 67 89'), '+79123456789');
  assert.equal(normalizePhone('9123456789'), '+79123456789');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('stripRuPhone: только 10 цифр после фиксированного +7', () => {
  assert.equal(stripRuPhone('9123456789'), '9123456789');
  assert.equal(stripRuPhone('912 345-67-89'), '9123456789');
  assert.equal(stripRuPhone('89123456789'), '9123456789');   // привычная 8 срезается сразу
  assert.equal(stripRuPhone('8912'), '912');
  assert.equal(stripRuPhone('+7 912 345 67 89'), '9123456789'); // вставка полного номера
  assert.equal(stripRuPhone('791234567891234'), '9123456789'); // лишнее отрезается
  assert.equal(stripRuPhone(''), '');
});

test('formatRuPhoneDigits: маска 912 345-67-89, частичный ввод не ломается', () => {
  assert.equal(formatRuPhoneDigits('9123456789'), '912 345-67-89');
  assert.equal(formatRuPhoneDigits('912'), '912');
  assert.equal(formatRuPhoneDigits('91234'), '912 34');
  assert.equal(formatRuPhoneDigits('9123456'), '912 345-6');
  assert.equal(formatRuPhoneDigits(''), '');
});

test('маска и normalizePhone согласованы', () => {
  assert.equal(normalizePhone('+7' + stripRuPhone('89123456789')), '+79123456789');
});

test('validateAttendees: имена и запрет minor на 18+', () => {
  assert.ok(validateAttendees([{ name: 'Иван', minor: false }], 18).ok);
  assert.ok(validateAttendees([{ name: 'Ира', minor: true }], 16).ok);
  const bad = validateAttendees([{ name: 'Ира', minor: true }], 18);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors[0], { i: 0, code: 'minor_forbidden' });
  assert.equal(validateAttendees([{ name: 'И' }], 16).ok, false);
  assert.equal(validateAttendees([], 16).ok, false);
  assert.equal(validateAttendees(new Array(11).fill({ name: 'Гость' }), 16).ok, false);
});
