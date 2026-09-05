// Афиша из админки: чистая валидация формы + боевой SQL на настоящем
// Postgres (PGlite). Проверяем ровно те стейтменты, что выполняет
// api/event-upsert.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import {
  EVENT_UPSERT_SQL,
  WAVE_UPSERT_SQL,
  WAVES_PRUNE_SQL,
  ADMIN_EVENTS_SQL,
  ORDER_SQL,
} from '../api/_lib/queries.js';
import { parseEventForm, buildRange, makeEventId } from '../api/_lib/event-form.js';

const NOW = Date.parse('2026-09-05T12:00:00+05:00');
const form = (over = {}) => ({
  title: 'Ночь Икс',
  date: '2026-10-10',
  timeStart: '23:00',
  timeEnd: '06:00',
  ageRating: 18,
  venue: 'клуб',
  status: 'onsale',
  waves: [{ waveNo: 1, name: 'Ранняя', priceRub: 400, quota: 80 }],
  ...over,
});

// ---------- чистая валидация ----------

test('валидная форма собирается в событие с ночным диапазоном', () => {
  const r = parseEventForm(form(), { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.event.id, 'px-noch-iks-1010');
  assert.equal(r.event.title, 'НОЧЬ ИКС');
  assert.equal(r.event.city, 'orenburg');
  assert.equal(r.event.brand, 'projectx');
  assert.equal(r.event.startsAt, '2026-10-10T23:00:00+05:00');
  // финиш после полуночи — следующий календарный день
  assert.equal(r.event.endsAt, '2026-10-11T06:00:00+05:00');
  assert.equal(r.warnings.length, 0);
});

test('дневной диапазон остаётся в тех же сутках', () => {
  const { startsAt, endsAt } = buildRange('2026-10-10', '16:00', '22:00');
  assert.equal(startsAt, '2026-10-10T16:00:00+05:00');
  assert.equal(endsAt, '2026-10-10T22:00:00+05:00');
});

test('id строится из названия и даты, существующий id не подменяется', () => {
  assert.equal(makeEventId('PROJECT X — OPENING', '2026-09-26'), 'px-project-x-opening-0926');
  const r = parseEventForm(form({ id: 'px-legacy-id' }), { nowMs: NOW });
  assert.equal(r.event.id, 'px-legacy-id');
});

test('мусор в полях — ошибки с адресами полей, событие не собирается', () => {
  const r = parseEventForm(
    form({ title: 'X', date: '10.10.2026', timeStart: '25:99', ageRating: 14, status: 'live' }),
    { nowMs: NOW }
  );
  assert.equal(r.ok, false);
  const fields = r.errors.map((e) => e.field);
  for (const f of ['title', 'date', 'timeStart', 'ageRating', 'status']) {
    assert.ok(fields.includes(f), `нет ошибки по полю ${f}: ${fields}`);
  }
});

test('прошедшая дата в продажу не ставится, но черновиком сохраняется', () => {
  const past = { date: '2026-08-01' };
  assert.equal(parseEventForm(form(past), { nowMs: NOW }).ok, false);
  assert.equal(parseEventForm(form({ ...past, status: 'past' }), { nowMs: NOW }).ok, true);
});

test('цена и квота вне диапазона — отказ', () => {
  const bad = (w) => parseEventForm(form({ waves: [w] }), { nowMs: NOW });
  assert.equal(bad({ waveNo: 1, name: 'X', priceRub: 99999, quota: 10 }).ok, false);
  assert.equal(bad({ waveNo: 1, name: 'X', priceRub: 400, quota: 0 }).ok, false);
  assert.equal(bad({ waveNo: 1, name: 'X', priceRub: 400, quota: 99999 }).ok, false);
  assert.equal(bad({ waveNo: 1, name: 'Фри', priceRub: 0, quota: 10 }).ok, true); // 0 ₽ допустим
});

test('квота ниже проданного поднимается до продаж и даёт предупреждение', () => {
  const r = parseEventForm(form({ waves: [{ waveNo: 1, name: 'Ранняя', priceRub: 400, quota: 5 }] }), {
    nowMs: NOW,
    existing: { id: 'px-x', waves: [{ waveNo: 1, sold: 12 }] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.waves[0].quota, 12);
  assert.match(r.warnings[0], /продано 12/);
});

test('волну с продажами удалить нельзя, пустую — можно', () => {
  const withSold = parseEventForm(form(), {
    nowMs: NOW,
    existing: { id: 'px-x', waves: [{ waveNo: 1, sold: 0 }, { waveNo: 2, sold: 3 }] },
  });
  assert.equal(withSold.ok, false);
  assert.match(withSold.errors[0].message, /продано 3/);

  const empty = parseEventForm(form(), {
    nowMs: NOW,
    existing: { id: 'px-x', waves: [{ waveNo: 1, sold: 0 }, { waveNo: 2, sold: 0 }] },
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.prune, [2]);
});

// ---------- боевой SQL ----------

let pg;
before(async () => {
  pg = new PGlite();
  for (const stmt of SCHEMA) await pg.query(stmt);
});
after(async () => pg.close());

const upsertEvent = (over = {}) => {
  const e = {
    id: 'px-sql-1', brand: 'projectx', title: 'SQL PARTY', city: 'orenburg',
    venue: 'клуб', address: 'Оренбург', startsAt: '2026-10-10T23:00:00+05:00',
    endsAt: '2026-10-11T06:00:00+05:00', ageRating: 18, status: 'onsale',
    posterUrl: null, descr: 'первое описание', lineup: null, ...over,
  };
  return pg.query(EVENT_UPSERT_SQL, [
    e.id, e.brand, e.title, e.city, e.venue, e.address, e.startsAt, e.endsAt,
    e.ageRating, e.status, e.posterUrl, e.descr, e.lineup,
  ]);
};

test('UPSERT создаёт событие, повтор обновляет его же (id не плодится)', async () => {
  await upsertEvent();
  await upsertEvent({ title: 'SQL PARTY V2', status: 'draft' });
  const rows = (await pg.query(`SELECT id, title, status FROM events WHERE id = 'px-sql-1'`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'SQL PARTY V2');
  assert.equal(rows[0].status, 'draft');
});

test('редактирование без постера/описания не затирает их (COALESCE)', async () => {
  await upsertEvent({ id: 'px-sql-2', posterUrl: '/assets/poster.jpg', descr: 'было' });
  await upsertEvent({ id: 'px-sql-2', posterUrl: null, descr: null, title: 'ПРАВКА' });
  const r = (await pg.query(`SELECT title, poster_url, descr FROM events WHERE id = 'px-sql-2'`)).rows[0];
  assert.equal(r.title, 'ПРАВКА');
  assert.equal(r.poster_url, '/assets/poster.jpg');
  assert.equal(r.descr, 'было');
});

test('волна: создаётся, обновляется, квота не падает ниже проданного', async () => {
  await upsertEvent({ id: 'px-sql-3' });
  await pg.query(WAVE_UPSERT_SQL, ['px-sql-3', 1, 'Ранняя', 400, 50]);
  await pg.query(`UPDATE price_waves SET sold = 30 WHERE event_id = 'px-sql-3' AND wave_no = 1`);
  // владелец пытается сжать квоту до 10 — CHECK(sold<=quota) уронил бы запрос
  const r = (await pg.query(WAVE_UPSERT_SQL, ['px-sql-3', 1, 'Ранняя', 450, 10])).rows[0];
  assert.equal(Number(r.quota), 30);
  assert.equal(Number(r.sold), 30);
  const w = (await pg.query(`SELECT price_rub FROM price_waves WHERE event_id='px-sql-3' AND wave_no=1`)).rows[0];
  assert.equal(Number(w.price_rub), 450);
});

test('prune сносит только непроданные волны', async () => {
  await upsertEvent({ id: 'px-sql-4' });
  await pg.query(WAVE_UPSERT_SQL, ['px-sql-4', 1, 'Первая', 400, 10]);
  await pg.query(WAVE_UPSERT_SQL, ['px-sql-4', 2, 'Вторая', 600, 10]);
  await pg.query(WAVE_UPSERT_SQL, ['px-sql-4', 3, 'Третья', 800, 10]);
  await pg.query(`UPDATE price_waves SET sold = 4 WHERE event_id='px-sql-4' AND wave_no=2`);
  await pg.query(WAVES_PRUNE_SQL, ['px-sql-4', [1]]); // оставляем только первую
  const left = (await pg.query(`SELECT wave_no FROM price_waves WHERE event_id='px-sql-4' ORDER BY wave_no`)).rows;
  assert.deepEqual(left.map((r) => Number(r.wave_no)), [1, 2]); // вторая уцелела: есть продажи
});

test('созданное из админки событие сразу продаётся тем же ORDER_SQL', async () => {
  await upsertEvent({ id: 'px-sql-5', status: 'onsale' });
  await pg.query(WAVE_UPSERT_SQL, ['px-sql-5', 1, 'Ранняя', 400, 5]);
  const r = (await pg.query(ORDER_SQL, [
    1, 'px-sql-5', 1, 'ord-px-1', 'Гость Тест', '+79123456789', null, null,
    ['tkt-px-1'], ['Гость Тест'], ['adult'], 'stub',
  ])).rows[0];
  assert.equal(Number(r.price_rub), 400);
  assert.equal(Number(r.created), 1);
});

test('админский список отдаёт черновики с волнами, публичная афиша — нет', async () => {
  await upsertEvent({ id: 'px-draft-1', status: 'draft', title: 'ЧЕРНОВИК' });
  await pg.query(WAVE_UPSERT_SQL, ['px-draft-1', 1, 'Ранняя', 400, 10]);
  const all = (await pg.query(ADMIN_EVENTS_SQL)).rows;
  const draft = all.find((r) => r.id === 'px-draft-1');
  assert.ok(draft, 'черновик не виден админке');
  const waves = typeof draft.waves === 'string' ? JSON.parse(draft.waves) : draft.waves;
  assert.equal(waves[0].priceRub, 400);
  const publicRows = (await pg.query(
    `SELECT id FROM events WHERE status IN ('onsale','soldout','past')`
  )).rows;
  assert.ok(!publicRows.some((r) => r.id === 'px-draft-1'), 'черновик утёк в публичную афишу');
});
