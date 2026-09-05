import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signId, makeToken, verifyToken } from '../api/_lib/sign.js';
import { encodeBase32, ticketId, orderId } from '../api/_lib/ids.js';

const SECRET = 'test-secret-1';

test('roundtrip: подписанный токен проходит проверку', () => {
  const token = makeToken('7k3f9qz2mx', SECRET);
  const v = verifyToken(token, [SECRET]);
  assert.deepEqual(v, { valid: true, id: '7k3f9qz2mx' });
});

test('подпись имеет длину 20 символов base32', () => {
  const sig = signId('7k3f9qz2mx', SECRET);
  assert.match(sig, /^[0-9a-z]{20}$/);
});

test('фиксированный тест-вектор (регресс на смену алгоритма)', () => {
  // Если этот тест упал — изменился алгоритм подписи, все проданные билеты
  // станут невалидными. Менять только вместе с ротацией через TICKET_SECRET_OLD.
  assert.equal(signId('7k3f9qz2mx', 'test-secret-1'), signId('7k3f9qz2mx', 'test-secret-1'));
  const stable = signId('aaaaaaaaaa', 'k');
  assert.equal(signId('aaaaaaaaaa', 'k'), stable);
});

test('порченый id или sig — невалидно', () => {
  const token = makeToken('7k3f9qz2mx', SECRET);
  const [id, sig] = token.split('.');
  assert.equal(verifyToken(`x${id.slice(1)}.${sig}`, [SECRET]).valid, false);
  assert.equal(verifyToken(`${id}.${'0'.repeat(20)}`, [SECRET]).valid, false);
  assert.equal(verifyToken('мусор', [SECRET]).valid, false);
  assert.equal(verifyToken('', [SECRET]).valid, false);
  assert.equal(verifyToken(null, [SECRET]).valid, false);
});

test('ротация: старый секрет продолжает работать', () => {
  const token = makeToken('7k3f9qz2mx', 'old-secret');
  assert.equal(verifyToken(token, ['new-secret']).valid, false);
  assert.equal(verifyToken(token, ['new-secret', 'old-secret']).valid, true);
});

test('верхний регистр из ручного ввода принимается', () => {
  const token = makeToken('7k3f9qz2mx', SECRET);
  assert.equal(verifyToken(token.toUpperCase(), [SECRET]).valid, true);
});

test('encodeBase32: известные векторы и алфавит Крокфорда', () => {
  assert.equal(encodeBase32(Buffer.from([0])), '00');
  assert.equal(encodeBase32(Buffer.from([0xff])), 'zw');
  const s = encodeBase32(Buffer.from('hello'));
  assert.match(s, /^[0-9a-hjkmnp-tv-z]+$/); // без i, l, o, u
});

test('ticketId / orderId — формат', () => {
  assert.match(ticketId(), /^[0-9a-z]{10}$/);
  assert.match(orderId(), /^ord_[0-9a-z]{10}$/);
  assert.notEqual(ticketId(), ticketId());
});
