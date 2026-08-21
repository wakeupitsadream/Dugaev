import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waveStates, activeWave, fromPrice, totalSold, demoSold, demoWaves, hash } from '../assets/waves.js';

const W = (waveNo, priceRub, quota, sold) => ({ waveNo, name: `Волна ${waveNo}`, priceRub, quota, sold });

test('первая нераспроданная волна — active, до неё past, после — next', () => {
  const st = waveStates([W(1, 500, 60, 60), W(2, 700, 80, 12), W(3, 900, 60, 0)]);
  assert.deepEqual(st.map((w) => w.state), ['past', 'active', 'next']);
  assert.equal(st[1].left, 68);
});

test('ничего не продано — первая волна active', () => {
  const st = waveStates([W(1, 500, 60, 0), W(2, 700, 80, 0)]);
  assert.deepEqual(st.map((w) => w.state), ['active', 'next']);
});

test('всё распродано — все past, activeWave = null, fromPrice = null', () => {
  const waves = [W(1, 500, 10, 10), W(2, 700, 10, 10)];
  assert.deepEqual(waveStates(waves).map((w) => w.state), ['past', 'past']);
  assert.equal(activeWave(waves), null);
  assert.equal(fromPrice(waves), null);
});

test('fromPrice — цена активной волны', () => {
  assert.equal(fromPrice([W(1, 500, 10, 10), W(2, 700, 10, 3)]), 700);
});

test('left не бывает отрицательным даже при кривом sold', () => {
  const st = waveStates([W(1, 500, 10, 99)]);
  assert.equal(st[0].left, 0);
  assert.equal(st[0].sold, 10);
});

test('волны сортируются по waveNo', () => {
  const st = waveStates([W(2, 700, 10, 0), W(1, 500, 10, 10)]);
  assert.deepEqual(st.map((w) => w.waveNo), [1, 2]);
});

test('totalSold суммирует с клампом', () => {
  assert.equal(totalSold([W(1, 500, 10, 4), W(2, 700, 10, 12)]), 14);
});

// ---- демо-симуляция ----
const START = Date.parse('2026-08-29T22:00:00+05:00');

test('demoSold детерминирован: один вход — один выход', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(demoSold('ev', 1, 60, START, now), demoSold('ev', 1, 60, START, now));
});

test('demoSold растёт к дате ивента и не превышает квоту', () => {
  const early = demoSold('ev', 2, 80, START, START - 25 * 86400_000);
  const mid = demoSold('ev', 2, 80, START - 0, START - 10 * 86400_000);
  const late = demoSold('ev', 2, 80, START, START - 1 * 86400_000);
  assert.ok(early <= mid && mid <= late, `${early} <= ${mid} <= ${late}`);
  assert.ok(late <= 80);
});

test('за ~9 дней до ивента первая волна уже распродана (лестница FOMO)', () => {
  const now = Date.parse('2026-08-20T12:00:00+05:00');
  assert.equal(demoSold('ev', 1, 60, START, now), 60);
  const w2 = demoSold('ev', 2, 80, START, now);
  assert.ok(w2 > 0 && w2 < 80, `вторая волна частично: ${w2}`);
});

test('demoWaves навешивает sold на все волны ивента', () => {
  const event = {
    id: 'x', startsAt: '2026-08-29T22:00:00+05:00',
    waves: [W(1, 500, 60), W(2, 700, 80)],
  };
  const ws = demoWaves(event, Date.parse('2026-08-20T12:00:00+05:00'));
  assert.equal(ws.length, 2);
  for (const w of ws) assert.ok(Number.isInteger(w.sold) && w.sold >= 0 && w.sold <= w.quota);
});

test('hash стабилен и различает строки', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});
