import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnnouncement, translitSlug, eventSlug, previewText, DEFAULT_WAVES } from '../api/_lib/post-normalize.js';

const NOW = Date.parse('2026-08-21T12:00:00+05:00');
const ctx = { nowMs: NOW };

const base = (over = {}) => ({
  kind: 'announcement',
  confidence: 'high',
  event: {
    title: 'НОВАЯ ЭРА',
    city: 'Оренбург',
    venue: 'клуб «Тропикано»',
    date: '2026-09-12',
    timeStart: '16:00',
    timeEnd: '22:00',
    ageRating: 14,
    prices: [
      { name: 'Первая волна', priceRub: 300 },
      { name: 'На входе', priceRub: 500 },
    ],
    descr: 'Открытие сезона',
    targetSlug: null,
    ...over,
  },
});

test('валидный анонс собирается в событие с волнами', () => {
  const n = normalizeAnnouncement(base(), ctx);
  assert.equal(n.ok, true);
  assert.equal(n.event.city, 'orenburg');
  assert.equal(n.event.startsAt, '2026-09-12T16:00:00+05:00');
  assert.equal(n.event.endsAt, '2026-09-12T22:00:00+05:00');
  assert.equal(n.waves.length, 2);
  assert.equal(n.waves[0].priceRub, 300);
  assert.equal(n.problems.length, 0);
  assert.match(n.event.id, /^echo-novaya-era-0912$/);
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

test('нет цен — стандартный прайс с пометкой', () => {
  const n = normalizeAnnouncement(base({ prices: [] }), ctx);
  assert.equal(n.ok, true);
  assert.deepEqual(n.waves, DEFAULT_WAVES);
  assert.ok(n.problems.some((p) => p.includes('стандартный прайс')));
});

test('дикая цена отбрасывается с пометкой', () => {
  const n = normalizeAnnouncement(base({ prices: [{ name: 'Вип', priceRub: 999999 }, { name: 'Вход', priceRub: 400 }] }), ctx);
  assert.equal(n.waves.length, 1);
  assert.equal(n.waves[0].priceRub, 400);
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
  const n = normalizeAnnouncement(base({ timeStart: '22:00', timeEnd: '04:00', ageRating: 18 }), ctx);
  assert.equal(n.event.endsAt, '2026-09-13T04:00:00+05:00');
});

test('translitSlug и eventSlug', () => {
  assert.equal(translitSlug('Пенная туса!'), 'pennaya-tusa');
  assert.equal(translitSlug('BACK TO SCHOOL'), 'back-to-school');
  assert.equal(eventSlug('НОВАЯ ЭРА', '2026-09-12'), 'echo-novaya-era-0912');
});

test('previewText содержит ключевые поля и проблемы', () => {
  const n = normalizeAnnouncement(base({ prices: [] }), ctx);
  const t = previewText(n, 'источник');
  assert.ok(t.includes('НОВАЯ ЭРА') && t.includes('500') && t.includes('⚠'));
});
