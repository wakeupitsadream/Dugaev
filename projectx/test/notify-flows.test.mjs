// Сообщения в Telegram из панели: публикация ночи — владельцу (ссылка и
// кнопка рассылки), аннулирование, возврат и переоформление проходки —
// покупателю в его чат с ботом. Bot API подменён: ловим запросы, в сеть
// ничего не уходит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_PGLITE = '1';
process.env.ADMIN_KEY = 'adm-notify';
process.env.TICKET_SECRET = 'notify-secret-0123456789abcdef';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
process.env.TELEGRAM_CHAT_ID = '9001';
delete process.env.PAYMENT_MODE;

const sentTg = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
    const method = u.split('/').pop();
    sentTg.push({ method, payload: JSON.parse(init.body || '{}') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentTg.length } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const { db, ensureSchema } = await import('../api/_lib/db.js');
const { default: upsert } = await import('../api/event-upsert.js');
const { default: walkin } = await import('../api/walkin.js');
const { default: stats } = await import('../api/stats.js');
const { ORDER_SQL, ADMIN_EVENTS_SQL } = await import('../api/_lib/queries.js');

const res = () => ({
  code: 0, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(j) { this.body = j; },
  send(b) { this.body = b; },
  end() {},
  setHeader(k, v) { this.headers[k] = v; },
});
const ADMIN = { 'x-admin-key': 'adm-notify', host: 'proxject.ru' };
const call = async (handler, body) => {
  const r = res();
  await handler({ method: 'POST', headers: ADMIN, query: {}, body }, r);
  return r;
};
const toChat = (chat) => sentTg.filter((x) => x.method === 'sendMessage' && String(x.payload.chat_id) === String(chat));

before(async () => {
  await ensureSchema(db());
  await db().query(`INSERT INTO tg_subs (chat_id, active, source) VALUES (5551, true, 'bot'), (5552, true, 'site')`);
});

test('публикация из панели: владельцу в Telegram ссылка на ночь и кнопка «Разослать»', async () => {
  const day = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
  const form = {
    title: 'NOTIFY NIGHT', date: day, timeStart: '22:00', timeEnd: '04:00', ageRating: 18, venue: 'Лофт',
    address: 'Советская, 10', city: 'orenburg', waves: [{ waveNo: 1, name: 'Проходка', priceRub: 900, quota: 50 }],
  };
  sentTg.length = 0;
  const draft = await call(upsert, { ...form, status: 'draft' });
  assert.equal(draft.code, 200);
  assert.equal(draft.body.published, false);
  assert.equal(toChat(9001).length, 0, 'черновик — без сообщения');
  const pub = await call(upsert, { ...form, id: draft.body.event_id, status: 'onsale' });
  assert.equal(pub.code, 200);
  assert.equal(pub.body.published, true);
  assert.equal(pub.body.notified, true);
  const msg = toChat(9001).at(-1).payload;
  assert.match(msg.text, /«NOTIFY NIGHT» в продаже: https:\/\/proxject\.ru\/e\//);
  assert.match(msg.text, /Разослать анонс подписчикам бота \(2\)/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, `bc:${draft.body.event_id}`);
  // повторное сохранение уже опубликованной ночи — без второго сообщения
  sentTg.length = 0;
  const again = await call(upsert, { ...form, id: draft.body.event_id, status: 'onsale', descr: 'правка' });
  assert.equal(again.body.published, false);
  assert.equal(toChat(9001).length, 0);
});

test('аннулирование, возврат и переоформление проходки: покупателю сообщение в бот', async () => {
  const ev = (await db().query(`SELECT id FROM events WHERE title = 'NOTIFY NIGHT'`))[0].id;
  // оплаченный заказ на двоих, покупатель привязал бота
  await db().query(ORDER_SQL, [
    2, ev, 1, 'ord_notify0001', 'Покупатель Один', '+79160001122', null, null,
    ['ntfytkt001', 'ntfytkt002'], ['Покупатель Один', 'Друг Два'], ['adult', 'adult'], 'door', 180, null, false,
  ]);
  await db().query(`UPDATE orders SET tg_chat_id = 7007 WHERE id = 'ord_notify0001'`);

  sentTg.length = 0;
  const ren = await call(walkin, { action: 'rename', ticket_id: 'ntfytkt002', name: 'Подруга Три', by: 'Максим' });
  assert.equal(ren.code, 200, JSON.stringify(ren.body));
  assert.equal(ren.body.notified, true);
  assert.match(toChat(7007).at(-1).payload.text, /переоформлена: была на Друг Два, теперь на Подруга Три/);

  const ref = await call(walkin, { action: 'void', ticket_id: 'ntfytkt002', status: 'refunded', note: 'не сможет прийти.', by: 'Максим' });
  assert.equal(ref.code, 200, JSON.stringify(ref.body));
  assert.equal(ref.body.notified, true);
  const refMsg = toChat(7007).at(-1).payload.text;
  assert.match(refMsg, /Проходка «NOTIFY NIGHT» на имя Подруга Три аннулирована, деньги за неё возвращены\. Причина: не сможет прийти\. QR по ней больше не действует/);

  const rev = await call(walkin, { action: 'void', ticket_id: 'ntfytkt001', status: 'revoked', by: 'Максим' });
  assert.equal(rev.code, 200, JSON.stringify(rev.body));
  const revMsg = toChat(7007).at(-1).payload.text;
  assert.match(revMsg, /^⛔️ Проходка «NOTIFY NIGHT» на имя Покупатель Один аннулирована\. QR по ней больше не действует/);
  assert.doesNotMatch(revMsg, /Причина/);
  // владельцу — своя строка о каждом действии
  assert.ok(toChat(9001).some((x) => /возвращена/.test(x.payload.text)));
});

test('бот у покупателя не подключён — честно «не написали»', async () => {
  const ev = (await db().query(`SELECT id FROM events WHERE title = 'NOTIFY NIGHT'`))[0].id;
  await db().query(ORDER_SQL, [
    1, ev, 1, 'ord_notify0002', 'Без Бота', '+79160003344', null, null,
    ['ntfytkt003'], ['Без Бота'], ['adult'], 'door', 180, null, false,
  ]);
  sentTg.length = 0;
  const r = await call(walkin, { action: 'void', ticket_id: 'ntfytkt003', status: 'revoked', by: 'Максим' });
  assert.equal(r.code, 200);
  assert.equal(r.body.notified, false);
  assert.equal(sentTg.filter((x) => String(x.payload.chat_id) !== '9001').length, 0);
});

test('оплата не пришла: бронь снимается целиком — места назад, покупателю честное сообщение', async () => {
  const ev = (await db().query(`SELECT id FROM events WHERE title = 'NOTIFY NIGHT'`))[0].id;
  const sold = async () => (await db().query(`SELECT sold FROM price_waves WHERE event_id = $1 AND wave_no = 1`, [ev]))[0].sold;
  await db().query(ORDER_SQL, [
    2, ev, 1, 'ord_notify0003', 'Ошибочный Платёж', '+79160005566', null, null,
    ['ntfytkt004', 'ntfytkt005'], ['Ошибочный Платёж', 'Друг Пять'], ['adult', 'adult'], 'door', 180, null, false,
  ]);
  await db().query(`UPDATE orders SET tg_chat_id = 7008, pay_code = 'PX-OOPS' WHERE id = 'ord_notify0003'`);
  const was = await sold();
  sentTg.length = 0;
  const r = await call(walkin, { action: 'void', ticket_id: 'ntfytkt005', status: 'unpaid', note: 'перевода нет в выписке', by: 'Максим' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.tickets, 2);
  assert.equal(r.body.notified, true);
  assert.match(toChat(7008).at(-1).payload.text, /^⛔️ Бронь PX-OOPS на «NOTIFY NIGHT» снята: оплата по ней не пришла\. Причина: перевода нет в выписке\. QR по этим проходкам больше не действует\. Если ты переводил — пришли сюда чек/);
  assert.ok(toChat(9001).some((x) => /Бронь PX-OOPS снята: оплата не пришла \(2 шт\.\)/.test(x.payload.text)));
  assert.equal((await db().query(`SELECT status FROM orders WHERE id = 'ord_notify0003'`))[0].status, 'cancelled');
  assert.deepEqual((await db().query(`SELECT status FROM tickets WHERE order_id = 'ord_notify0003' ORDER BY id`)).map((x) => x.status), ['cancelled', 'cancelled']);
  assert.equal(await sold(), was - 2, 'оба места вернулись в продажу');
  // второй раз снимать нечего
  const again = await call(walkin, { action: 'void', ticket_id: 'ntfytkt004', status: 'unpaid', by: 'Максим' });
  assert.equal(again.code, 409);
});

test('выручка: возврат вычитается, «без возврата» остаётся, снятая бронь не считается — в сводке панели и списке ночей', async () => {
  const ev = (await db().query(`SELECT id FROM events WHERE title = 'NOTIFY NIGHT'`))[0].id;
  const amount = async (id) => (await db().query(`SELECT amount_rub FROM orders WHERE id = $1`, [id]))[0].amount_rub;
  const a1 = await amount('ord_notify0001'); // 2 проходки: одна возвращена, одна снята без возврата
  const a2 = await amount('ord_notify0002'); // 1 проходка, снята без возврата
  assert.ok(a1 > 0 && a2 > 0);
  const expected = a1 - a1 / 2 + a2; // ord_notify0003 — оплата не пришла, её нет
  const r = res();
  await stats({ method: 'GET', headers: ADMIN, query: { event_id: ev } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.revenue_rub, expected);
  assert.deepEqual(r.body.refunded, { n: 1, rub: a1 / 2 });
  const list = res();
  await stats({ method: 'GET', headers: ADMIN, query: { include_drafts: '1' } }, list);
  assert.equal(list.body.events.find((e) => e.id === ev).revenue_rub, expected);
  const adm = (await db().query(ADMIN_EVENTS_SQL)).find((e) => e.id === ev);
  assert.equal(adm.revenue, expected);
});
