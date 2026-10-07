// Сквозные сценарии через обработчики API на настоящем Postgres (PGlite):
// бронь с сайта, «Я перевёл» по сгоревшей брони, страница проходки, вход
// по проходке на другую ночь.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_PGLITE = '1';
process.env.ADMIN_KEY = 'adm-flows';
process.env.DOOR_KEY = 'door-flows';
process.env.TICKET_SECRET = 'flows-secret-0123456789abcdef';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.PAYMENT_MODE;

const { db, ensureSchema } = await import('../api/_lib/db.js');
const { default: order } = await import('../api/order.js');
const { default: ticket } = await import('../api/ticket.js');
const { default: checkin } = await import('../api/checkin.js');
const { default: verify } = await import('../api/verify.js');
const { parseOrderStart } = await import('../api/_lib/booking.js');
const { EXPIRE_SQL, CONFIRM_SQL, VOID_SQL } = await import('../api/_lib/queries.js');

const res = () => ({
  code: 0, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(j) { this.body = j; },
  send(b) { this.body = b; },
  end() {},
  setHeader(k, v) { this.headers[k] = v; },
});
const call = async (handler, req) => {
  const r = res();
  await handler({ headers: {}, query: {}, ...req }, r);
  return r;
};
const DOOR = { 'x-admin-key': 'door-flows' };
let ip = 0;
const book = (eventId, waveNo, names, buyer = names[0]) => call(order, {
  method: 'POST',
  // у каждой брони свой адрес: лимит «3 брони с адреса за полчаса» здесь не проверяем
  headers: { 'x-forwarded-for': `10.0.0.${++ip}` },
  body: {
    event_id: eventId, wave_no: waveNo, consent: true,
    buyer: { name: buyer, phone: `+7916000${String(1000 + ip).slice(-4)}` },
    attendees: names.map((name) => ({ name })),
  },
});
const tokenOf = (url) => url.replace(/^\/t\//, '');

before(async () => {
  const sql = db();
  await ensureSchema(sql);
  await sql.query(
    `INSERT INTO events (id, title, city, venue, address, starts_at, ends_at, age_rating, status, secret) VALUES
     ('ev-api', 'API NIGHT', 'orenburg', 'Лофт', 'Советская, 10', now() + interval '5 days', now() + interval '5 days 7 hours', 18, 'onsale', false),
     ('ev-sec', 'SECRET NIGHT', 'orenburg', 'Тайное место', 'Тайная, 1', now() + interval '5 days', NULL, 18, 'onsale', true)`
  );
  await sql.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public) VALUES
     ('ev-api', 1, 'Первые', 500, 2, true), ('ev-api', 2, 'Вторая', 700, 3, true),
     ('ev-sec', 1, 'Проходка', 1000, 20, true)`
  );
});

test('сайт: компания не влезает в волну — предлагаем волну, где хватит мест на всех; нигде нет — потолок одной брони', async () => {
  const big = await book('ev-api', 1, ['Анна Один', 'Борис Два', 'Вика Три']);
  assert.equal(big.code, 409);
  assert.equal(big.body.error, 'wave_sold_out');
  assert.equal(big.body.next_wave.waveNo, 2, 'волна 1 на двоих — для троих сразу вторая');
  assert.equal(big.body.max_one, 3);
  const huge = await book('ev-api', 2, ['А Б', 'В Г', 'Д Е', 'Ж З']);
  assert.equal(huge.code, 409);
  assert.equal(huge.body.next_wave, null);
  assert.equal(huge.body.max_one, 3);
  assert.match(huge.body.message, /до 3/);
  const okr = await book('ev-api', 2, ['Анна Один', 'Борис Два']);
  assert.equal(okr.code, 200);
  assert.match(okr.body.pay_code, /^PX-/);
  // ссылка в бот подписана и ведёт ровно на эту бронь
  assert.equal(parseOrderStart(okr.body.bot_start), okr.body.order_id);
  assert.equal(parseOrderStart(okr.body.order_id), null);
});

test('«Я перевёл» с сайта: по сгоревшей брони принимается с пометкой, повтор — без второго уведомления, оплаченная — нет', async () => {
  const r = await book('ev-api', 1, ['Гена Четыре']);
  assert.equal(r.code, 200);
  const oid = r.body.order_id;
  await db().query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [oid]);
  await db().query(EXPIRE_SQL);
  const late = await call(order, { method: 'POST', body: { action: 'claim', order_id: oid } });
  assert.equal(late.code, 200);
  assert.equal(late.body.late, true);
  const again = await call(order, { method: 'POST', body: { action: 'claim', order_id: oid } });
  assert.equal(again.code, 200);
  assert.equal(again.body.repeated, true);
  await db().query(CONFIRM_SQL, [oid, 'тест', 'transfer']);
  const paid = await call(order, { method: 'POST', body: { action: 'claim', order_id: oid } });
  assert.equal(paid.code, 409);
  assert.equal(paid.body.status, 'paid');
});

test('страница проходки: адрес секретной ночи — только у живой оплаченной; ссылку в бот видит только покупатель', async () => {
  const r = await book('ev-sec', 1, ['Покупатель Один', 'Друг Два']);
  assert.equal(r.code, 200);
  const [mine, friend] = r.body.tickets.map((t) => tokenOf(t.url));
  let me = await call(ticket, { method: 'GET', query: { token: mine } });
  assert.equal(me.body.ticket.event.address, null, 'бронь без оплаты адрес секретной ночи не видит');
  assert.equal(parseOrderStart(me.body.ticket.order.botStart), r.body.order_id);
  const fr = await call(ticket, { method: 'GET', query: { token: friend } });
  assert.equal(fr.body.ticket.order.botStart, null, 'другу из компании — без ссылки на весь заказ');

  await db().query(CONFIRM_SQL, [r.body.order_id, 'тест', 'transfer']);
  me = await call(ticket, { method: 'GET', query: { token: mine } });
  assert.equal(me.body.ticket.event.address, 'Тайная, 1');
  assert.equal(me.body.ticket.order.botStart, null);
  // возврат проходки — адрес снова закрыт
  await db().query(VOID_SQL, [me.body.ticket.id, 'refunded', 'тест']);
  me = await call(ticket, { method: 'GET', query: { token: mine } });
  assert.equal(me.body.ticket.status, 'refunded');
  assert.equal(me.body.ticket.event.address, null);
});

test('вход: проходка на другую ночь — «не та ночь», впустить можно только явно; сканер видит дату', async () => {
  const r = await book('ev-api', 2, ['Олег Пять']);
  assert.equal(r.code, 200);
  await db().query(CONFIRM_SQL, [r.body.order_id, 'тест', 'transfer']);
  const token = tokenOf(r.body.tickets[0].url);
  // ночь через 5 дней — рано
  let c = await call(checkin, { method: 'POST', headers: DOOR, body: { token, by: 'Хостес' } });
  assert.equal(c.code, 409);
  assert.equal(c.body.error, 'wrong_night');
  assert.equal(c.body.night, 'early');
  assert.equal(c.body.event.title, 'API NIGHT');
  // ночь прошла неделю назад — поздно; сканер показывает это до нажатия «Впустить»
  await db().query(`UPDATE events SET starts_at = now() - interval '7 days', ends_at = now() - interval '7 days' + interval '7 hours' WHERE id = 'ev-api'`);
  const v = await call(verify, { method: 'GET', headers: DOOR, query: { token } });
  assert.equal(v.body.status, 'active');
  assert.equal(v.body.night, 'late');
  c = await call(checkin, { method: 'POST', headers: DOOR, body: { token, by: 'Хостес' } });
  assert.equal(c.body.night, 'late');
  const rows = await db().query(`SELECT checked_in_at FROM tickets WHERE id = $1`, [token.split('.')[0]]);
  assert.equal((rows.rows || rows)[0].checked_in_at, null, 'без «всё равно впустить» вход не отмечен');
  c = await call(checkin, { method: 'POST', headers: DOOR, body: { token, by: 'Хостес', force: true } });
  assert.equal(c.code, 200);
  assert.equal(c.body.first, true);
  // в свою ночь — без вопросов
  await db().query(`UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '6 hours' WHERE id = 'ev-api'`);
  const r2 = await book('ev-api', 1, ['Пётр Шесть']);
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  await db().query(CONFIRM_SQL, [r2.body.order_id, 'тест', 'transfer']);
  c = await call(checkin, { method: 'POST', headers: DOOR, body: { token: tokenOf(r2.body.tickets[0].url) } });
  assert.equal(c.code, 200);
  assert.equal(c.body.first, true);
});
