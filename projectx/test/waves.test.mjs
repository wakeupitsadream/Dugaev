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

test('demoWaves: симуляция продаёт только первую публичную волну и не доводит её до конца', () => {
  const night = {
    id: 'px-260926', startsAt: '2026-09-26T22:00:00+05:00',
    waves: [W(1, 1000, 50), W(2, 1500, 150), { ...W(9, 0, 10), public: false }],
  };
  for (const at of ['2026-09-10T12:00:00+05:00', '2026-09-25T12:00:00+05:00', '2026-09-26T21:00:00+05:00']) {
    const ws = demoWaves(night, Date.parse(at));
    assert.ok(ws[0].sold > 0 && ws[0].sold <= 40, `${at}: sold=${ws[0].sold}`); // потолок 80 % от 50, джиттер внутри
    assert.equal(ws[1].sold, 0); // вторая волна ждёт настоящих продаж
    assert.equal(ws[2].sold, 0); // гостевой список не симулируем
  }
  const ladder = { id: 'x', startsAt: '2026-09-26T22:00:00+05:00', waves: [W(1, 500, 60), W(2, 700, 80), W(3, 900, 60)] };
  const ls = demoWaves(ladder, Date.parse('2026-09-26T12:00:00+05:00'));
  assert.ok(ls[0].sold > 0 && ls[0].sold <= 48, `sold=${ls[0].sold}`); // первая — живая, но не распродана
  assert.deepEqual([ls[1].sold, ls[2].sold], [0, 0]);
});
