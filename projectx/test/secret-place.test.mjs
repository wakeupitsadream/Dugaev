// SECRET PLACE: адрес виден купившему сразу, публике — за сутки до ночи.
// Правило одно на весь проект (assets/secret-place.js): им пользуются и
// публичная афиша, и страница ночи, и проходка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressIsPublic, publicRevealAt, addressTeaser, PUBLIC_REVEAL_MS } from '../assets/secret-place.js';

const startsAt = '2026-10-09T22:00:00+05:00';
const start = Date.parse(startsAt);

test('за неделю до ночи адрес не публичный', () => {
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start - 7 * 86400_000), false);
});

test('за 25 часов ещё не публичный, за 23 — уже да', () => {
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start - 25 * 3600_000), false);
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start - 23 * 3600_000), true);
});

test('ровно за сутки — граница включительно', () => {
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start - PUBLIC_REVEAL_MS), true);
});

test('в день ночи и после старта адрес публичный', () => {
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start), true);
  assert.equal(addressIsPublic({ startsAt, status: 'onsale' }, start + 3600_000), true);
});

test('прошедшая ночь: адрес открыт всегда — это уже история', () => {
  assert.equal(addressIsPublic({ startsAt, status: 'past' }, start - 30 * 86400_000), true);
});

test('момент публичного раскрытия — ровно за 24 часа', () => {
  assert.equal(Date.parse(publicRevealAt(startsAt)), start - PUBLIC_REVEAL_MS);
});

test('битая дата не открывает адрес', () => {
  assert.equal(addressIsPublic({ startsAt: 'не дата', status: 'onsale' }), false);
  assert.equal(publicRevealAt('не дата'), null);
  assert.equal(addressIsPublic(null), false);
});

test('подсказка считает срок до публичного раскрытия', () => {
  const t = addressTeaser({ startsAt }, start - 3 * 86400_000);
  assert.match(t, /через 2 дня/);
  assert.match(addressTeaser({ startsAt }, start - 30 * 3600_000), /через \d+ (час|часа|часов)/);
  assert.equal(addressTeaser({ startsAt }, start - 3600_000), 'адрес ниже');
});
