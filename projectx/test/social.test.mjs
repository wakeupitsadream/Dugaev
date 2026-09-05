import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goingCount, REAL_THRESHOLD } from '../assets/social.js';

const START = Date.parse('2026-08-29T22:00:00+05:00');

test('детерминирован', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(goingCount('ev', START, 5, now), goingCount('ev', START, 5, now));
});

test('при реальных продажах >= порога возвращает реальное число', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(goingCount('ev', START, REAL_THRESHOLD, now), REAL_THRESHOLD);
  assert.equal(goingCount('ev', START, 141, now), 141);
});

test('растёт по мере приближения ивента (масштаб дней)', () => {
  const d = (n) => START - n * 86400_000;
  const a = goingCount('ev', START, 0, d(20));
  const b = goingCount('ev', START, 0, d(10));
  const c = goingCount('ev', START, 0, d(2));
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
});

test('разные ивенты дают разные, но правдоподобные числа', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  const x = goingCount('ev-one', START, 0, now);
  const y = goingCount('ev-two', START, 0, now);
  assert.notEqual(x, y);
  for (const v of [x, y]) assert.ok(v > 20 && v < 400, `правдоподобно: ${v}`);
});
