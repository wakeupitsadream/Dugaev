import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordersCsv, csvFileName, ORDER_COLUMNS } from '../assets/csv.js';

test('ordersCsv: BOM, «;», кавычки, дата в поясе площадки, способ по-русски', () => {
  const csv = ordersCsv([
    { paid_at: '2026-09-26T18:05:00.000Z', pay_code: 'PX-7F3K', amount_rub: 2000, qty: 2, buyer_name: 'Иван; "Петров"', buyer_phone: '+79161234567', provider: 'transfer', confirmed_by: 'Максим', src: 'promo-lev', id: 'ord_abc' },
    { paid_at: '2026-09-26T21:40:00.000Z', pay_code: null, amount_rub: 1500, qty: 1, buyer_name: 'Касса Гость', buyer_phone: 'касса', provider: 'door', confirmed_by: 'дверь · Хостес', src: 'door', id: 'ord_def' },
  ]);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], ORDER_COLUMNS.join(';'));
  assert.equal(lines[1], '26.09.2026 23:05;PX-7F3K;2000;2;"Иван; ""Петров""";+79161234567;перевод;Максим;promo-lev;ord_abc');
  assert.equal(lines[2], '27.09.2026 02:40;;1500;1;Касса Гость;;на входе;дверь · Хостес;door;ord_def');
});

test('ordersCsv: пустой список — только шапка; имя файла без мусора', () => {
  assert.equal(ordersCsv([]).trim().split('\r\n').length, 1);
  assert.equal(csvFileName('px-260926', Date.parse('2026-09-27T00:00:00Z')), 'oplaty-px-260926-2026-09-27.csv');
  assert.equal(csvFileName('../x y', Date.parse('2026-09-27T00:00:00Z')), 'oplaty-xy-2026-09-27.csv');
});
