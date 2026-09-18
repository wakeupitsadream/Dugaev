// Цикл «пост канала → черновик → публикация кнопкой» на настоящем Postgres
// (PGlite). Экстрактор мокается — сетевых вызовов нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import handler, { handleUpdate, setupBot, resolveWebhookUrl } from '../api/tg-webhook.js';
import { ensureSchema } from '../api/_lib/db.js';

let pg;
const notifications = [];

function deps(extracted, over = {}) {
  return {
    sql: pg,
    extract: async () => extracted,
    extractAvailable: true,
    notify: async (text, markup) => notifications.push({ text, markup }),
    tg: async () => null,
    autoPublish: false,
    nowMs: Date.parse('2026-08-21T12:00:00+05:00'),
    ...over,
  };
}

const ANNOUNCE = {
  kind: 'announcement',
  confidence: 'high',
  event: {
    title: 'НОВАЯ ЭРА', city: 'Оренбург', venue: 'клуб', date: '2026-09-12',
    timeStart: '23:00', timeEnd: '06:00', ageRating: 18,
    prices: [{ name: 'Ранняя волна', priceRub: 400 }], descr: null, targetSlug: null,
  },
};

before(async () => {
  pg = new PGlite();
  for (const stmt of SCHEMA) await pg.query(stmt);
});
after(async () => { await pg.close(); });

test('анонс → черновик с волнами + сообщение с кнопками', async () => {
  const r = await handleUpdate(
    { update_id: 101, channel_post: { text: 'Анонс новой тусы 12 сентября!', photo: [{ file_id: 'A'.repeat(30) }] } },
    deps(ANNOUNCE)
  );
  assert.equal(r.done, 'draft_created');
  const ev = (await pg.query(`SELECT * FROM events WHERE id = $1`, [r.slug])).rows[0];
  assert.equal(ev.status, 'draft');
  assert.ok(ev.poster_url.startsWith('/api/poster?fid='));
  const waves = (await pg.query(`SELECT * FROM price_waves WHERE event_id = $1`, [r.slug])).rows;
  assert.equal(waves.length, 1);
  const note = notifications.at(-1);
  assert.ok(note.markup.inline_keyboard[0].some((b) => b.callback_data === `pub:${r.slug}`));
  // черновик не виден в публичной выборке
  const visible = (await pg.query(`SELECT id FROM events WHERE status IN ('onsale','soldout','past')`)).rows;
  assert.ok(!visible.some((v) => v.id === r.slug));
});

test('дубль update_id игнорируется', async () => {
  const r = await handleUpdate(
    { update_id: 101, channel_post: { text: 'Анонс новой тусы 12 сентября!' } },
    deps(ANNOUNCE)
  );
  assert.equal(r.done, 'duplicate');
});

test('кнопка «Опубликовать» переводит черновик в onsale', async () => {
  const slug = 'px-novaya-era-0912';
  const r = await handleUpdate(
    { callback_query: { id: 'cb1', data: `pub:${slug}`, from: { id: 1 }, message: { chat: { id: 1 } } } },
    deps(null)
  );
  assert.equal(r.done, 'published');
  const ev = (await pg.query(`SELECT status FROM events WHERE id = $1`, [slug])).rows[0];
  assert.equal(ev.status, 'onsale');
});

test('повторная публикация — noop', async () => {
  const r = await handleUpdate(
    { callback_query: { id: 'cb2', data: 'pub:px-novaya-era-0912', from: { id: 1 } } },
    deps(null)
  );
  assert.equal(r.done, 'noop');
});

test('«Пропустить» удаляет черновик без продаж', async () => {
  await handleUpdate(
    { update_id: 102, channel_post: { text: 'Ещё анонс' } },
    deps({ ...ANNOUNCE, event: { ...ANNOUNCE.event, title: 'ВТОРАЯ', date: '2026-09-26' } })
  );
  const slug = 'px-vtoraya-0926';
  const r = await handleUpdate(
    { callback_query: { id: 'cb3', data: `skip:${slug}`, from: { id: 1 } } },
    deps(null)
  );
  assert.equal(r.done, 'skipped');
  assert.equal((await pg.query(`SELECT 1 FROM events WHERE id = $1`, [slug])).rows.length, 0);
});

test('пост «other» — тишина, событий нет', async () => {
  const count = async () => (await pg.query(`SELECT count(*)::int AS n FROM events`)).rows[0].n;
  const beforeN = await count();
  notifications.length = 0;
  const r = await handleUpdate(
    { update_id: 103, channel_post: { text: 'Фотоотчёт с прошлой тусы, всем спасибо!' } },
    deps({ kind: 'other' })
  );
  assert.equal(r.done, 'other');
  assert.equal(await count(), beforeN);
  assert.equal(notifications.length, 0);
});

test('без LLM-ключа пост пересылается владельцу', async () => {
  notifications.length = 0;
  const r = await handleUpdate(
    { update_id: 104, channel_post: { text: 'Пост, который некому анализировать' } },
    deps(null, { extractAvailable: false })
  );
  assert.equal(r.done, 'forwarded');
  assert.ok(notifications[0].text.includes('вручную'));
});

test('чужой пользователь не может жать кнопки', async () => {
  process.env.TELEGRAM_CHAT_ID = '42';
  const r = await handleUpdate(
    { callback_query: { id: 'cb4', data: 'pub:whatever', from: { id: 999 }, message: { chat: { id: 999 } } } },
    deps(null)
  );
  assert.equal(r.done, 'callback_denied');
  delete process.env.TELEGRAM_CHAT_ID;
});

test('отмена: событие снимается с продажи', async () => {
  const r = await handleUpdate(
    { callback_query: { id: 'cb5', data: 'cancel:px-novaya-era-0912', from: { id: 1 } } },
    deps(null)
  );
  assert.equal(r.done, 'cancelled');
  const ev = (await pg.query(`SELECT status FROM events WHERE id = 'px-novaya-era-0912'`)).rows[0];
  assert.equal(ev.status, 'cancelled');
});

test('AUTO_PUBLISH=1 публикует сразу', async () => {
  const r = await handleUpdate(
    { update_id: 105, channel_post: { text: 'Автопилот-анонс' } },
    deps(
      { ...ANNOUNCE, event: { ...ANNOUNCE.event, title: 'АВТО', date: '2026-10-03' } },
      { autoPublish: true }
    )
  );
  assert.equal(r.done, 'draft_created');
  const ev = (await pg.query(`SELECT status FROM events WHERE id = $1`, [r.slug])).rows[0];
  assert.equal(ev.status, 'onsale');
});

// ---------- v6: бот гостя — бронь, «я перевёл», подтверждение владельцем ----------
import { ORDER_SQL } from '../api/_lib/queries.js';

const sent = [];
function guestDeps(over = {}) {
  return deps(null, {
    tg: async (method, payload) => { sent.push({ method, payload }); return null; },
    origin: 'https://px.test',
    ...over,
  });
}

test('гость: /start с номером брони привязывает чат и показывает реквизиты с кнопкой', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, address, starts_at, age_rating, status)
     VALUES ('ev-bot', 'BOT NIGHT', 'orenburg', 'Режиссёр', 'Волгоградская, 46/3', now() + interval '5 days', 18, 'onsale')`
  );
  await pg.query(`INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES ('ev-bot', 1, 'Проходка', 1000, 10)`);
  await pg.query(ORDER_SQL, [
    2, 'ev-bot', 1, 'ord_botorder01', 'Гость Бота', '+79990001122', null, null,
    ['bottickt01', 'bottickt02'], ['Гость Бота', 'Друг Гостя'], ['adult', 'adult'], 'transfer', 180, 'PX-BOT1', false,
  ]);
  sent.length = 0;
  const r = await handleUpdate(
    { message: { chat: { id: 555, type: 'private' }, text: '/start ord_botorder01' } },
    guestDeps()
  );
  assert.equal(r.done, 'linked');
  const link = (await pg.query(`SELECT chat_id FROM tg_links WHERE order_id = 'ord_botorder01'`)).rows[0];
  assert.equal(Number(link.chat_id), 555);
  const o = (await pg.query(`SELECT tg_chat_id FROM orders WHERE id = 'ord_botorder01'`)).rows[0];
  assert.equal(Number(o.tg_chat_id), 555);
  const msg = sent.find((s) => s.method === 'sendMessage');
  assert.ok(msg, 'гостю не ушло сообщение');
  assert.equal(msg.payload.chat_id, 555);
  assert.match(msg.payload.text, /PX-BOT1/);
  assert.match(msg.payload.text, /2\u00A0000 ₽/);
  assert.equal(msg.payload.reply_markup.inline_keyboard[0][0].callback_data, 'claim:ord_botorder01');
});

test('гость жмёт «Я перевёл»: бронь помечена, владельцу кнопки подтверждения; чужой чат — отказ', async () => {
  sent.length = 0;
  notifications.length = 0;
  const denied = await handleUpdate(
    { callback_query: { id: 'cbx', data: 'claim:ord_botorder01', from: { id: 777 } } },
    guestDeps()
  );
  assert.equal(denied.done, 'claim_denied');

  const r = await handleUpdate(
    { callback_query: { id: 'cby', data: 'claim:ord_botorder01', from: { id: 555 } } },
    guestDeps()
  );
  assert.equal(r.done, 'claimed');
  const o = (await pg.query(`SELECT claimed_at FROM orders WHERE id = 'ord_botorder01'`)).rows[0];
  assert.ok(o.claimed_at);
  const n = notifications.at(-1);
  assert.match(n.text, /PX-BOT1/);
  assert.equal(n.markup.inline_keyboard[0][0].callback_data, 'pay:ord_botorder01');
  assert.equal(n.markup.inline_keyboard[0][1].callback_data, 'nopay:ord_botorder01');
});

test('владелец: «Не пришло» снимает заявку и пишет гостю; «Подтвердить» активирует и присылает проходки', async () => {
  sent.length = 0;
  const no = await handleUpdate(
    { callback_query: { id: 'cbn', data: 'nopay:ord_botorder01', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 10 } } },
    guestDeps()
  );
  assert.equal(no.done, 'nopay');
  assert.equal((await pg.query(`SELECT claimed_at FROM orders WHERE id = 'ord_botorder01'`)).rows[0].claimed_at, null);
  const toGuest = sent.find((s) => s.method === 'sendMessage' && s.payload.chat_id === 555);
  assert.match(toGuest.payload.text, /не нашли/);

  sent.length = 0;
  const yes = await handleUpdate(
    { callback_query: { id: 'cbp', data: 'pay:ord_botorder01', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 11 } } },
    guestDeps()
  );
  assert.equal(yes.done, 'paid');
  assert.equal(yes.delivered, true);
  const o = (await pg.query(`SELECT status, confirmed_by FROM orders WHERE id = 'ord_botorder01'`)).rows[0];
  assert.equal(o.status, 'paid');
  assert.equal(o.confirmed_by, 'Telegram');
  const t = (await pg.query(`SELECT status FROM tickets WHERE order_id = 'ord_botorder01'`)).rows;
  assert.deepEqual(t.map((x) => x.status), ['active', 'active']);
  const delivered = sent.find((s) => s.method === 'sendMessage' && s.payload.chat_id === 555);
  assert.match(delivered.payload.text, /https:\/\/px\.test\/t\/bottickt01\./);
  assert.match(delivered.payload.text, /Друг Гостя/);
  // повторное «Подтвердить» — noop
  const again = await handleUpdate(
    { callback_query: { id: 'cbq', data: 'pay:ord_botorder01', from: { id: 1 } } },
    guestDeps()
  );
  assert.equal(again.done, 'pay_noop');
});

test('гость: /tickets показывает оплаченные проходки, /start без брони — подсказка', async () => {
  sent.length = 0;
  const r = await handleUpdate({ message: { chat: { id: 555, type: 'private' }, text: '/tickets' } }, guestDeps());
  assert.equal(r.done, 'tickets');
  const msg = sent.find((s) => s.method === 'sendMessage');
  assert.match(msg.payload.text, /Оплачено/);
  assert.match(msg.payload.text, /Волгоградская/);

  sent.length = 0;
  const hint = await handleUpdate({ message: { chat: { id: 900, type: 'private' }, text: '/start' } }, guestDeps());
  assert.equal(hint.done, 'start');
  assert.match(sent[0].payload.text, /Привет/);
});

// ---------- v10: покупка прямо в боте ----------
const sorted = (a) => [...a].sort();

test('бот: /start показывает ближайшую ночь с ценой и кнопкой брони', async () => {
  sent.length = 0;
  const r = await handleUpdate({ message: { chat: { id: 700, type: 'private' }, text: '/start' } }, guestDeps());
  assert.equal(r.done, 'start');
  assert.equal(r.welcome.via, 'none'); // мок tg отвечает null → «нет ответа»
  assert.equal(r.welcome.error, 'нет ответа');
  const msg = sent.find((s) => s.method === 'sendMessage').payload;
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /BOT NIGHT/);
  assert.match(msg.text, /1\u00A0000 ₽/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, 'buy:ev-bot');
  assert.equal(msg.reply_markup.inline_keyboard[1][0].callback_data, 'menu:tickets');
  assert.equal(msg.reply_markup.inline_keyboard[1][1].url, 'https://px.test/faq');
  assert.equal(msg.reply_markup.inline_keyboard[2][0].url, 'https://px.test/e/ev-bot?src=tgbot');
});

test('бот: приветствие с афишей — фото с подписью и меню; Telegram не скачал фото — тот же текст сообщением', async () => {
  await pg.query(`UPDATE events SET poster_url = '/assets/photos/p.jpg' WHERE id = 'ev-bot'`);
  sent.length = 0;
  // tg возвращает null → sendPhoto «не удался» → фолбэк текстом
  const w1 = await handleUpdate({ message: { chat: { id: 700, type: 'private' }, text: 'привет' } }, guestDeps({ assetOrigin: 'https://www.px.test' }));
  assert.deepEqual(w1.welcome, { via: 'none', error: 'нет ответа', photo_error: 'нет ответа' });
  assert.equal(sent[0].method, 'sendPhoto');
  assert.equal(sent[0].payload.photo, 'https://www.px.test/assets/photos/p.jpg');
  assert.equal(sent[0].payload.parse_mode, 'HTML');
  assert.match(sent[0].payload.caption, /BOT NIGHT/);
  assert.doesNotMatch(sent[0].payload.caption, /Привет/); // не /start — без вступления
  assert.equal(sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'buy:ev-bot');
  assert.equal(sent[1].method, 'sendMessage');
  assert.equal(sent[1].payload.text, sent[0].payload.caption);

  // Telegram принял фото — текстом не дублируем
  sent.length = 0;
  const okPhoto = guestDeps({ tg: async (method, payload) => { sent.push({ method, payload }); return method === 'sendPhoto' ? { message_id: 1 } : null; } });
  const w2 = await handleUpdate({ message: { chat: { id: 700, type: 'private' }, text: '/start' } }, okPhoto);
  assert.deepEqual(w2.welcome, { via: 'photo' });
  assert.deepEqual(sent.map((x) => x.method), ['sendPhoto']);
  assert.match(sent[0].payload.caption, /Привет/);
  // с call: точная ошибка Telegram по афише, текст ушёл
  sent.length = 0;
  const withCall = guestDeps({ call: async (method, payload) => { sent.push({ method, payload }); return method === 'sendPhoto' ? { ok: false, error: 'Bad Request: wrong file identifier/HTTP URL specified' } : { ok: true, result: { message_id: 2 } }; } });
  const w3 = await handleUpdate({ message: { chat: { id: 700, type: 'private' }, text: '/start' } }, withCall);
  assert.deepEqual(w3.welcome, { via: 'text', photo_error: 'Bad Request: wrong file identifier/HTTP URL specified' });
  assert.deepEqual(sent.map((x) => x.method), ['sendPhoto', 'sendMessage']);
  await pg.query(`UPDATE events SET poster_url = NULL WHERE id = 'ev-bot'`);
});

test('бот: кнопки меню — «Мои проходки» и «Забронировать» без сессии', async () => {
  sent.length = 0;
  let r = await handleUpdate({ callback_query: { id: 'm1', data: 'menu:tickets', from: { id: 555 } } }, guestDeps());
  assert.equal(r.done, 'tickets');
  assert.match(sent.find((x) => x.method === 'sendMessage').payload.text, /Оплачено/);
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'm2', data: 'menu:tickets', from: { id: 799 } } }, guestDeps());
  assert.equal(r.done, 'tickets_none');
  assert.equal(sent.at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, 'menu:buy');
  r = await handleUpdate({ callback_query: { id: 'm3', data: 'menu:buy', from: { id: 799 } } }, guestDeps());
  assert.equal(r.done, 'wizard_qty');
  await handleUpdate({ message: { chat: { id: 799, type: 'private' }, text: '/cancel' } }, guestDeps());
});

test('бот: мастер брони — количество → телефон → имена → сводка → бронь с реквизитами и кнопкой «Я перевёл»', async () => {
  sent.length = 0;
  notifications.length = 0;
  const chat = { id: 700, type: 'private' };
  let r = await handleUpdate({ message: { chat, text: '/buy' } }, guestDeps());
  assert.equal(r.done, 'wizard_qty');
  const ask = sent.at(-1).payload;
  assert.match(ask.text, /1\u00A0000 ₽/);
  assert.equal(ask.reply_markup.inline_keyboard[0].length, 4);
  assert.equal(ask.reply_markup.inline_keyboard[0][1].callback_data, 'qty:2');

  r = await handleUpdate(
    { callback_query: { id: 'q1', data: 'qty:2', from: { id: 700 }, message: { chat: { id: 700 }, message_id: 1 } } },
    guestDeps()
  );
  assert.equal(r.done, 'wizard_phone');
  assert.ok(sent.some((s) => s.method === 'editMessageReplyMarkup'), 'кнопки количества не убраны');
  const askPhone = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(askPhone.text, /2\u00A0000 ₽/);
  assert.equal(askPhone.reply_markup.keyboard[0][0].request_contact, true);

  // номер — кнопкой «отправить контакт», без плюса, как отдаёт Telegram
  r = await handleUpdate({ message: { chat, contact: { phone_number: '79161234567', user_id: 700 } } }, guestDeps());
  assert.equal(r.done, 'wizard_names');
  assert.deepEqual(sent.at(-1).payload.reply_markup, { remove_keyboard: true });

  r = await handleUpdate({ message: { chat, text: 'Иван Петров' } }, guestDeps());
  assert.equal(r.done, 'wizard_names_bad');
  r = await handleUpdate({ message: { chat, text: '1. Иван Петров\n2. Мария <Иванова>' } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  const summary = sent.at(-1).payload;
  assert.equal(summary.parse_mode, 'HTML');
  assert.match(summary.text, /2 × 1\u00A0000 ₽ = <b>2\u00A0000 ₽<\/b>/);
  assert.match(summary.text, /Иван Петров, Мария &lt;Иванова&gt;/);
  assert.match(summary.text, /\+79161234567/);
  assert.match(summary.text, /есть 18/);
  assert.match(summary.text, /href="https:\/\/px\.test\/rules"/);
  assert.equal(summary.reply_markup.inline_keyboard[0][0].callback_data, 'book:go');
  assert.equal(summary.reply_markup.inline_keyboard[1][0].callback_data, 'book:no');

  sent.length = 0;
  r = await handleUpdate(
    { callback_query: { id: 'b1', data: 'book:go', from: { id: 700, username: 'ivan' }, message: { chat: { id: 700 }, message_id: 2 } } },
    guestDeps()
  );
  assert.equal(r.done, 'booked');
  const o = (await pg.query(`SELECT * FROM orders WHERE id = $1`, [r.order])).rows[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.qty, 2);
  assert.equal(o.amount_rub, 2000);
  assert.equal(o.buyer_name, 'Иван Петров');
  assert.equal(o.buyer_phone, '+79161234567');
  assert.equal(o.buyer_tg, 'ivan');
  assert.equal(Number(o.tg_chat_id), 700);
  assert.equal((typeof o.utm === 'string' ? JSON.parse(o.utm) : o.utm).src, 'tgbot');
  assert.equal((await pg.query(`SELECT 1 FROM tg_links WHERE chat_id = 700 AND order_id = $1`, [r.order])).rows.length, 1);
  const tickets = (await pg.query(`SELECT holder_name, status FROM tickets WHERE order_id = $1`, [r.order])).rows;
  assert.deepEqual(sorted(tickets.map((t) => t.holder_name)), ['Иван Петров', 'Мария <Иванова>']);
  assert.ok(tickets.every((t) => t.status === 'reserved'));
  assert.equal((await pg.query(`SELECT 1 FROM tg_sessions WHERE chat_id = 700`)).rows.length, 0, 'сессия не закрыта');

  const done = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.equal(done.parse_mode, 'HTML');
  assert.match(done.text, new RegExp(`Бронь <b>${o.pay_code}</b> оформлена`));
  assert.match(done.text, /880-66-88/);
  assert.match(done.text, /Ozon/);
  assert.match(done.text, /2\u00A0000 ₽/);
  assert.equal(done.reply_markup.inline_keyboard[0][0].callback_data, `claim:${r.order}`);
  const n = notifications.at(-1);
  assert.match(n.text, /\(бот\)/);
  assert.match(n.text, new RegExp(o.pay_code));
  assert.match(n.text, /@ivan/);

  // «Я перевёл» из бота работает и для брони, сделанной в боте
  const claimed = await handleUpdate({ callback_query: { id: 'b1c', data: `claim:${r.order}`, from: { id: 700 } } }, guestDeps());
  assert.equal(claimed.done, 'claimed');
});

test('бот: волна закончилась между сводкой и кнопкой — новая цена для всей компании, бронь по ней', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev-bot2', 'LATE NIGHT', 'orenburg', 'Клуб', now() + interval '6 days', 18, 'onsale')`
  );
  await pg.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public)
     VALUES ('ev-bot2', 1, 'Первая', 1000, 1, true), ('ev-bot2', 2, 'Вторая', 1200, 5, true), ('ev-bot2', 3, 'Скрытая', 1, 50, false)`
  );
  sent.length = 0;
  const chat = { id: 701, type: 'private' };
  let r = await handleUpdate({ callback_query: { id: 'c1', data: 'buy:ev-bot2', from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'wizard_qty');
  assert.match(sent.at(-1).payload.text, /осталась 1/);
  r = await handleUpdate({ message: { chat, text: '2 проходки' } }, guestDeps());
  assert.equal(r.done, 'wizard_phone');
  r = await handleUpdate({ message: { chat, text: 'восемь' } }, guestDeps());
  assert.equal(r.done, 'wizard_phone_bad');
  r = await handleUpdate({ message: { chat, text: '8 916 000 11 22' } }, guestDeps());
  assert.equal(r.done, 'wizard_names');
  r = await handleUpdate({ message: { chat, text: 'Олег Смирнов, Анна Смирнова' } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  assert.match(sent.at(-1).payload.text, /2 × 1\u00A0000 ₽/);

  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b2', data: 'book:go', from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'wizard_repriced');
  assert.equal(r.priceRub, 1200);
  const again = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(again.text, /по 1\u00A0000 ₽ разобрали/);
  assert.match(again.text, /2 × 1\u00A0200 ₽ = <b>2\u00A0400 ₽<\/b>/);
  assert.equal(again.reply_markup.inline_keyboard[0][0].callback_data, 'book:go');

  r = await handleUpdate({ callback_query: { id: 'b3', data: 'book:go', from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  const o = (await pg.query(`SELECT o.amount_rub, w.wave_no FROM orders o JOIN price_waves w ON w.id = o.wave_id WHERE o.id = $1`, [r.order])).rows[0];
  assert.equal(o.amount_rub, 2400);
  assert.equal(o.wave_no, 2);
  // повторный тап по той же кнопке — сессии уже нет, второй брони тоже
  const dup = await handleUpdate({ callback_query: { id: 'b4', data: 'book:go', from: { id: 701 } } }, guestDeps());
  assert.equal(dup.done, 'wizard_stale');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM orders WHERE tg_chat_id = 701`)).rows[0].n, 1);
});

test('бот: мест меньше, чем просят, — потолок одной брони, телефон повторно не спрашивается; всё продано — честно говорит', async () => {
  // ev-bot2 после прошлого теста: волна 1 — 1 место по 1000, волна 2 — 3 места по 1200, скрытая не считается
  const chat = { id: 703, type: 'private' };
  await handleUpdate({ callback_query: { id: 'c3', data: 'buy:ev-bot2', from: { id: 703 } } }, guestDeps());
  await handleUpdate({ message: { chat, text: '9' } }, guestDeps());
  await handleUpdate({ message: { chat, text: '+7 916 000 33 44' } }, guestDeps());
  const nine = Array.from({ length: 9 }, (_, i) => `Гость Номер${i + 1}`).join('\n');
  let r = await handleUpdate({ message: { chat, text: nine } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b5', data: 'book:go', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'wizard_fewer');
  assert.deepEqual({ maxOne: r.maxOne, total: r.total }, { maxOne: 3, total: 4 });
  const msg = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(msg.text, /одной бронью можно до 3/);
  assert.match(msg.text, /всего осталось 4/);
  assert.equal(msg.reply_markup.inline_keyboard[0].length, 3);
  // выше потолка — не пускаем; в пределах — сразу имена (телефон уже есть)
  r = await handleUpdate({ message: { chat, text: '4' } }, guestDeps());
  assert.equal(r.done, 'wizard_qty_bad');
  r = await handleUpdate({ callback_query: { id: 'q5', data: 'qty:3', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'wizard_names');
  assert.match(sent.at(-1).payload.text, /3 проходки × 1\u00A0000 ₽ = <b>3\u00A0000 ₽<\/b>/);
  assert.match(sent.at(-1).payload.text, /Имена всех 3 гостей/);
  r = await handleUpdate({ message: { chat, text: 'А Б\nВ Г\nД Е' } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  r = await handleUpdate({ callback_query: { id: 'b6', data: 'book:go', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'wizard_repriced'); // в первой волне всего 1 место — вся тройка по второй цене
  r = await handleUpdate({ callback_query: { id: 'b7', data: 'book:go', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  const o = (await pg.query(`SELECT amount_rub, buyer_phone FROM orders WHERE id = $1`, [r.order])).rows[0];
  assert.equal(o.amount_rub, 3600);
  assert.equal(o.buyer_phone, '+79160003344');

  // осталось одно место (в первой волне): компания из двух получает «осталась одна — берёшь?»
  const chat2 = { id: 704, type: 'private' };
  await handleUpdate({ callback_query: { id: 'c4', data: 'buy:ev-bot2', from: { id: 704 } } }, guestDeps());
  await handleUpdate({ message: { chat: chat2, text: '2' } }, guestDeps());
  await handleUpdate({ message: { chat: chat2, text: '+7 916 000 55 66' } }, guestDeps());
  await handleUpdate({ message: { chat: chat2, text: 'И К\nЛ М' } }, guestDeps());
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b8', data: 'book:go', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'wizard_fewer');
  assert.equal(r.maxOne, 1);
  const one = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(one.text, /осталась одна проходка/);
  assert.equal(one.reply_markup.inline_keyboard[0][0].callback_data, 'qty:1');
  r = await handleUpdate({ callback_query: { id: 'q8', data: 'qty:1', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'wizard_names');
  await handleUpdate({ message: { chat: chat2, text: 'И К' } }, guestDeps());
  r = await handleUpdate({ callback_query: { id: 'b9', data: 'book:go', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  assert.equal((await pg.query(`SELECT amount_rub FROM orders WHERE id = $1`, [r.order])).rows[0].amount_rub, 1000);

  // всё продано — /buy честно говорит об этом
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'c5', data: 'buy:ev-bot2', from: { id: 706 } } }, guestDeps());
  assert.equal(r.done, 'wizard_sold_out');
  assert.match(sent.filter((s) => s.method === 'sendMessage').at(-1).payload.text, /Все проходки проданы/);
});

test('бот: /cancel и «Отмена» сбрасывают мастер; кнопка без сессии — «начни заново»; чужие команды владельца недоступны', async () => {
  const chat = { id: 702, type: 'private' };
  await handleUpdate({ message: { chat, text: '/buy' } }, guestDeps());
  let r = await handleUpdate({ message: { chat, text: '/cancel' } }, guestDeps());
  assert.equal(r.done, 'wizard_cancelled');
  assert.equal((await pg.query(`SELECT 1 FROM tg_sessions WHERE chat_id = 702`)).rows.length, 0);
  r = await handleUpdate({ callback_query: { id: 'c9', data: 'qty:2', from: { id: 702 } } }, guestDeps());
  assert.equal(r.done, 'wizard_stale');

  await handleUpdate({ message: { chat, text: '/buy' } }, guestDeps());
  await handleUpdate({ message: { chat, text: '1' } }, guestDeps());
  await handleUpdate({ message: { chat, text: '+79160000000' } }, guestDeps());
  await handleUpdate({ message: { chat, text: 'Тест Тестов' } }, guestDeps());
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'c10', data: 'book:no', from: { id: 702 }, message: { chat: { id: 702 }, message_id: 5 } } }, guestDeps());
  assert.equal(r.done, 'wizard_cancelled');
  assert.equal((await pg.query(`SELECT 1 FROM tg_sessions WHERE chat_id = 702`)).rows.length, 0);
  assert.match(sent.filter((s) => s.method === 'sendMessage').at(-1).payload.text, /ничего не бронируем/);

  // гость не может жать кнопки владельца
  process.env.TELEGRAM_CHAT_ID = '1';
  r = await handleUpdate({ callback_query: { id: 'c11', data: 'pay:ord_botorder01', from: { id: 702 } } }, guestDeps());
  assert.equal(r.done, 'callback_denied');
  delete process.env.TELEGRAM_CHAT_ID;
});

test('бот: без базы — честный ответ, без падения', async () => {
  sent.length = 0;
  const r = await handleUpdate({ message: { chat: { id: 705, type: 'private' }, text: '/buy' } }, guestDeps({ sql: null }));
  assert.equal(r.done, 'no_db');
  assert.match(sent[0].payload.text, /не подключён/);
});

// ---------- v10: настройка бота из панели ----------
test('setupBot: вебхук с секретом и нужными апдейтами, команды, описание; отчёт по шагам', async () => {
  const calls = [];
  const tg = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { username: 'px_bot', first_name: 'PROJECT X' };
    if (method === 'getWebhookInfo') return { url: 'https://px.test/api/tg-webhook', pending_update_count: 0 };
    return true;
  };
  const direct = async () => ({ status: 405, location: null });
  const r = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: 's3cret', username: 'px_bot', probe: direct });
  assert.equal(r.ok, true);
  assert.equal(r.bot.username, 'px_bot');
  assert.equal(r.username_mismatch, null);
  assert.equal(r.delivery, null); // TELEGRAM_CHAT_ID не передан — проверка пропущена
  assert.equal(r.webhook.url, 'https://px.test/api/tg-webhook');
  assert.equal(r.webhook.verified, true);
  assert.equal(r.webhook.redirected_from, null);
  const wh = calls.find((c) => c.method === 'setWebhook').payload;
  assert.equal(wh.url, 'https://px.test/api/tg-webhook');
  assert.equal(wh.secret_token, 's3cret');
  assert.deepEqual(wh.allowed_updates, ['message', 'callback_query', 'channel_post']);
  assert.equal(wh.drop_pending_updates, true);
  const cmds = calls.find((c) => c.method === 'setMyCommands').payload.commands.map((c) => c.command);
  assert.deepEqual(cmds, ['buy', 'tickets', 'cancel']);
  assert.ok(calls.some((c) => c.method === 'setMyDescription'));
  assert.ok(r.steps.every((s) => s.ok));

  const mismatch = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: 's', username: 'other_bot', probe: direct });
  assert.deepEqual(mismatch.username_mismatch, { env: 'other_bot', actual: 'px_bot' });

  const none = await setupBot({ tg, origin: 'https://px.test', token: '', secret: 's', username: null, probe: direct });
  assert.equal(none.ok, false);
  assert.equal(none.error, 'no_token');
  const noSecret = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: '', username: null, probe: direct });
  assert.equal(noSecret.error, 'no_secret');
  const bad = await setupBot({ tg: async () => null, origin: 'https://px.test', token: 't', secret: 's', username: null, probe: direct });
  assert.equal(bad.error, 'bad_token');
  const partial = await setupBot({
    tg: async (m) => (m === 'getMe' ? { username: 'px_bot' } : m === 'setMyCommands' ? null : true),
    origin: 'https://px.test', token: 't', secret: 's', username: null, probe: direct,
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.error, 'partial');
  assert.match(partial.message, /команды/);
});

test('вебхук: голый домен редиректит на www — Telegram по редиректам не ходит, берём конечный адрес', async () => {
  const probe = async (url) => (url.startsWith('https://px.test/')
    ? { status: 308, location: 'https://www.px.test/api/tg-webhook' }
    : { status: 405, location: null });
  const r = await resolveWebhookUrl('https://px.test/', probe);
  assert.equal(r.url, 'https://www.px.test/api/tg-webhook');
  assert.equal(r.verified, true);
  assert.deepEqual(r.hops, ['https://px.test/api/tg-webhook']);
  // относительный Location тоже разбирается
  const rel = await resolveWebhookUrl('https://px.test', async (u) => (u.includes('/api/') && !u.includes('/v2/') ? { status: 301, location: '/v2/api/tg-webhook' } : { status: 405 }));
  assert.equal(rel.url, 'https://px.test/v2/api/tg-webhook');
  // адрес не отвечает (сеть) — не проверен, но остаётся исходным
  const dead = await resolveWebhookUrl('https://px.test', async () => null);
  assert.equal(dead.url, 'https://px.test/api/tg-webhook');
  assert.equal(dead.verified, false);
  // 404 — функции нет: не проверен, код в отчёте
  const missing = await resolveWebhookUrl('https://px.test', async () => ({ status: 404 }));
  assert.equal(missing.verified, false);
  assert.equal(missing.status, 404);

  const calls = [];
  const tg = async (method, payload) => { calls.push({ method, payload }); return method === 'getMe' ? { username: 'px_bot' } : method === 'getWebhookInfo' ? { url: 'https://www.px.test/api/tg-webhook' } : true; };
  const set = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: 's', username: null, probe });
  assert.equal(calls.find((c) => c.method === 'setWebhook').payload.url, 'https://www.px.test/api/tg-webhook');
  assert.equal(set.webhook.redirected_from, 'https://px.test/api/tg-webhook');
  const unverified = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: 's', username: null, probe: async () => ({ status: 404 }) });
  assert.equal(unverified.ok, true);
  assert.match(unverified.message, /не ответил как ожидалось/);
});

test('setupBot: проверочное сообщение владельцу — ответ Telegram виден в отчёте, ошибки шагов с описанием', async () => {
  const sentTo = [];
  const call = async (method, payload) => {
    if (method === 'sendMessage') { sentTo.push(payload.chat_id); return payload.chat_id === '42' ? { ok: true, result: { message_id: 1 } } : { ok: false, error: 'Bad Request: chat not found', code: 400 }; }
    if (method === 'setMyCommands') return { ok: false, error: 'Bad Request: BOT_COMMANDS_INVALID', code: 400 };
    return { ok: true, result: true };
  };
  const tg = async (m) => (m === 'getMe' ? { username: 'px_bot' } : m === 'getWebhookInfo' ? { url: 'https://px.test/api/tg-webhook' } : true);
  const probe = async () => ({ status: 405 });
  const good = await setupBot({ tg, call, origin: 'https://px.test', token: 't', secret: 's', username: null, probe, ownerChat: '42' });
  assert.deepEqual(good.delivery, { ok: true });
  assert.deepEqual(sentTo, ['42']);
  assert.equal(good.ok, false);
  assert.match(good.message, /команды \(Bad Request: BOT_COMMANDS_INVALID\)/);
  const bad = await setupBot({ tg, call, origin: 'https://px.test', token: 't', secret: 's', username: null, probe, ownerChat: '7' });
  assert.deepEqual(bad.delivery, { ok: false, error: 'Bad Request: chat not found' });
  // приветствие владельцу тем же путём, что гостю — результат в отчёте
  const greeted = await setupBot({ tg, call, origin: 'https://px.test', token: 't', secret: 's', username: null, probe, ownerChat: '42', welcome: async (chatId) => ({ via: 'photo', chatId }) });
  assert.deepEqual(greeted.welcome, { via: 'photo', chatId: '42' });
  const thrown = await setupBot({ tg, call, origin: 'https://px.test', token: 't', secret: 's', username: null, probe, ownerChat: '42', welcome: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrown.welcome, { via: 'none', error: 'boom' });
});

test('handler: action=setup только с ключом администратора; без токена — понятная ошибка, а не 500', async () => {
  const res = () => ({
    code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(j) { this.body = j; },
    setHeader(k, v) { this.headers[k] = v; },
  });
  process.env.ADMIN_KEY = 'adm-test-key';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const forbidden = res();
  await handler({ method: 'POST', headers: { 'x-admin-key': 'wrong' }, body: { action: 'setup' } }, forbidden);
  assert.equal(forbidden.code, 403);
  const noToken = res();
  await handler({ method: 'POST', headers: { 'x-admin-key': 'adm-test-key', host: 'proxject.ru' }, body: { action: 'setup' } }, noToken);
  assert.equal(noToken.code, 400);
  assert.equal(noToken.body.error, 'no_token');
  assert.equal(noToken.headers['Cache-Control'], 'no-store');
  delete process.env.ADMIN_KEY;
});

// ---------- схема доводится сама: таблица, добавленная после «Инициализировать БД» ----------
test('ensureSchema: пропавшая таблица бота создаётся при первом запросе, повторно схема не гоняется', async () => {
  await pg.query(`DROP TABLE tg_sessions`);
  await ensureSchema(pg);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM tg_sessions`)).rows[0].n, 0);
  // второй вызов — тот же промис, DDL не повторяется
  await pg.query(`DROP TABLE tg_sessions`);
  await ensureSchema(pg);
  await assert.rejects(pg.query(`SELECT 1 FROM tg_sessions`), /does not exist/);
  for (const stmt of SCHEMA) await pg.query(stmt); // вернуть для порядка
});
