import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goingCount, REAL_THRESHOLD } from '../assets/social.js';

const START = Date.parse('2026-08-29T22:00:00+05:00');

const DEMO = { demo: true };

test('в бою ниже порога счётчика нет (null), выдуманных чисел гость не видит', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(goingCount('ev', START, 0, now), null);
  assert.equal(goingCount('ev', START, REAL_THRESHOLD - 1, now), null);
  assert.equal(goingCount('ev', START, REAL_THRESHOLD, now), REAL_THRESHOLD);
});

test('детерминирован (демо)', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(goingCount('ev', START, 5, now, DEMO), goingCount('ev', START, 5, now, DEMO));
});

test('при реальных продажах >= порога возвращает реальное число', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(goingCount('ev', START, REAL_THRESHOLD, now), REAL_THRESHOLD);
  assert.equal(goingCount('ev', START, 141, now), 141);
});

test('растёт по мере приближения ивента (масштаб дней)', () => {
  const d = (n) => START - n * 86400_000;
  const a = goingCount('ev', START, 0, d(20), DEMO);
  const b = goingCount('ev', START, 0, d(10), DEMO);
  const c = goingCount('ev', START, 0, d(2), DEMO);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
});

test('разные ивенты дают разные, но правдоподобные числа', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  const x = goingCount('ev-one', START, 0, now, DEMO);
  const y = goingCount('ev-two', START, 0, now, DEMO);
  assert.notEqual(x, y);
  for (const v of [x, y]) assert.ok(v > 20 && v < 400, `правдоподобно: ${v}`);
});
