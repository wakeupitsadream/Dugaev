// Фоновые задачи: напоминание о брони, которая скоро сгорит, и лист
// ожидания распроданной ночи. Bot API подменён — ловим сообщения, в сеть
// ничего не уходит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_PGLITE = '1';
process.env.ADMIN_KEY = 'adm-tick';
process.env.TICKET_SECRET = 'tick-secret-0123456789abcdef';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
process.env.TELEGRAM_CHAT_ID = '9001';
process.env.TG_WEBHOOK_SECRET = 'tick-hook-secret';
delete process.env.PAYMENT_MODE;

const sentTg = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
    sentTg.push({ method: u.split('/').pop(), payload: JSON.parse(init.body || '{}') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentTg.length } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const { db, ensureSchema } = await import('../api/_lib/db.js');
const { runTick } = await import('../api/_lib/tick.js');
const { tgApi, tgCall } = await import('../api/_lib/tg.js');
const { handleUpdate } = await import('../api/tg-webhook.js');
const { default: seed } = await import('../api/seed.js');
const { ORDER_SQL, CANCEL_SQL } = await import('../api/_lib/queries.js');

const deps = () => ({ sql: db(), tg: tgApi, call: tgCall, nowMs: Date.now(), origin: 'https://proxject.ru' });
const toChat = (chat) => sentTg.filter((x) => x.method === 'sendMessage' && String(x.payload.chat_id) === String(chat));
let seq = 0;
const book = async (eventId, { chat = null, qty = 1, provider = 'transfer', hold = 60, wave = 1 } = {}) => {
  const n = ++seq;
  const id = `ord_tick${String(n).padStart(6, '0')}`;
  const tickets = Array.from({ length: qty }, (_, i) => `tk${String(n).padStart(4, '0')}x${String(i).padStart(3, '0')}`);
  const r = (await db().query(ORDER_SQL, [
    qty, eventId, wave, id, `Гость ${n}`, `+7916${String(1000000 + n).slice(-7)}`, null, null,
    tickets, tickets.map((_, i) => `Гость ${n}-${i}`), tickets.map(() => 'adult'), provider, hold,
    provider === 'transfer' ? `PX-T${String(n).padStart(3, '0')}` : null, false,
  ]))[0];
  assert.equal(r.created, qty, 'бронь создана');
  if (chat) await db().query(`UPDATE orders SET tg_chat_id = $1 WHERE id = $2`, [chat, id]);
  return id;
};
// бронь «сделана давно и сгорит через N минут»
const age = (id, { madeAgoMin, expiresInMin }) => db().query(
  `UPDATE orders SET created_at = now() - ($2::int * interval '1 minute'), expires_at = now() + ($3::int * interval '1 minute') WHERE id = $1`,
  [id, madeAgoMin, expiresInMin]
);

before(async () => {
  await ensureSchema(db());
  await db().query(
    `INSERT INTO events (id, title, city, venue, address, starts_at, ends_at, age_rating, status, secret) VALUES
     ('ev-tick', 'TICK NIGHT', 'orenburg', 'Лофт', 'Советская, 10', now() + interval '5 days', now() + interval '5 days 7 hours', 18, 'onsale', false),
     ('ev-full', 'FULL NIGHT', 'orenburg', 'Лофт', 'Советская, 10', now() + interval '6 days', now() + interval '6 days 7 hours', 18, 'onsale', false)`
  );
  await db().query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public) VALUES
     ('ev-tick', 1, 'Проходка', 900, 50, true),
     ('ev-full', 1, 'Проходка', 1000, 2, true), ('ev-full', 2, 'На входе', 1500, 10, false)`
  );
});

test('напоминание: за полчаса до сгорания — в чат брони, один раз, с реквизитами и «Я перевёл»', async () => {
  const due = await book('ev-tick', { chat: 7001, qty: 2 });
  await age(due, { madeAgoMin: 40, expiresInMin: 20 });
  const fresh = await book('ev-tick', { chat: 7002 }); // только что оформлена — рано
  await age(fresh, { madeAgoMin: 2, expiresInMin: 20 });
  const later = await book('ev-tick', { chat: 7003 }); // сгорит через два часа — рано
  await age(later, { madeAgoMin: 60, expiresInMin: 120 });
  const claimed = await book('ev-tick', { chat: 7004 }); // «Я перевёл» уже нажато
  await age(claimed, { madeAgoMin: 40, expiresInMin: 20 });
  await db().query(`UPDATE orders SET claimed_at = now() WHERE id = $1`, [claimed]);
  const noChat = await book('ev-tick'); // с сайта, бот не подключён — писать некуда
  await age(noChat, { madeAgoMin: 40, expiresInMin: 20 });

  sentTg.length = 0;
  const r = await runTick(deps(), { force: true });
  assert.equal(r.reminded, 1);
  const msg = toChat(7001);
  assert.equal(msg.length, 1);
  assert.match(msg[0].payload.text, /^⏳ Бронь <b>PX-T\d{3}<\/b> сгорит через 2\d минут[ыу]? — в \d{2}:\d{2}\./);
  assert.match(msg[0].payload.text, /2 проходки на TICK NIGHT/);
  assert.match(msg[0].payload.text, /Сумма: <b>1 800 ₽<\/b>/);
  assert.match(msg[0].payload.text, /Код брони в комментарии: <code>PX-T\d{3}<\/code>/);
  assert.equal(msg[0].payload.parse_mode, 'HTML');
  assert.equal(msg[0].payload.reply_markup.inline_keyboard[0][0].callback_data, `claim:${due}`);
  for (const chat of [7002, 7003, 7004]) assert.equal(toChat(chat).length, 0, `чат ${chat} без напоминания`);

  // второй запуск — повторно не пишем
  sentTg.length = 0;
  const again = await runTick(deps(), { force: true });
  assert.equal(again.reminded, 0);
  assert.equal(toChat(7001).length, 0);
});

test('чаще раза в минуту задачи не запускаются, кто бы ни звал', async () => {
  const first = await runTick(deps());
  const second = await runTick(deps());
  assert.ok(!first.skipped || first.skipped === 'recent');
  assert.equal(second.skipped, 'recent');
});

test('лист ожидания: распроданная ночь — встать по ссылке с сайта, места есть — сразу к брони', async () => {
  const D = { ...deps(), notify: async () => null, extract: async () => null, extractAvailable: false, autoPublish: false };
  const start = (chat, text) => handleUpdate({ update_id: 50_000 + (++seq), message: { message_id: seq, chat: { id: chat, type: 'private' }, from: { id: chat }, text } }, D);

  // пока места есть, в лист не ставим — зовём бронировать
  let r = await start(8001, '/start wl_ev-full');
  assert.equal(r.done, 'waitlist_has_seats');
  assert.match(toChat(8001).at(-1).payload.text, /места ещё есть/);

  // ночь распродали (касса на входе не в счёт — она скрытая)
  await book('ev-full', { qty: 2, provider: 'door' });
  sentTg.length = 0;
  r = await start(8001, '/start wl_ev-full');
  assert.equal(r.done, 'waitlist_joined');
  assert.match(toChat(8001).at(-1).payload.text, /ты в листе ожидания на <b>FULL NIGHT<\/b>/);
  assert.equal(toChat(8001).at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, 'wlx:ev-full');
  r = await start(8001, '/start wl_ev-full');
  assert.equal(r.done, 'waitlist_already');
  for (const chat of [8002, 8003]) assert.equal((await start(chat, '/start wl_ev-full')).done, 'waitlist_joined');

  // «Забронировать» в боте на распроданную ночь — кнопка листа ожидания
  r = await handleUpdate({ update_id: 50_000 + (++seq), callback_query: { id: 'cb1', from: { id: 8004 }, message: { message_id: 1, chat: { id: 8004 } }, data: 'buy:ev-full' } }, D);
  assert.equal(r.done, 'wizard_sold_out');
  assert.equal(toChat(8004).at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, 'wl:ev-full');

  // выйти из листа
  r = await handleUpdate({ update_id: 50_000 + (++seq), callback_query: { id: 'cb2', from: { id: 8003 }, message: { message_id: 2, chat: { id: 8003 } }, data: 'wlx:ev-full' } }, D);
  assert.equal(r.done, 'waitlist_left');
  const left = await db().query(`SELECT chat_id FROM waitlist WHERE event_id = 'ev-full' ORDER BY created_at`);
  assert.deepEqual(left.map((x) => Number(x.chat_id)), [8001, 8002]);
});

test('лист ожидания: освободилось место — пишем ждущим по очереди, один раз; кто уже взял бронь — без сообщения', async () => {
  // мест нет — никому не пишем
  sentTg.length = 0;
  let r = await runTick(deps(), { force: true });
  assert.equal(r.waitlist, 0);

  // 8002 тем временем взял бронь сам (пусть и в другой волне — главное, на эту ночь)
  await db().query(`UPDATE price_waves SET quota = quota + 1 WHERE event_id = 'ev-full' AND wave_no = 1`);
  await book('ev-full', { chat: 8002 });
  // освободилось место: отменили неоплаченную бронь
  const extra = await book('ev-full', { qty: 1 }).catch(() => null);
  assert.equal(extra, null, 'мест не было');
  await db().query(`UPDATE price_waves SET quota = quota + 1 WHERE event_id = 'ev-full' AND wave_no = 1`);
  const pend = await book('ev-full');
  await db().query(CANCEL_SQL, [pend]);

  sentTg.length = 0;
  r = await runTick(deps(), { force: true });
  assert.equal(r.waitlist, 1);
  const msg = toChat(8001);
  assert.equal(msg.length, 1);
  assert.match(msg[0].payload.text, /освободились места/);
  assert.deepEqual(msg[0].payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data || b.url), ['buy:ev-full', 'https://proxject.ru/e/ev-full?src=waitlist']);
  assert.equal(toChat(8002).length, 0, 'у 8002 уже есть бронь');

  // второй раз тому же не пишем, даже если место ещё свободно
  sentTg.length = 0;
  r = await runTick(deps(), { force: true });
  assert.equal(r.waitlist, 0);
  // встал снова — снова в очереди
  const D = { ...deps(), notify: async () => null, extract: async () => null, extractAvailable: false, autoPublish: false };
  const again = await handleUpdate({ update_id: 50_000 + (++seq), message: { message_id: seq, chat: { id: 8001, type: 'private' }, from: { id: 8001 }, text: '/start wl_ev-full' } }, D);
  assert.equal(again.done, 'waitlist_has_seats', 'место ещё свободно — сразу к брони, а не в очередь');
});

test('планировщик: GET /api/seed?tick=1 без ключа отвечает и не бежит чаще раза в минуту', async () => {
  const res = () => ({
    code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(j) { this.body = j; },
    send(b) { this.body = b; },
    end() {},
    setHeader(k, v) { this.headers[k] = v; },
  });
  await db().query(`UPDATE px_meta SET updated_at = now() - interval '5 minutes' WHERE k = 'tick'`);
  const a = res();
  await seed({ method: 'GET', headers: { host: 'proxject.ru' }, query: { tick: '1' } }, a);
  assert.equal(a.code, 200, JSON.stringify(a.body));
  assert.equal(a.body.ran, true);
  const b = res();
  await seed({ method: 'GET', headers: { host: 'proxject.ru' }, query: { tick: '1' } }, b);
  assert.equal(b.code, 200);
  assert.equal(b.body.ran, false);
  // без tick=1 — по-прежнему только POST с ключом
  const c = res();
  await seed({ method: 'GET', headers: {}, query: {} }, c);
  assert.equal(c.code, 405);
});

test('вебхук бота попутно отправляет созревшее напоминание — без планировщика', async () => {
  const { default: webhook } = await import('../api/tg-webhook.js');
  const res = () => ({
    code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(j) { this.body = j; },
    send(b) { this.body = b; },
    end() {},
    setHeader(k, v) { this.headers[k] = v; },
  });
  // напоминание «созрело», планировщика нет — его отправит любой апдейт бота
  const due = await book('ev-tick', { chat: 7101 });
  await age(due, { madeAgoMin: 40, expiresInMin: 15 });
  await db().query(`UPDATE px_meta SET updated_at = now() - interval '5 minutes' WHERE k = 'tick'`);
  sentTg.length = 0;
  const r = res();
  await webhook({
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'tick-hook-secret', host: 'proxject.ru' },
    query: {},
    body: { update_id: 90_001, message: { message_id: 1, chat: { id: 7102, type: 'private' }, from: { id: 7102 }, text: '/start' } },
  }, r);
  assert.equal(r.code, 200);
  assert.ok(toChat(7102).length >= 1, 'гостю ответили');
  assert.equal(toChat(7101).length, 1, 'напоминание ушло попутно');
  assert.match(toChat(7101)[0].payload.text, /^⏳ Бронь/);
});
