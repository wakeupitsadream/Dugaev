import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, pendingItems, applyResults } from '../assets/outbox.js';

test('enqueue добавляет и дедуплицирует по ticketId', () => {
  let list = [];
  list = enqueue(list, { ticketId: 'a', by: 'Артём', at: 't1' });
  list = enqueue(list, { ticketId: 'b', by: 'Артём', at: 't2' });
  list = enqueue(list, { ticketId: 'a', by: 'Кто-то', at: 't3' }); // дубль
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.ticketId), ['a', 'b']);
});

test('enqueue игнорирует мусор', () => {
  assert.equal(enqueue([], null).length, 0);
  assert.equal(enqueue([], {}).length, 0);
  assert.equal(enqueue([], { ticketId: '' }).length, 0);
});

test('applyResults убирает только успешные, порядок сохраняется', () => {
  let list = [];
  for (const id of ['a', 'b', 'c']) list = enqueue(list, { ticketId: id });
  list = applyResults(list, [{ ticketId: 'a', ok: true }, { ticketId: 'b', ok: false }]);
  assert.deepEqual(list.map((e) => e.ticketId), ['b', 'c']);
});

test('повторная синхронизация идемпотентна', () => {
  let list = enqueue([], { ticketId: 'a' });
  list = applyResults(list, [{ ticketId: 'a', ok: true }]);
  list = applyResults(list, [{ ticketId: 'a', ok: true }]);
  assert.equal(list.length, 0);
});

test('pendingItems возвращает копию', () => {
  const list = enqueue([], { ticketId: 'a' });
  const items = pendingItems(list);
  items.pop();
  assert.equal(list.length, 1);
});
