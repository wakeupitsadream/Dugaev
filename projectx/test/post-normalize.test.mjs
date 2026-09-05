import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnnouncement, translitSlug, eventSlug, previewText, DEFAULT_WAVES } from '../api/_lib/post-normalize.js';

const NOW = Date.parse('2026-08-21T12:00:00+05:00');
const ctx = { nowMs: NOW };

// Типовой анонс бренда: ночь 18+, двери 23:00, финиш 06:00 следующего дня.
const base = (over = {}) => ({
  kind: 'announcement',
  confidence: 'high',
  event: {
    title: 'НОВАЯ ЭРА',
    city: 'Оренбург',
    venue: 'клуб «Тропикано»',
    date: '2026-09-12',
    timeStart: '23:00',
    timeEnd: '06:00',
    ageRating: 18,
    prices: [
      { name: 'Ранняя волна', priceRub: 400 },
      { name: 'На входе', priceRub: 800 },
    ],
    descr: 'Открытие сезона',
    targetSlug: null,
    ...over,
  },
});

test('валидный анонс собирается в ночное событие с волнами', () => {
  const n = normalizeAnnouncement(base(), ctx);
  assert.equal(n.ok, true);
  assert.equal(n.event.brand, 'projectx');
  assert.equal(n.event.city, 'orenburg');
  assert.equal(n.event.ageRating, 18);
  assert.equal(n.event.startsAt, '2026-09-12T23:00:00+05:00');
  // ночь пересекает полночь — финиш уже 13-го
  assert.equal(n.event.endsAt, '2026-09-13T06:00:00+05:00');
  assert.equal(n.waves.length, 2);
  assert.equal(n.waves[0].priceRub, 400);
  assert.equal(n.waves[1].priceRub, 800);
  assert.equal(n.problems.length, 0);
  assert.match(n.event.id, /^px-novaya-era-0912$/);
});

test('прошлая дата — событие не создаётся', () => {
  const n = normalizeAnnouncement(base({ date: '2026-08-01' }), ctx);
  assert.equal(n.ok, false);
  assert.ok(n.problems.some((p) => p.includes('в прошлом')));
});

test('нет даты — событие не создаётся', () => {
  const n = normalizeAnnouncement(base({ date: null }), ctx);
  assert.equal(n.ok, false);
});

test('нет цен — стандартный прайс бренда с пометкой', () => {
  const n = normalizeAnnouncement(base({ prices: [] }), ctx);
  assert.equal(n.ok, true);
  assert.deepEqual(n.waves, DEFAULT_WAVES);
  assert.deepEqual(
    n.waves.map((w) => [w.waveNo, w.name, w.priceRub, w.quota]),
    [
      [1, 'Ранняя волна', 400, 80],
      [2, 'Вторая волна', 600, 120],
      [3, 'На входе', 800, 100],
    ]
  );
  assert.ok(n.problems.some((p) => p.includes('стандартный прайс 400/600/800')));
});

test('возраст: 16 и 18 проходят, остальное — 18+ с пометкой', () => {
  for (const age of [16, 18]) {
    const n = normalizeAnnouncement(base({ ageRating: age }), ctx);
    assert.equal(n.event.ageRating, age);
    assert.equal(n.problems.length, 0, `${age}: ${n.problems.join(';')}`);
  }
  const missing = normalizeAnnouncement(base({ ageRating: null }), ctx);
  assert.equal(missing.event.ageRating, 18);
  assert.ok(missing.problems.some((p) => p.includes('возраст не распознан') && p.includes('18+')));

  // ночной бренд не делает 14+ — такой возраст поднимается до 18 с пометкой
  const kids = normalizeAnnouncement(base({ ageRating: 14 }), ctx);
  assert.equal(kids.event.ageRating, 18);
  assert.ok(kids.problems.some((p) => p.includes('14') && p.includes('18+')));
});

test('дикая цена отбрасывается с пометкой', () => {
  const n = normalizeAnnouncement(base({ prices: [{ name: 'Вип', priceRub: 999999 }, { name: 'Вход', priceRub: 800 }] }), ctx);
  assert.equal(n.waves.length, 1);
  assert.equal(n.waves[0].priceRub, 800);
  assert.ok(n.problems.some((p) => p.includes('странно')));
});

test('незнакомый город — переносится как есть с пометкой «проверь»', () => {
  const n = normalizeAnnouncement(base({ city: 'Уфа' }), ctx);
  assert.equal(n.ok, true);
  assert.equal(n.event.city, 'ufa');
  assert.ok(n.problems.some((p) => p.includes('Уфа')));
});

test('Магнитка распознаётся как Магнитогорск', () => {
  const n = normalizeAnnouncement(base({ city: 'Магнитка' }), ctx);
  assert.equal(n.event.city, 'magnitogorsk');
});

test('ночной финиш переезжает на следующий день', () => {
  const n = normalizeAnnouncement(base({ timeStart: '22:00', timeEnd: '04:00' }), ctx);
  assert.equal(n.event.endsAt, '2026-09-13T04:00:00+05:00');
});

test('анонс с 23:00 без времени окончания — финиш 06:00 следующего дня', () => {
  const n = normalizeAnnouncement(base({ timeStart: '23:00', timeEnd: null }), ctx);
  assert.equal(n.ok, true);
  assert.equal(n.event.startsAt, '2026-09-12T23:00:00+05:00');
  assert.equal(n.event.endsAt, '2026-09-13T06:00:00+05:00');
  assert.ok(Date.parse(n.event.endsAt) > Date.parse(n.event.startsAt));
  assert.equal((Date.parse(n.event.endsAt) - Date.parse(n.event.startsAt)) / 3_600_000, 7);

  // перенос через конец месяца не ломается
  const eom = normalizeAnnouncement(base({ date: '2026-09-30', timeStart: '23:00', timeEnd: null }), ctx);
  assert.equal(eom.event.endsAt, '2026-10-01T06:00:00+05:00');
});

test('translitSlug и eventSlug', () => {
  assert.equal(translitSlug('Пенная туса!'), 'pennaya-tusa');
  assert.equal(translitSlug('BACK TO SCHOOL'), 'back-to-school');
  assert.equal(eventSlug('НОВАЯ ЭРА', '2026-09-12'), 'px-novaya-era-0912');
});

test('previewText содержит ключевые поля и проблемы', () => {
  const n = normalizeAnnouncement(base({ prices: [] }), ctx);
  const t = previewText(n, 'источник');
  assert.ok(t.includes('НОВАЯ ЭРА'), t);
  assert.ok(t.includes('Ранняя волна') && t.includes('400') && t.includes('600') && t.includes('800'), t);
  assert.ok(t.includes('23:00') && t.includes('06:00'), t);
  assert.ok(t.includes('18+'), t);
  assert.ok(t.includes('⚠'), t);
  assert.ok(t.includes('источник'), t);
});
