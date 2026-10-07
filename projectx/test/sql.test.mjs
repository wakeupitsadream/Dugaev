// Проверка боевого SQL на настоящем Postgres (PGlite, WASM).
// Тестируем ровно те стейтменты, которые выполняет продакшен
// (api/_lib/queries.js): атомарность покупки, квоты волн, одноразовый чек-ин.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import {
  ORDER_SQL, CHECKIN_SQL, NEXT_WAVE_SQL, EXPIRE_SQL, CONFIRM_SQL, CANCEL_SQL,
  VOID_SQL, RENAME_SQL, PENDING_SQL, SOURCES_SQL, CLAIM_SQL, CLOSE_EXPIRED_SQL,
  NEXT_WAVE_FOR_SQL, nightCheck,
} from '../api/_lib/queries.js';
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

function orderParams({ qty, eventId = 'ev1', waveNo = 1, oid, tids, names, ages, provider = 'stub', hold = 180, code = null, hidden = false }) {
  return [
    qty, eventId, waveNo, oid, 'Покупатель Тест', '+79123456789', null, null,
    tids, names, ages, provider, hold, code, hidden,
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
    ['selftestaa'], ['ТЕХ. ПРОВЕРКА'], ['adult'], 'stub', 180, null, false,
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

test('провайдер заказа сохраняется (онлайн vs касса)', async () => {
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 1, waveNo: 2, oid: 'ord_door01', tids: ['doorticket'], names: ['Кассовый Гость'], ages: ['adult'],
    provider: 'door',
  }));
  assert.equal(r.rows[0].created, 1);
  const o = await pg.query(`SELECT provider FROM orders WHERE id = 'ord_door01'`);
  assert.equal(o.rows[0].provider, 'door');
});

// ---------- v6: бронь с оплатой переводом ----------

test('бронь переводом: заказ pending с кодом и сроком, билеты reserved, квота удержана', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev-tr', 'TRANSFER PARTY', 'orenburg', 'лофт', now() + interval '10 days', 18, 'onsale')`
  );
  await pg.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public) VALUES
     ('ev-tr', 1, 'Проходка', 1000, 6, true),
     ('ev-tr', 9, 'Гостевой список', 0, 2, false)`
  );
  const r = await pg.query(ORDER_SQL, orderParams({
    qty: 2, eventId: 'ev-tr', oid: 'ord_tr0001', tids: ['trtickt001', 'trtickt002'],
    names: ['Гость Один', 'Гость Два'], ages: ['adult', 'adult'],
    provider: 'transfer', hold: 180, code: 'PX-TEST',
  }));
  assert.equal(r.rows[0].created, 2);
  assert.equal(r.rows[0].price_rub, 1000);
  assert.equal(r.rows[0].pay_code, 'PX-TEST');
  const left = Date.parse(r.rows[0].expires_at) - Date.now();
  assert.ok(left > 170 * 60_000 && left <= 180 * 60_000, `срок брони ${left} мс`);

  const o = (await pg.query(`SELECT status, amount_rub, paid_at, pay_code FROM orders WHERE id='ord_tr0001'`)).rows[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.amount_rub, 2000);
  assert.equal(o.paid_at, null);
  const t = (await pg.query(`SELECT status FROM tickets WHERE order_id='ord_tr0001'`)).rows;
  assert.deepEqual(t.map((x) => x.status), ['reserved', 'reserved']);
  const w = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0];
  assert.equal(w.sold, 2); // места удержаны, пока бронь жива
});

test('reserved-билет вход не проходит, после CONFIRM — проходит', async () => {
  const blocked = await pg.query(CHECKIN_SQL, ['trtickt001', null, 'Дверь']);
  assert.equal(blocked.rows.length, 0);

  const c = await pg.query(CONFIRM_SQL, ['ord_tr0001', 'Максим', 'transfer']);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].buyer_name, 'Покупатель Тест');
  const tickets = typeof c.rows[0].tickets === 'string' ? JSON.parse(c.rows[0].tickets) : c.rows[0].tickets;
  assert.equal(tickets.length, 2);

  const o = (await pg.query(`SELECT status, paid_at, confirmed_by, provider FROM orders WHERE id='ord_tr0001'`)).rows[0];
  assert.equal(o.status, 'paid');
  assert.ok(o.paid_at);
  assert.equal(o.confirmed_by, 'Максим');
  assert.equal(o.provider, 'transfer');
  const ok = await pg.query(CHECKIN_SQL, ['trtickt001', null, 'Дверь']);
  assert.equal(ok.rows.length, 1);

  // повторное подтверждение — пусто, ничего не ломает
  const again = await pg.query(CONFIRM_SQL, ['ord_tr0001', 'Максим', null]);
  assert.equal(again.rows.length, 0);
});

test('EXPIRE: просроченная бронь сгорает и возвращает квоту; заявленная «я перевёл» — нет', async () => {
  // срок в прошлом (−1 минута)
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-tr', oid: 'ord_tr_old', tids: ['trtickt003'], names: ['Опоздавший'], ages: ['adult'],
    provider: 'transfer', hold: -1, code: 'PX-OLD1',
  }));
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-tr', oid: 'ord_tr_clm', tids: ['trtickt004'], names: ['Заявивший'], ages: ['adult'],
    provider: 'transfer', hold: -1, code: 'PX-CLM1',
  }));
  await pg.query(`UPDATE orders SET claimed_at = now() WHERE id = 'ord_tr_clm'`);
  // квота волны 6: хватает на обе брони, проверяем возврат по sold
  const before = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;

  const ex = await pg.query(EXPIRE_SQL);
  assert.deepEqual(ex.rows.map((r) => r.id), ['ord_tr_old']);
  const o = (await pg.query(`SELECT status FROM orders WHERE id='ord_tr_old'`)).rows[0];
  assert.equal(o.status, 'expired');
  const t = (await pg.query(`SELECT status FROM tickets WHERE id='trtickt003'`)).rows[0];
  assert.equal(t.status, 'expired');
  const after = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;
  assert.equal(after, before - 1);

  const clm = (await pg.query(`SELECT status FROM orders WHERE id='ord_tr_clm'`)).rows[0];
  assert.equal(clm.status, 'pending'); // ждёт решения владельца
  // повтор ничего не находит
  assert.equal((await pg.query(EXPIRE_SQL)).rows.length, 0);
});

test('PENDING_SQL: ожидающие с билетами, заявленные первыми', async () => {
  const rows = (await pg.query(PENDING_SQL, ['ev-tr'])).rows;
  assert.equal(rows[0].id, 'ord_tr_clm');
  assert.equal(rows[0].pay_code, 'PX-CLM1');
  const tickets = typeof rows[0].tickets === 'string' ? JSON.parse(rows[0].tickets) : rows[0].tickets;
  assert.equal(tickets[0].holder_name, 'Заявивший');
  assert.ok(!rows.some((r) => r.id === 'ord_tr_old'), 'сгоревшая бронь попала в ожидающие');
});

test('CANCEL: владелец отменяет бронь, квота возвращается, подтвердить уже нельзя', async () => {
  const before = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;
  const c = await pg.query(CANCEL_SQL, ['ord_tr_clm']);
  assert.equal(c.rows.length, 1);
  const after = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;
  assert.equal(after, before - 1);
  assert.equal((await pg.query(`SELECT status FROM tickets WHERE id='trtickt004'`)).rows[0].status, 'cancelled');
  assert.equal((await pg.query(CONFIRM_SQL, ['ord_tr_clm', 'Максим', null])).rows.length, 0);
});

test('VOID и RENAME: аннулировать можно только не прошедшего вход, имя меняется без смены QR', async () => {
  // trtickt001 уже прошёл вход — аннулировать нельзя
  assert.equal((await pg.query(VOID_SQL, ['trtickt001', 'revoked', 'тест'])).rows.length, 0);
  // trtickt002 активен и не проходил — можно, место возвращается
  const before = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;
  const v = await pg.query(VOID_SQL, ['trtickt002', 'refunded', 'вернули перевод']);
  assert.equal(v.rows.length, 1);
  const after = (await pg.query(`SELECT sold FROM price_waves WHERE event_id='ev-tr' AND wave_no=1`)).rows[0].sold;
  assert.equal(after, before - 1);
  const t = (await pg.query(`SELECT status, note FROM tickets WHERE id='trtickt002'`)).rows[0];
  assert.equal(t.status, 'refunded');
  assert.equal(t.note, 'вернули перевод');
  assert.equal((await pg.query(CHECKIN_SQL, ['trtickt002', null, 'Дверь'])).rows.length, 0);

  // переоформление: новая бронь → переименовать
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-tr', oid: 'ord_tr_ren', tids: ['trtickt005'], names: ['Старое Имя'], ages: ['adult'],
    provider: 'transfer', hold: 180, code: 'PX-REN1',
  }));
  const r = await pg.query(RENAME_SQL, ['trtickt005', 'Новое Имя']);
  assert.equal(r.rows[0].holder_name, 'Новое Имя');
  assert.equal((await pg.query(RENAME_SQL, ['trtickt001', 'Нельзя'])).rows.length, 0); // уже прошёл
});

test('скрытая волна: сайту недоступна, кассе — доступна', async () => {
  const site = await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-tr', waveNo: 9, oid: 'ord_hid_1', tids: ['hiddentk01'], names: ['С сайта'], ages: ['adult'],
    provider: 'transfer', hold: 180, code: 'PX-HID1', hidden: false,
  }));
  assert.equal(site.rows[0].created, 0);
  const door = await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-tr', waveNo: 9, oid: 'ord_hid_2', tids: ['hiddentk02'], names: ['Гостевой'], ages: ['adult'],
    provider: 'door', hidden: true,
  }));
  assert.equal(door.rows[0].created, 1);
  assert.equal(door.rows[0].price_rub, 0);
  const o = (await pg.query(`SELECT status, amount_rub FROM orders WHERE id='ord_hid_2'`)).rows[0];
  assert.equal(o.status, 'paid');
  assert.equal(o.amount_rub, 0);
});

test('SOURCES_SQL: продажи по меткам источников, оплаченные отдельно от ожидающих', async () => {
  await pg.query(ORDER_SQL, [
    1, 'ev-tr', 9, 'ord_src_1', 'Промо Гость', '+79990000001', null, JSON.stringify({ src: 'promo-lev' }),
    ['srctickt01'], ['Промо Гость'], ['adult'], 'door', 180, null, true,
  ]);
  const rows = (await pg.query(SOURCES_SQL, ['ev-tr'])).rows;
  const lev = rows.find((r) => r.src === 'promo-lev');
  assert.equal(lev.paid, 1);
  assert.equal(lev.pending, 0);
  const site = rows.find((r) => r.src === 'site');
  assert.ok(site.paid >= 1);
  assert.ok(site.pending >= 1); // ord_tr_ren ещё ждёт оплаты
});

test('«Я перевёл»: одно заявление за 10 минут; сгоревшую бронь тоже можно заявить', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, ends_at, age_rating, status)
     VALUES ('ev-cl', 'CLAIM PARTY', 'orenburg', 'лофт', now() + interval '3 days', now() + interval '3 days 7 hours', 18, 'onsale')`
  );
  await pg.query(`INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES ('ev-cl', 1, 'Проходка', 800, 3)`);
  await pg.query(ORDER_SQL, orderParams({
    qty: 2, eventId: 'ev-cl', oid: 'ord_cl_live', tids: ['cltickt001', 'cltickt002'], names: ['Аня Б', 'Боря В'],
    ages: ['adult', 'adult'], provider: 'transfer', hold: 60, code: 'PX-CL01',
  }));
  const first = (await pg.query(CLAIM_SQL, ['ord_cl_live'])).rows;
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'pending');
  assert.equal((await pg.query(CLAIM_SQL, ['ord_cl_live'])).rows.length, 0, 'повторное «Я перевёл» сразу — без второго уведомления');
  // бронь сгорела по сроку, гость перевёл позже и нажал кнопку
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-cl', oid: 'ord_cl_late', tids: ['cltickt003'], names: ['Вера Г'],
    ages: ['adult'], provider: 'transfer', hold: -1, code: 'PX-CL02',
  }));
  assert.deepEqual((await pg.query(EXPIRE_SQL)).rows.map((r) => r.id), ['ord_cl_late']);
  const late = (await pg.query(CLAIM_SQL, ['ord_cl_late'])).rows;
  assert.equal(late.length, 1);
  assert.equal(late[0].status, 'expired');
  // владелец видит её среди ожидающих, со статусом
  const pend = (await pg.query(PENDING_SQL, ['ev-cl'])).rows;
  assert.equal(pend.find((r) => r.id === 'ord_cl_late').status, 'expired');
  // «Не пришло» по сгоревшей — закрываем без возврата мест (они уже вернулись)
  const soldBefore = (await pg.query(`SELECT sold FROM price_waves WHERE event_id = 'ev-cl'`)).rows[0].sold;
  assert.equal((await pg.query(CLOSE_EXPIRED_SQL, ['ord_cl_late'])).rows.length, 1);
  assert.equal((await pg.query(`SELECT status FROM orders WHERE id = 'ord_cl_late'`)).rows[0].status, 'cancelled');
  assert.equal((await pg.query(`SELECT status FROM tickets WHERE id = 'cltickt003'`)).rows[0].status, 'cancelled');
  assert.equal((await pg.query(`SELECT sold FROM price_waves WHERE event_id = 'ev-cl'`)).rows[0].sold, soldBefore);
  assert.equal((await pg.query(CLOSE_EXPIRED_SQL, ['ord_cl_live'])).rows.length, 0, 'живую бронь так не закрыть');
});

test('CONFIRM сгоревшей брони: места возвращаются, если есть; нет мест — ничего не меняется', async () => {
  // ev-cl: квота 3, живая бронь держит 2 — свободно 1
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-cl', oid: 'ord_cl_one', tids: ['cltickt004'], names: ['Гена Д'],
    ages: ['adult'], provider: 'transfer', hold: -1, code: 'PX-CL03',
  }));
  await pg.query(EXPIRE_SQL);
  const ok = (await pg.query(CONFIRM_SQL, ['ord_cl_one', 'Максим', 'transfer'])).rows;
  assert.equal(ok.length, 1);
  assert.equal(ok[0].was, 'expired');
  assert.equal((await pg.query(`SELECT status FROM tickets WHERE id = 'cltickt004'`)).rows[0].status, 'active');
  assert.equal((await pg.query(`SELECT sold FROM price_waves WHERE event_id = 'ev-cl'`)).rows[0].sold, 3);
  // волна полна: ещё одна сгоревшая бронь не подтверждается и не переполняет квоту
  await pg.query(`UPDATE price_waves SET quota = 4 WHERE event_id = 'ev-cl'`);
  await pg.query(ORDER_SQL, orderParams({
    qty: 1, eventId: 'ev-cl', oid: 'ord_cl_two', tids: ['cltickt005'], names: ['Даша Е'],
    ages: ['adult'], provider: 'transfer', hold: -1, code: 'PX-CL04',
  }));
  await pg.query(EXPIRE_SQL);
  await pg.query(`UPDATE price_waves SET quota = 3 WHERE event_id = 'ev-cl'`);
  assert.equal((await pg.query(CONFIRM_SQL, ['ord_cl_two', 'Максим', null])).rows.length, 0);
  assert.equal((await pg.query(`SELECT status FROM orders WHERE id = 'ord_cl_two'`)).rows[0].status, 'expired');
  assert.equal((await pg.query(`SELECT sold FROM price_waves WHERE event_id = 'ev-cl'`)).rows[0].sold, 3);
  // повторное подтверждение уже оплаченной — пусто, места не списываются дважды
  assert.equal((await pg.query(CONFIRM_SQL, ['ord_cl_one', 'Максим', null])).rows.length, 0);
  assert.equal((await pg.query(`SELECT sold FROM price_waves WHERE event_id = 'ev-cl'`)).rows[0].sold, 3);
});

test('EXPIRE: заявленная «Я перевёл» бронь не держит места дольше самой ночи', async () => {
  // ночь кончилась, а владелец так и не нажал «Пришло»
  await pg.query(`UPDATE events SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = 'ev-cl'`);
  const gone = (await pg.query(EXPIRE_SQL)).rows.map((r) => r.id);
  assert.deepEqual(gone, ['ord_cl_live']);
  assert.equal((await pg.query(`SELECT status FROM orders WHERE id = 'ord_cl_live'`)).rows[0].status, 'expired');
  // ещё 48 часов она видна владельцу: деньги могли прийти
  assert.ok((await pg.query(PENDING_SQL, ['ev-cl'])).rows.some((r) => r.id === 'ord_cl_live'));
});

test('NEXT_WAVE_FOR_SQL: волна, где хватит мест на всю компанию, а не первая с местами', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev-nw', 'NEXT WAVE', 'orenburg', 'клуб', now() + interval '5 days', 18, 'onsale')`
  );
  await pg.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, sold, public) VALUES
     ('ev-nw', 1, 'Первая', 500, 10, 9, true), ('ev-nw', 2, 'Вторая', 700, 10, 0, true), ('ev-nw', 3, 'Скрытая', 1, 50, 0, false)`
  );
  assert.equal((await pg.query(NEXT_WAVE_SQL, ['ev-nw'])).rows[0].wave_no, 1);
  assert.equal((await pg.query(NEXT_WAVE_FOR_SQL, ['ev-nw', 3])).rows[0].wave_no, 2);
  assert.equal((await pg.query(NEXT_WAVE_FOR_SQL, ['ev-nw', 11])).rows.length, 0, 'скрытая волна гостю не предлагается');
});

test('nightCheck: проходка на другую ночь — рано или поздно, в окне — ок', () => {
  const start = Date.parse('2026-10-17T17:00:00Z');
  const end = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(nightCheck(start, end, start - 7 * 3600_000), 'early');
  assert.equal(nightCheck(start, end, start - 5 * 3600_000), 'ok');
  assert.equal(nightCheck(start, end, end + 5 * 3600_000), 'ok');
  assert.equal(nightCheck(start, end, end + 7 * 3600_000), 'late');
  // без конца ночи — 8 часов от старта
  assert.equal(nightCheck(start, null, start + 13 * 3600_000), 'ok');
  assert.equal(nightCheck(start, null, start + 15 * 3600_000), 'late');
});
