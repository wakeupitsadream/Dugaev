// Ранний доступ для подписчиков бота, анонс «сначала себе» с отправкой по
// времени и /pay по коду. Боевые обработчики на PGlite, Bot API подменён —
// ловим сообщения, в сеть ничего не уходит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_PGLITE = '1';
process.env.ADMIN_KEY = 'adm-early';
process.env.TICKET_SECRET = 'early-secret-0123456789abcdef';
process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
process.env.TELEGRAM_CHAT_ID = '9001';
process.env.TG_WEBHOOK_SECRET = 'early-hook-secret';
delete process.env.PAYMENT_MODE;

const OWNER = 9001;
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
const { default: events } = await import('../api/events.js');
const { default: upsert } = await import('../api/event-upsert.js');
const { placeOrder } = await import('../api/_lib/order-core.js');
const { parseWhen, sendSlots, previewControls, scheduleBroadcast } = await import('../api/_lib/broadcast.js');

const notes = [];
const deps = (over = {}) => ({
  sql: db(), tg: tgApi, call: tgCall, nowMs: Date.now(), origin: 'https://px.test',
  notify: async (text, markup) => { notes.push({ text, markup }); return null; },
  sleep: async () => {},
  ...over,
});
const res = () => ({
  code: 0, body: null, headers: {},
  status(c) { this.code = c; return this; },
  json(j) { this.body = j; },
  send(b) { this.body = b; },
  end() {},
  setHeader(k, v) { this.headers[k] = v; },
});
const toChat = (chat) => sentTg.filter((x) => (x.method === 'sendMessage' || x.method === 'sendPhoto') && String(x.payload.chat_id) === String(chat));
const lastTo = (chat) => toChat(chat).at(-1)?.payload;
const textOf = (p) => (p ? p.text ?? p.caption ?? '' : '');
const buttons = (p) => (p?.reply_markup?.inline_keyboard || []).flat();
const button = (p, re) => buttons(p).find((b) => re.test(String(b.callback_data || '')));
let uid = 50_000;
const cb = (from, data, msgId = 1) => handleUpdate(
  { update_id: ++uid, callback_query: { id: `c${uid}`, data, from: { id: from, username: `u${from}` }, message: { chat: { id: from }, message_id: msgId, text: 'карточка' } } },
  deps()
);
const say = (from, text, extra = {}) => handleUpdate(
  { update_id: ++uid, message: { message_id: uid, chat: { id: from, type: 'private' }, from: { id: from }, text, ...extra } },
  deps()
);
const publicIds = async () => {
  const r = res();
  await events({ method: 'GET', headers: { host: 'px.test' }, query: {} }, r);
  assert.equal(r.code, 200);
  return r.body.events.map((e) => e.id);
};
// гость проходит мастер брони до сводки: количество → телефон → имена
async function wizardToSummary(chat, qty, names) {
  let r = await cb(chat, `qty:${qty}`);
  assert.equal(r.done, 'wizard_phone');
  r = await handleUpdate({ update_id: ++uid, message: { message_id: uid, chat: { id: chat, type: 'private' }, from: { id: chat }, contact: { phone_number: `7916${String(chat).padStart(7, '0')}`, user_id: chat } } }, deps());
  assert.equal(r.done, 'wizard_names');
  r = await say(chat, names.join('\n'));
  assert.equal(r.done, 'wizard_confirm');
  const go = button(lastTo(chat), /^book:go-/);
  assert.ok(go, 'в сводке кнопка брони');
  return go.callback_data;
}

before(async () => {
  await ensureSchema(db());
  await db().query(
    `INSERT INTO events (id, title, city, venue, address, starts_at, ends_at, age_rating, status) VALUES
     ('ev-early', 'EARLY NIGHT', 'orenburg', 'Лофт', 'Советская, 10', now() + interval '10 days', now() + interval '10 days 7 hours', 18, 'draft'),
     ('ev-early2', 'SECOND NIGHT', 'orenburg', 'Лофт', 'Советская, 10', now() + interval '24 days', now() + interval '24 days 7 hours', 18, 'draft')`
  );
  await db().query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public) VALUES
     ('ev-early', 1, 'Проходка', 900, 100, true), ('ev-early2', 1, 'Проходка', 1000, 100, true)`
  );
});

test('ранний доступ из бота: кнопка на черновике → варианты → «40 по 650» → закрытая волна, на сайте ночи нет, владельцу превью', async () => {
  sentTg.length = 0;
  let r = await cb(OWNER, 'early:ev-early');
  assert.equal(r.done, 'early_ask');
  const ask = lastTo(OWNER);
  assert.match(textOf(ask), /«EARLY NIGHT»/);
  assert.match(textOf(ask), /от 900 ₽/);
  assert.deepEqual(buttons(ask).map((b) => b.callback_data), ['eset:50x690-ev-early', 'eset:50x590-ev-early', 'eset:30x590-ev-early']);

  sentTg.length = 0;
  r = await say(OWNER, '40 по 650');
  assert.equal(r.done, 'early_open');
  assert.equal((await db().query(`SELECT status FROM events WHERE id = 'ev-early'`))[0].status, 'early');
  const w = (await db().query(`SELECT wave_no, name, price_rub, quota, public, early FROM price_waves WHERE event_id = 'ev-early' AND early`))[0];
  assert.deepEqual([Number(w.wave_no), w.name, Number(w.price_rub), Number(w.quota), w.public], [2, 'Ранний доступ', 650, 40, false]);
  // владелец видит ровно то, что получат подписчики, и пульт отправки
  const preview = toChat(OWNER).find((x) => /Ранний доступ для своих/.test(textOf(x.payload)));
  assert.ok(preview, 'превью раннего доступа');
  assert.match(textOf(preview.payload), /40 проходок по <b>650 ₽<\/b> — в открытой продаже будет от 900 ₽/);
  assert.equal(button(preview.payload, /^buy:/).callback_data, 'buy:ev-early');
  assert.equal(button(preview.payload, /^buy:/).text, '🔑 Забронировать за 650 ₽');
  const ctl = lastTo(OWNER);
  assert.match(textOf(ctl), /Так увидят подписчики \(0\)/);
  assert.equal(buttons(ctl)[0].callback_data, 'bcgo:e-ev-early');
  // сессия вопроса закрыта: следующий короткий текст — не параметры
  assert.equal((await db().query(`SELECT count(*)::int AS n FROM tg_sessions WHERE chat_id = $1`, [OWNER]))[0].n, 0);

  assert.ok(!(await publicIds()).includes('ev-early'), 'ночь в раннем доступе не видна на сайте');
  // карточка черновика: «Удалить» ночь в раннем доступе не трогает
  r = await cb(OWNER, 'del:ev-early');
  assert.equal(r.done, 'delete_blocked');
  assert.match(sentTg.filter((x) => x.method === 'answerCallbackQuery').at(-1).payload.text, /ранний доступ/);
});

test('гость без подписки: «Забронировать» → «подпишись»; «Подписаться и забронировать» → мастер по ранней цене, не больше 4 в одни руки', async () => {
  sentTg.length = 0;
  let r = await cb(7001, 'buy:ev-early');
  assert.equal(r.done, 'early_need_sub');
  assert.match(textOf(lastTo(7001)), /только для подписчиков/);
  assert.match(textOf(lastTo(7001)), /650 ₽/);
  assert.equal(button(lastTo(7001), /^esub:/).callback_data, 'esub:ev-early');

  r = await cb(7001, 'esub:ev-early');
  assert.equal(r.done, 'wizard_qty');
  assert.equal(r.early, true);
  const sub = (await db().query(`SELECT active, source FROM tg_subs WHERE chat_id = 7001`))[0];
  assert.deepEqual([sub.active, sub.source], [true, 'early']);
  assert.match(textOf(lastTo(7001)), /до 4/);
  assert.equal(buttons(lastTo(7001)).length, 4);

  r = await say(7001, '5');
  assert.equal(r.done, 'wizard_qty_bad');
  assert.match(textOf(lastTo(7001)), /до 4 в одни руки/);

  const go = await wizardToSummary(7001, 2, ['Анна Ранняя', 'Борис Ранний']);
  assert.match(textOf(lastTo(7001)), /2 × 650 ₽ = <b>1 300 ₽<\/b>/);
  r = await cb(7001, go);
  assert.equal(r.done, 'booked');
  const o = (await db().query(
    `SELECT o.amount_rub, o.qty, o.utm, w.early FROM orders o JOIN price_waves w ON w.id = o.wave_id WHERE o.id = $1`, [r.order]
  ))[0];
  assert.deepEqual([Number(o.amount_rub), Number(o.qty), o.early], [1300, 2, true]);
  assert.equal((typeof o.utm === 'string' ? JSON.parse(o.utm) : o.utm).src, 'early');
  assert.ok(notes.some((n) => /Анна Ранняя/.test(n.text)), 'владельцу уведомление о брони');
});

test('сайт и касса ранний доступ не продают: бронь без признака early — «продажи закрыты»', async () => {
  const r = await placeOrder(db(), {
    eventId: 'ev-early', waveNo: 2, buyerName: 'Сайт Гость', phone: '+79160000001',
    attendees: [{ name: 'Сайт Гость' }],
  }, { nowMs: Date.now() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sales_closed');
  const open = await placeOrder(db(), {
    eventId: 'ev-early', waveNo: 1, buyerName: 'Сайт Гость', phone: '+79160000001',
    attendees: [{ name: 'Сайт Гость' }],
  }, { nowMs: Date.now() });
  assert.equal(open.error, 'sales_closed', 'открытая волна до публикации тоже не продаётся');
});

test('отправка по времени: слот → план; «Другое время» → текстом; отмена; фоновые задачи рассылают в срок и отчитываются один раз', async () => {
  // второй подписчик — через /notify: сразу видит предложение раннего доступа
  sentTg.length = 0;
  let r = await say(7002, '/notify');
  assert.equal(r.done, 'subscribed');
  const offer = toChat(7002).find((x) => /ранний доступ/.test(textOf(x.payload)));
  assert.ok(offer, 'подписался — видит ранний доступ');
  assert.equal(button(offer.payload, /^buy:/).callback_data, 'buy:ev-early');

  sentTg.length = 0;
  r = await cb(OWNER, 'eb:ev-early');
  assert.equal(r.done, 'early_preview');
  const ctl = lastTo(OWNER);
  assert.match(textOf(ctl), /Так увидят подписчики \(2\)/);
  const slot = button(ctl, /^bct:/);
  assert.ok(slot, 'кнопки времени');
  assert.ok(buttons(ctl).every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));

  r = await cb(OWNER, slot.callback_data);
  assert.equal(r.done, 'bc_scheduled');
  const row = (await db().query(`SELECT scheduled_at, cursor, kind FROM broadcasts WHERE id = 'early-ev-early'`))[0];
  assert.equal(row.kind, 'early');
  assert.equal(new Date(row.scheduled_at).getTime(), parseInt(slot.callback_data.slice(5).split('-')[0], 36) * 60_000);
  assert.match(textOf(lastTo(OWNER)), /^🕒 Ранний доступ уйдёт/);

  r = await cb(OWNER, 'bcx:e-ev-early');
  assert.equal(r.done, 'bc_unscheduled');
  assert.equal((await db().query(`SELECT scheduled_at FROM broadcasts WHERE id = 'early-ev-early'`))[0].scheduled_at, null);
  r = await cb(OWNER, 'bcx:e-ev-early');
  assert.equal(r.done, 'bc_unschedule_noop');

  r = await cb(OWNER, 'bcw:e-ev-early');
  assert.equal(r.done, 'bc_time_ask');
  r = await say(OWNER, 'когда-нибудь');
  assert.equal(r.done, 'bc_time_bad');
  const nowMs = Date.now();
  r = await say(OWNER, 'завтра 18:00');
  assert.equal(r.done, 'bc_scheduled');
  const want = parseWhen('завтра 18:00', nowMs);
  assert.equal(Date.parse(r.at), want);
  assert.equal((await db().query(`SELECT count(*)::int AS n FROM tg_sessions WHERE chat_id = $1`, [OWNER]))[0].n, 0);
  assert.equal(toChat(7001).length + toChat(7002).length, 0, 'до срока подписчикам — ничего');

  // время пришло: фоновые задачи (планировщик или любой апдейт бота) рассылают
  await db().query(`UPDATE broadcasts SET scheduled_at = now() - interval '1 second' WHERE id = 'early-ev-early'`);
  sentTg.length = 0;
  const t = await runTick({ sql: db(), tg: tgApi, call: tgCall, nowMs: Date.now(), origin: 'https://px.test', sleep: async () => {} }, { force: true });
  assert.equal(t.broadcasts, 1);
  for (const chat of [7001, 7002]) {
    const m = toChat(chat).at(-1)?.payload;
    assert.match(textOf(m), /Ранний доступ для своих/, `чату ${chat} — ранний доступ`);
    assert.equal(button(m, /^buy:/).callback_data, 'buy:ev-early');
  }
  const report = toChat(OWNER).filter((x) => /разослан по расписанию: доставлено 2/.test(textOf(x.payload)));
  assert.equal(report.length, 1, 'владельцу итог');
  // повторный проход: никому второй раз, итог не дублируется
  sentTg.length = 0;
  const again = await runTick({ sql: db(), tg: tgApi, call: tgCall, nowMs: Date.now(), origin: 'https://px.test', sleep: async () => {} }, { force: true });
  assert.equal(again.broadcasts, 0);
  assert.equal(sentTg.filter((x) => x.method === 'sendMessage' || x.method === 'sendPhoto').length, 0);
  // разосланное заново не запланировать и не показать как новое
  assert.equal(await scheduleBroadcast(db(), 'ev-early', 'early', Date.now() + 3600_000), null);
  r = await cb(OWNER, 'eb:ev-early');
  assert.equal(r.done, 'early_preview_failed');
  assert.match(textOf(lastTo(OWNER)), /уже разослан/);
});

test('анонс по расписанию для ночи, которая ещё в раннем доступе, — не уходит, владельцу предупреждение', async () => {
  assert.ok(await scheduleBroadcast(db(), 'ev-early', 'ann', Date.now() + 3600_000));
  await db().query(`UPDATE broadcasts SET scheduled_at = now() - interval '1 second' WHERE id = 'ann-ev-early'`);
  sentTg.length = 0;
  await runTick({ sql: db(), tg: tgApi, call: tgCall, nowMs: Date.now(), origin: 'https://px.test', sleep: async () => {} }, { force: true });
  assert.ok(toChat(OWNER).some((x) => /⚠️ Анонс по расписанию не разослан: Рассылать можно только ночь в продаже/.test(textOf(x.payload))));
  assert.equal(toChat(7001).length + toChat(7002).length, 0);
  const row = (await db().query(`SELECT scheduled_at, done FROM broadcasts WHERE id = 'ann-ev-early'`))[0];
  assert.deepEqual([row.scheduled_at, row.done], [null, false], 'план снят, анонс можно разослать после публикации');
});

test('публикация закрывает ранний доступ: гость посреди оформления получает открытую продажу, ранняя волна больше не продаётся', async () => {
  sentTg.length = 0;
  let r = await cb(7003, 'sub:on');
  assert.equal(r.done, 'subscribed');
  r = await cb(7003, 'buy:ev-early');
  assert.equal(r.done, 'wizard_qty');
  const go = await wizardToSummary(7003, 1, ['Вера Поздняя']);

  r = await cb(OWNER, 'pub:ev-early');
  assert.equal(r.done, 'published');
  assert.equal((await db().query(`SELECT status FROM events WHERE id = 'ev-early'`))[0].status, 'onsale');
  assert.ok((await publicIds()).includes('ev-early'));

  r = await cb(7003, go);
  assert.equal(r.done, 'early_closed');
  assert.equal(r.open, true);
  assert.match(textOf(lastTo(7003)), /продажа уже открыта для всех/);
  assert.equal(button(lastTo(7003), /^buy:/).callback_data, 'buy:ev-early');
  assert.equal((await db().query(`SELECT count(*)::int AS n FROM orders o JOIN tg_links l ON l.order_id = o.id WHERE l.chat_id = 7003`))[0].n, 0);
  // теперь — обычный мастер по открытой цене
  r = await cb(7003, 'buy:ev-early');
  assert.equal(r.done, 'wizard_qty');
  assert.equal(r.early, undefined);
  assert.match(textOf(lastTo(7003)), /900 ₽/);
  // ранняя волна закрыта и для брони «в обход» мастера
  const direct = await placeOrder(db(), {
    eventId: 'ev-early', waveNo: 2, buyerName: 'Хитрый Гость', phone: '+79160000002', attendees: [{ name: 'Хитрый Гость' }],
  }, { nowMs: Date.now(), early: true });
  assert.equal(direct.ok, false);
  // ранний доступ после публикации не открыть
  r = await cb(OWNER, 'early:ev-early');
  assert.equal(r.done, 'early_too_late');
});

test('/pay по коду: код с кириллицей, повтор, неизвестный код, подсказка; гостю — не команда владельца', async () => {
  const o = (await db().query(
    `SELECT o.id, o.pay_code FROM orders o JOIN tg_links l ON l.order_id = o.id WHERE l.chat_id = 7001 AND o.status = 'pending'`
  ))[0];
  assert.ok(o, 'бронь раннего доступа ждёт оплаты');
  // как набирают с телефона: строчные, русская раскладка, пробел вместо дефиса
  const typed = o.pay_code.toLowerCase().replace('p', 'р').replace('x', 'х').replace('-', ' ');
  sentTg.length = 0;
  let r = await say(OWNER, `/pay ${typed}`);
  assert.equal(r.done, 'pay_cmd_paid');
  assert.equal((await db().query(`SELECT status FROM orders WHERE id = $1`, [o.id]))[0].status, 'paid');
  assert.match(textOf(lastTo(OWNER)), new RegExp(`✅ ${o.pay_code} подтверждена · QR гостю отправлены`));
  assert.match(textOf(toChat(7001).at(-1).payload), /\/t\//, 'гостю проходки');

  r = await say(OWNER, `/pay ${o.pay_code}`);
  assert.equal(r.done, 'pay_cmd_noop');
  assert.match(textOf(lastTo(OWNER)), /уже подтверждена/);
  r = await say(OWNER, '/pay PX-ZZZZ');
  assert.equal(r.done, 'pay_cmd_unknown');
  r = await say(OWNER, '/pay');
  assert.equal(r.done, 'pay_cmd_help');
  assert.match(textOf(lastTo(OWNER)), /\/pay PX-7F3K/);
  r = await say(7002, `/pay ${o.pay_code}`);
  assert.notEqual(r.done, 'pay_cmd_paid');
  assert.notEqual(r.done, 'pay_cmd_noop');
});

test('панель: ранний доступ через API — превью владельцу, правка не опускает квоту ниже проданного; ночь в продаже — отказ', async () => {
  const call = async (body) => {
    const r = res();
    await upsert({ method: 'POST', headers: { 'x-admin-key': 'adm-early', host: 'px.test' }, query: {}, body }, r);
    return r;
  };
  sentTg.length = 0;
  let r = await call({ action: 'early', id: 'ev-early2', qty: 30, price: 590 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.previewed], ['early', true]);
  assert.ok(toChat(OWNER).some((x) => /Ранний доступ для своих/.test(textOf(x.payload)) && /SECOND NIGHT/.test(textOf(x.payload))));
  // гость забронировал 3 по ранней цене — квоту 2 панель не поставит
  await db().query(`UPDATE price_waves SET sold = 3 WHERE event_id = 'ev-early2' AND early`);
  r = await call({ action: 'early', id: 'ev-early2', qty: 2, price: 550 });
  assert.equal(r.code, 200);
  const w = (await db().query(`SELECT quota, price_rub FROM price_waves WHERE event_id = 'ev-early2' AND early`))[0];
  assert.deepEqual([Number(w.quota), Number(w.price_rub)], [3, 550]);
  assert.equal((await db().query(`SELECT count(*)::int AS n FROM price_waves WHERE event_id = 'ev-early2' AND early`))[0].n, 1, 'волна одна, не плодится');
  r = await call({ action: 'early', id: 'ev-early', qty: 10, price: 500 });
  assert.equal(r.code, 409);
  assert.match(r.body.message, /уже в открытой продаже/);
  r = await call({ action: 'early', id: 'ev-early2', qty: 0, price: 500 });
  assert.equal(r.code, 409);
  // список панели отдаёт признак ранней волны
  const list = res();
  await upsert({ method: 'GET', headers: { 'x-admin-key': 'adm-early' }, query: {} }, list);
  const ev = list.body.events.find((e) => e.id === 'ev-early2');
  assert.equal(ev.status, 'early');
  assert.equal(ev.waves.find((x) => x.early === true)?.price_rub ?? ev.waves.find((x) => x.early === true)?.priceRub, 550);
});

test('владелец: /cancel на вопросе бота — «Ок, отменил», параметры больше не ждём', async () => {
  let r = await cb(OWNER, 'early:ev-early2');
  assert.equal(r.done, 'early_ask');
  sentTg.length = 0;
  r = await say(OWNER, '/cancel');
  assert.equal(r.done, 'wizard_cancelled');
  assert.equal(textOf(lastTo(OWNER)), 'Ок, отменил.');
  r = await say(OWNER, '20 по 500');
  assert.notEqual(r.done, 'early_open');
});

// ---------- время рассылки: разбор и кнопки ----------
const T0 = Date.parse('2026-10-07T10:00:00+05:00');
const at = (s) => Date.parse(`${s}+05:00`);

test('parseWhen: время по Оренбургу — сегодня, завтра, дата цифрами и словами; прошлое и дальше двух недель — нет', () => {
  assert.equal(parseWhen('20:30', T0), at('2026-10-07T20:30:00'));
  assert.equal(parseWhen('в 19', T0), at('2026-10-07T19:00:00'));
  assert.equal(parseWhen('в 19 часов', T0), at('2026-10-07T19:00:00'));
  assert.equal(parseWhen('9:00', T0), at('2026-10-08T09:00:00'), 'прошедшее сегодня время — завтра');
  assert.equal(parseWhen('Завтра 18:00', T0), at('2026-10-08T18:00:00'));
  assert.equal(parseWhen('послезавтра в 12', T0), at('2026-10-09T12:00:00'));
  assert.equal(parseWhen('18.10 19:00', T0), at('2026-10-18T19:00:00'));
  assert.equal(parseWhen('18 октября 19:30', T0), at('2026-10-18T19:30:00'));
  assert.equal(parseWhen('сегодня 9:00', T0), null, '«сегодня» в прошлом — не завтра');
  assert.equal(parseWhen('07.10 09:00', T0), null);
  assert.equal(parseWhen('1 мая 12:00', T0), null, 'дальше двух недель');
  assert.equal(parseWhen('25:00', T0), null);
  assert.equal(parseWhen('когда-нибудь', T0), null);
});

test('кнопки времени: ближайшие удобные часы не раньше чем через 15 минут; данные кнопок — в пределах 64 байт', () => {
  assert.deepEqual(sendSlots(T0).map((s) => s.label), ['Сегодня 12:00', 'Сегодня 15:00', 'Сегодня 19:00', 'Сегодня 21:00']);
  assert.deepEqual(sendSlots(at('2026-10-07T20:50:00')).map((s) => s.label), ['Завтра 12:00', 'Завтра 19:00', 'Послезавтра 12:00']);
  const id = `px-${'a'.repeat(37)}`;
  const c = previewControls(id, 'early', 120, T0, new Date(T0 + 3600_000).toISOString(), 'https://px.test');
  const data = c.markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  assert.ok(data.includes(`bcx:e-${id}`), 'запланировано — есть отмена');
  for (const d of data) assert.ok(Buffer.byteLength(d) <= 64, `${d} длиннее 64 байт`);
  assert.match(c.text, /Так увидят подписчики \(120\)/);
});

// ---------- выкладка: схема доезжает до базы с первым запросом ----------
test('выкладка: новой колонки ещё нет в базе — бронь сама доводит схему и проходит', async () => {
  await db().query(`ALTER TABLE price_waves DROP COLUMN early`);
  await db().query(`UPDATE px_meta SET v = 'old' WHERE k = 'schema'`);
  const r = await placeOrder(db(), {
    eventId: 'ev-early', waveNo: 1, buyerName: 'Гость Выкладки', phone: '+79160000009', attendees: [{ name: 'Гость Выкладки' }],
  }, { nowMs: Date.now() });
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = (await db().query(`SELECT early FROM price_waves WHERE event_id = 'ev-early' AND wave_no = 1`))[0];
  assert.equal(w.early, false, 'колонка на месте');
});
