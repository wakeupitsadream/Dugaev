// Проверка боевого SQL на настоящем Postgres (PGlite, WASM).
// Тестируем ровно те стейтменты, которые выполняет продакшен
// (api/_lib/queries.js): атомарность покупки, квоты волн, одноразовый чек-ин.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import { ORDER_SQL, CHECKIN_SQL, NEXT_WAVE_SQL } from '../api/_lib/queries.js';
import { CLEANUP_TEST_SQL, TEST_PHONE } from '../api/seed.js';

let pg;

before(async () => {
  pg = new PGlite();
  for (const stmt of SCHEMA) await pg.query(stmt);
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev1', 'TEST PARTY', 'orenburg', 'клуб', now() + interval '7 days', 18, 'onsale'),
            ('ev-closed', 'CLOSED', 'orenburg', 'клуб', now() + interval '7 days', 18, 'draft')`
  );
  await pg.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES
     ('ev1', 1, 'Первая', 500, 2),
     ('ev1', 2, 'Вторая', 700, 3),
     ('ev-closed', 1, 'Первая', 500, 10)`
  );
});

after(async () => {
  await pg.close();
});

function orderParams({ qty, eventId = 'ev1', waveNo = 1, oid, tids, names, ages }) {
  return [
    qty, eventId, waveNo, oid, 'Покупатель Тест', '+79123456789', null, null,
    tids, names, ages,
  ];
}

test('покупка 1 билета: заказ + билет создаются, квота списана, цена из БД', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 1, oid: 'ord_test0001', tids: ['tttttttt01'], names: ['Иван Иванов'], ages: ['adult'],
  }));
  assert.equal(r.rows[0].price_rub, 500);
  assert.equal(r.rows[0].created, 1);

  const t = await pg.query(`SELECT * FROM tickets WHERE id = 'tttttttt01'`);
  assert.equal(t.rows[0].holder_name, 'Иван Иванов');
  assert.equal(t.rows[0].order_id, 'ord_test0001');

  const o = await pg.query(`SELECT * FROM orders WHERE id = 'ord_test0001'`);
  assert.equal(o.rows[0].amount_rub, 500);
  assert.equal(o.rows[0].status, 'paid');

  const w = await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=1`);
  assert.equal(w.rows[0].sold, 1);
});

test('просят больше, чем осталось: ничего не создано, sold не тронут', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 2, oid: 'ord_test0002',
    tids: ['tttttttt02', 'tttttttt03'], names: ['А Б', 'В Г'], ages: ['adult', 'adult'],
  }));
  assert.equal(r.rows[0].price_rub, null);
  assert.equal(r.rows[0].created, 0);
  const w = await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=1`);
  assert.equal(w.rows[0].sold, 1); // атомарность: частичного списания нет
  const o = await pg.query(`SELECT count(*)::int AS n FROM orders WHERE id = 'ord_test0002'`);
  assert.equal(o.rows[0].n, 0);
});

test('групповая покупка добирает волну до квоты', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 1, oid: 'ord_test0003', tids: ['tttttttt04'], names: ['Д Е'], ages: ['adult'],
  }));
  assert.equal(r.rows[0].created, 1);
  const w = await pg.query(`SELECT sold, quota FROM price_waves WHERE event_id='ev1' AND wave_no=1`);
  assert.equal(w.rows[0].sold, w.rows[0].quota); // волна распродана
});

test('распроданная волна: created=0, NEXT_WAVE_SQL предлагает следующую', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 1, oid: 'ord_test0004', tids: ['tttttttt05'], names: ['Ж З'], ages: ['adult'],
  }));
  assert.equal(r.rows[0].created, 0);
  const nw = await pg.query(NEXT_WAVE_SQL, ['ev1']);
  assert.equal(nw.rows[0].wave_no, 2);
  assert.equal(nw.rows[0].price_rub, 700);
  assert.equal(Number(nw.rows[0].left), 3);
});

test('ивент не в продаже — купить нельзя', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-closed', oid: 'ord_test0005',
    tids: ['tttttttt06'], names: ['И К'], ages: ['adult'],
  }));
  assert.equal(r.rows[0].created, 0);
});

test('дубликат id билета: стейтмент падает целиком, квота не течёт', async () => {
  const before = await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=2`);
  await assert.rejects(
    pg.query(ORDER_SQL, orderParams({
      qty: 1, waveNo: 2, oid: 'ord_test0006',
      tids: ['tttttttt01'], names: ['Дубль'], ages: ['adult'], // id уже существует
    })),
    /duplicate key/
  );
  const after2 = await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=2`);
  assert.equal(after2.rows[0].sold, before.rows[0].sold); // откат целиком
});

test('чек-ин: первый раз проходит, второй — нет', async () => {
  const r1 = await pg.query(CHECKIN_SQL, ['tttttttt01', null, 'Артём']);
  assert.equal(r1.rows.length, 1);
  assert.equal(r1.rows[0].holder_name, 'Иван Иванов');
  assert.ok(r1.rows[0].checked_in_at);

  const r2 = await pg.query(CHECKIN_SQL, ['tttttttt01', null, 'Кто-то другой']);
  assert.equal(r2.rows.length, 0); // повторный вход невозможен

  const t = await pg.query(`SELECT checked_by FROM tickets WHERE id='tttttttt01'`);
  assert.equal(t.rows[0].checked_by, 'Артём'); // осталась первая отметка
});

test('чек-ин отозванного билета не проходит', async () => {
  await pg.query(`UPDATE tickets SET status='revoked' WHERE id='tttttttt04'`);
  const r = await pg.query(CHECKIN_SQL, ['tttttttt04', null, 'Артём']);
  assert.equal(r.rows.length, 0);
});

test('чек-ин с офлайн-временем (outbox) сохраняет переданное время', async () => {
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, waveNo: 2, oid: 'ord_test0007', tids: ['tttttttt07'], names: ['Офлайн Гость'], ages: ['minor'],
  }));
  const at = '2026-08-29T20:15:00.000Z';
  const r = await pg.query(CHECKIN_SQL, ['tttttttt07', at, 'Дверь']);
  assert.equal(r.rows.length, 1);
  assert.equal(new Date(r.rows[0].checked_in_at).toISOString(), at);
  assert.equal(r.rows[0].age_cat, 'minor');
});

test('CHECK-констрейнт не даёт sold уйти выше quota даже прямым UPDATE', async () => {
  await assert.rejects(
    pg.query(`UPDATE price_waves SET sold = quota + 1 WHERE event_id='ev1' AND wave_no=1`),
    /check|constraint/i
  );
});

test('cleanupTest: сносит только заказы самотеста и возвращает квоты', async () => {
  const soldBefore = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=2`)).rows[0].sold;

  // тестовый заказ (телефон самотеста) через боевой ORDER_SQL
  const r = await pg.query(ORDER_SQL, [
    1, 'ev1', 2, 'ord_selftest', 'ТЕХ. ПРОВЕРКА', TEST_PHONE, null, null,
    ['selftestaa'], ['ТЕХ. ПРОВЕРКА'], ['adult'],
  ]);
  assert.equal(r.rows[0].created, 1);
  await pg.query(CHECKIN_SQL, ['selftestaa', null, 'самотест']);
  await pg.query(`INSERT INTO scan_log (ticket_id, result, scanned_by) VALUES ('selftestaa','ok','самотест')`);

  const cleaned = await pg.query(CLEANUP_TEST_SQL);
  assert.equal(cleaned.rows.length, 1);

  const soldAfter = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev1' AND wave_no=2`)).rows[0].sold;
  assert.equal(soldAfter, soldBefore); // квота вернулась
  assert.equal((await pg.query(`SELECT 1 FROM tickets WHERE id='selftestaa'`)).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM orders WHERE id='ord_selftest'`)).rows.length, 0);
  assert.equal((await pg.query(`SELECT 1 FROM scan_log WHERE ticket_id='selftestaa'`)).rows.length, 0);

  // чужие заказы не тронуты
  assert.ok((await pg.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n > 0);

  // повторная уборка идемпотентна
  assert.equal((await pg.query(CLEANUP_TEST_SQL)).rows.length, 0);
});
