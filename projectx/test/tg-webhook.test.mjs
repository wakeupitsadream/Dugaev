// Цикл «пост канала → черновик → публикация кнопкой» на настоящем Postgres
// (PGlite). Экстрактор мокается — сетевых вызовов нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import handler, { handleUpdate, setupBot, resolveWebhookUrl } from '../api/tg-webhook.js';
import { ensureSchema } from '../api/_lib/db.js';

// кнопки владельца закрыты для всех, пока чат владельца не задан: в тестах
// владелец — chat 1; посты принимаются только из канала -1001
process.env.TELEGRAM_CHAT_ID = '1';

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
    channelId: -1001,
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
    { update_id: 101, channel_post: { chat: { id: -1001 }, text: 'Анонс новой тусы 12 сентября!', photo: [{ file_id: 'A'.repeat(30) }] } },
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
    { update_id: 101, channel_post: { chat: { id: -1001 }, text: 'Анонс новой тусы 12 сентября!' } },
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
    { update_id: 102, channel_post: { chat: { id: -1001 }, text: 'Ещё анонс' } },
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
    { update_id: 103, channel_post: { chat: { id: -1001 }, text: 'Фотоотчёт с прошлой тусы, всем спасибо!' } },
    deps({ kind: 'other' })
  );
  assert.equal(r.done, 'other');
  assert.equal(await count(), beforeN);
  assert.equal(notifications.length, 0);
});

test('без LLM-ключа пост пересылается владельцу', async () => {
  notifications.length = 0;
  const r = await handleUpdate(
    { update_id: 104, channel_post: { chat: { id: -1001 }, text: 'Пост, который некому анализировать' } },
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
  process.env.TELEGRAM_CHAT_ID = '1';
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

test('AUTO_PUBLISH=1 публикует сразу; «Скрыть с сайта» возвращает ночь в черновик', async () => {
  notifications.length = 0;
  const r = await handleUpdate(
    { update_id: 105, channel_post: { chat: { id: -1001 }, text: 'Автопилот-анонс' } },
    deps(
      { ...ANNOUNCE, event: { ...ANNOUNCE.event, title: 'АВТО', date: '2030-10-03' } },
      { autoPublish: true }
    )
  );
  assert.equal(r.done, 'draft_created');
  const ev = (await pg.query(`SELECT status FROM events WHERE id = $1`, [r.slug])).rows[0];
  assert.equal(ev.status, 'onsale');
  const hide = notifications.at(-1).markup.inline_keyboard[0][0].callback_data;
  assert.equal(hide, `hide:${r.slug}`);
  const h = await handleUpdate({ callback_query: { id: 'cbh', data: hide, from: { id: 1 }, message: { chat: { id: 1 } } } }, deps(null));
  assert.equal(h.done, 'hidden');
  assert.equal((await pg.query(`SELECT status FROM events WHERE id = $1`, [r.slug])).rows[0].status, 'draft');
});

// ---------- v6: бот гостя — бронь, «я перевёл», подтверждение владельцем ----------
import { ORDER_SQL, EXPIRE_SQL } from '../api/_lib/queries.js';
import { orderStart } from '../api/_lib/booking.js';

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
  // голый номер заказа есть в проходке каждого гостя компании — по нему
  // чат не привязывается; поддельная подпись — тоже
  sent.length = 0;
  const bare = await handleUpdate({ message: { chat: { id: 556, type: 'private' }, text: '/start ord_botorder01' } }, guestDeps());
  assert.equal(bare.done, 'start_unsigned');
  assert.match(sent.at(-1).payload.text, /устарела/);
  const forged = await handleUpdate({ message: { chat: { id: 556, type: 'private' }, text: '/start ord_botorder01_0123456789ab' } }, guestDeps());
  assert.equal(forged.done, 'start_unsigned');
  assert.equal((await pg.query(`SELECT 1 FROM tg_links WHERE chat_id = 556`)).rows.length, 0);

  sent.length = 0;
  const r = await handleUpdate(
    { message: { chat: { id: 555, type: 'private' }, text: `/start ${orderStart('ord_botorder01')}` } },
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
  assert.match(toGuest.payload.text, /не видим/);

  sent.length = 0;
  const yes = await handleUpdate(
    { callback_query: { id: 'cbp', data: 'pay:ord_botorder01', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 11 } } },
    guestDeps()
  );
  assert.equal(yes.done, 'paid');
  assert.equal(yes.delivered, false); // мок tg отвечает null → честное «гостю не доставлено» (раньше считалось по наличию чата)
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
  assert.match(sent[0].payload.text, /Это бот/);
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
  assert.doesNotMatch(sent[0].payload.caption, /Это бот/); // не /start — без вступления
  assert.equal(sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'buy:ev-bot');
  assert.equal(sent[1].method, 'sendMessage');
  assert.equal(sent[1].payload.text, sent[0].payload.caption);

  // Telegram принял фото — текстом не дублируем
  sent.length = 0;
  const okPhoto = guestDeps({ tg: async (method, payload) => { sent.push({ method, payload }); return method === 'sendPhoto' ? { message_id: 1 } : null; } });
  const w2 = await handleUpdate({ message: { chat: { id: 700, type: 'private' }, text: '/start' } }, okPhoto);
  assert.deepEqual(w2.welcome, { via: 'photo' });
  assert.deepEqual(sent.map((x) => x.method), ['sendPhoto']);
  assert.match(sent[0].payload.caption, /Это бот/);
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
  assert.match(summary.text, /\+7 916 123-45-67/);
  assert.match(summary.text, /есть 18/);
  assert.match(summary.text, /href="https:\/\/px\.test\/rules"/);
  // кнопка помечена оформлением: сводка от прошлого мастера бронь по новым данным не создаст
  const go = summary.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(go, /^book:go-[a-z0-9]{1,12}$/);
  assert.equal(summary.reply_markup.inline_keyboard[1][0].callback_data, 'book:no');
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b0', data: 'book:go-zzzzzz', from: { id: 700 }, message: { chat: { id: 700 }, message_id: 1 } } }, guestDeps());
  assert.equal(r.done, 'wizard_old_button');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM orders WHERE tg_chat_id = 700`)).rows[0].n, 0);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, go, 'сводку прислали заново');

  sent.length = 0;
  r = await handleUpdate(
    { callback_query: { id: 'b1', data: go, from: { id: 700, username: 'ivan' }, message: { chat: { id: 700 }, message_id: 2 } } },
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

test('бот: цена считается под всю компанию сразу; волна ушла между сводкой и кнопкой — новая цена, бронь по ней', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev-bot2', 'LATE NIGHT', 'orenburg', 'Клуб', now() + interval '6 days', 18, 'onsale')`
  );
  await pg.query(
    `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public)
     VALUES ('ev-bot2', 1, 'Первая', 1000, 1, true), ('ev-bot2', 2, 'Вторая', 1200, 5, true),
            ('ev-bot2', 3, 'Третья', 1500, 10, true), ('ev-bot2', 4, 'Скрытая', 1, 50, false)`
  );
  sent.length = 0;
  const chat = { id: 701, type: 'private' };
  let r = await handleUpdate({ callback_query: { id: 'c1', data: 'buy:ev-bot2', from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'wizard_qty');
  assert.match(sent.at(-1).payload.text, /осталась 1/);
  assert.match(sent.at(-1).payload.text, /дальше 1\u00A0200 ₽/);
  // двоим по 1000 не хватает — вся бронь сразу по второй волне, и гость видит это на шаге количества
  r = await handleUpdate({ message: { chat, text: '2 проходки' } }, guestDeps());
  assert.equal(r.done, 'wizard_phone');
  assert.match(sent.at(-1).payload.text, /2 проходки × 1\u00A0200 ₽ = <b>2\u00A0400 ₽<\/b>/);
  assert.match(sent.at(-1).payload.text, /По 1\u00A0000 ₽ столько уже нет/);
  r = await handleUpdate({ message: { chat, text: 'восемь' } }, guestDeps());
  assert.equal(r.done, 'wizard_phone_bad');
  r = await handleUpdate({ message: { chat, text: '8 916 000 11 22' } }, guestDeps());
  assert.equal(r.done, 'wizard_names');
  r = await handleUpdate({ message: { chat, text: 'Олег Смирнов и Анна Смирнова' } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  assert.match(sent.at(-1).payload.text, /2 × 1\u00A0200 ₽/);
  const go = sent.at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data;

  // пока гость думал, вторую волну разобрали — вся компания по третьей цене
  await pg.query(`UPDATE price_waves SET sold = quota WHERE event_id = 'ev-bot2' AND wave_no = 2`);
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b2', data: go, from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'wizard_repriced');
  assert.equal(r.priceRub, 1500);
  const again = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(again.text, /по 1\u00A0200 ₽ разобрали/);
  assert.match(again.text, /2 × 1\u00A0500 ₽ = <b>3\u00A0000 ₽<\/b>/);
  assert.equal(again.reply_markup.inline_keyboard[0][0].callback_data, go, 'то же оформление — та же метка');

  r = await handleUpdate({ callback_query: { id: 'b3', data: go, from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  const o = (await pg.query(`SELECT o.amount_rub, w.wave_no FROM orders o JOIN price_waves w ON w.id = o.wave_id WHERE o.id = $1`, [r.order])).rows[0];
  assert.equal(o.amount_rub, 3000);
  assert.equal(o.wave_no, 3);
  // повторный тап по той же кнопке — сессии уже нет, второй брони тоже
  const dup = await handleUpdate({ callback_query: { id: 'b4', data: go, from: { id: 701 } } }, guestDeps());
  assert.equal(dup.done, 'wizard_stale');
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM orders WHERE tg_chat_id = 701`)).rows[0].n, 1);
  // повторная бронь при живой — напоминание о ней, а не второй мастер
  r = await handleUpdate({ callback_query: { id: 'c2', data: 'buy:ev-bot2', from: { id: 701 } } }, guestDeps());
  assert.equal(r.done, 'wizard_pending_exists');
  assert.equal(sent.at(-1).payload.reply_markup.inline_keyboard[0][1].callback_data, 'more:ev-bot2');
});

test('бот: мест меньше, чем просят, — потолок одной брони; телефон повторно не спрашивается; всё продано — честно говорит', async () => {
  // ev-bot2 после прошлого теста: волна 1 — 1 место по 1000, волна 2 распродана, волна 3 — 8 мест по 1500
  const chat = { id: 703, type: 'private' };
  await handleUpdate({ callback_query: { id: 'c3', data: 'buy:ev-bot2', from: { id: 703 } } }, guestDeps());
  sent.length = 0;
  let r = await handleUpdate({ message: { chat, text: '9' } }, guestDeps());
  assert.equal(r.done, 'wizard_qty_cap');
  assert.equal(r.maxOne, 8);
  const cap = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(cap.text, /можно до 8/);
  assert.match(cap.text, /всего осталось 9/);
  assert.equal(cap.reply_markup.inline_keyboard[0].length, 4);
  // выше потолка — не пускаем; в пределах — цена по волне, где хватит мест
  r = await handleUpdate({ message: { chat, text: '9' } }, guestDeps());
  assert.equal(r.done, 'wizard_qty_bad');
  r = await handleUpdate({ callback_query: { id: 'q5', data: 'qty:3', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'wizard_phone');
  assert.match(sent.at(-1).payload.text, /3 проходки × 1\u00A0500 ₽ = <b>4\u00A0500 ₽<\/b>/);
  await handleUpdate({ message: { chat, text: '+7 916 000 33 44' } }, guestDeps());
  r = await handleUpdate({ message: { chat, text: 'А Б\nВ Г\nД Е' } }, guestDeps());
  assert.equal(r.done, 'wizard_confirm');
  r = await handleUpdate({ callback_query: { id: 'b6', data: 'book:go', from: { id: 703 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  const o = (await pg.query(`SELECT amount_rub, buyer_phone FROM orders WHERE id = $1`, [r.order])).rows[0];
  assert.equal(o.amount_rub, 4500);
  assert.equal(o.buyer_phone, '+79160003344');

  // компания из двух: пока заполняли, третью волну разобрали — осталось одно место в первой
  const chat2 = { id: 704, type: 'private' };
  await handleUpdate({ callback_query: { id: 'c4', data: 'buy:ev-bot2', from: { id: 704 } } }, guestDeps());
  r = await handleUpdate({ message: { chat: chat2, text: '2' } }, guestDeps());
  assert.equal(r.done, 'wizard_phone');
  await handleUpdate({ message: { chat: chat2, text: '+7 916 000 55 66' } }, guestDeps());
  await handleUpdate({ message: { chat: chat2, text: 'И К\nЛ М' } }, guestDeps());
  await pg.query(`UPDATE price_waves SET sold = quota WHERE event_id = 'ev-bot2' AND wave_no = 3`);
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'b8', data: 'book:go', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'wizard_fewer');
  assert.equal(r.maxOne, 1);
  const one = sent.filter((s) => s.method === 'sendMessage').at(-1).payload;
  assert.match(one.text, /осталась одна проходка/);
  assert.equal(one.reply_markup.inline_keyboard[0][0].callback_data, 'qty:1');
  r = await handleUpdate({ callback_query: { id: 'q8', data: 'qty:1', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'wizard_names'); // телефон уже есть
  assert.match(sent.at(-1).payload.text, /по 1\u00A0000 ₽/);
  await handleUpdate({ message: { chat: chat2, text: 'И К' } }, guestDeps());
  r = await handleUpdate({ callback_query: { id: 'b9', data: 'book:go', from: { id: 704 } } }, guestDeps());
  assert.equal(r.done, 'booked');
  assert.equal((await pg.query(`SELECT amount_rub FROM orders WHERE id = $1`, [r.order])).rows[0].amount_rub, 1000);

  // всё продано — /buy честно говорит об этом
  sent.length = 0;
  r = await handleUpdate({ callback_query: { id: 'c5', data: 'buy:ev-bot2', from: { id: 706 } } }, guestDeps());
  assert.equal(r.done, 'wizard_sold_out');
  assert.match(sent.filter((s) => s.method === 'sendMessage').at(-1).payload.text, /Всё продано/);
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
  process.env.TELEGRAM_CHAT_ID = '1';
});

test('бот: без базы — честный ответ, без падения', async () => {
  sent.length = 0;
  const r = await handleUpdate({ message: { chat: { id: 705, type: 'private' }, text: '/buy' } }, guestDeps({ sql: null }));
  assert.equal(r.done, 'no_db');
  assert.match(sent[0].payload.text, /на паузе/);
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
  process.env.TELEGRAM_CHANNEL_ID = '-1001'; // свой канал задан — слушаем и его посты
  const r = await setupBot({ tg, origin: 'https://px.test', token: 't', secret: 's3cret', username: 'px_bot', probe: direct });
  delete process.env.TELEGRAM_CHANNEL_ID;
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
  assert.equal(wh.drop_pending_updates, false); // адрес вебхука не менялся — очередь гостей не сбрасываем
  const cmds = calls.find((c) => c.method === 'setMyCommands').payload.commands.map((c) => c.command);
  assert.deepEqual(cmds, ['buy', 'tickets', 'notify', 'cancel']);
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

// ---------- v8: бот владельца — мероприятие из поста, публикация, рассылка ----------
const OWNER = { id: 1, type: 'private' };
// минимальный JPEG: SOI + JFIF — его узнаёт sniffMime
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(64, 7)]);
const POST = `PROJECT X: OPENING 2030
📅 10.10
⏰ 22:00–05:00
📍 Клуб «Гигант Холл», ул. Терешковой 10
1 волна — 700₽ (100 шт)
2 волна — 900₽
Лайн-ап: ARTURQUE, VANULA

Что тебя ждёт:
— большой танцпол до утра
— фотозона с неоном`;

function ownerDeps(over = {}) {
  return guestDeps({
    nowMs: Date.parse('2030-09-01T12:00:00+05:00'),
    extractAvailable: false,
    fetchFile: async () => JPEG,
    sleep: async () => {},
    ...over,
  });
}

test('владелец: пересланный пост с афишей → черновик с афишей в базе, программой и карточкой с кнопками', async () => {
  sent.length = 0;
  const r = await handleUpdate({
    update_id: 9001,
    message: { message_id: 50, chat: OWNER, from: { id: 1 }, forward_origin: { type: 'channel' }, caption: POST, photo: [{ file_id: 'small' }, { file_id: 'BIG-FILE-ID-1234567890' }] },
  }, ownerDeps());
  assert.equal(r.done, 'draft_from_post');
  const ev = (await pg.query(`SELECT * FROM events WHERE id = $1`, [r.slug])).rows[0];
  assert.equal(ev.status, 'draft');
  assert.equal(ev.title, 'PROJECT X: OPENING 2030');
  assert.match(ev.poster_url, /^\/api\/poster\?id=[0-9a-f]{24}$/);
  const media = (await pg.query(`SELECT mime, bytes FROM media WHERE id = $1`, [ev.poster_url.split('=')[1]])).rows[0];
  assert.deepEqual([media.mime, media.bytes], ['image/jpeg', JPEG.length]);
  assert.deepEqual(ev.lineup, ['ARTURQUE', 'VANULA']);
  assert.equal(ev.program.length, 2);
  const waves = (await pg.query(`SELECT wave_no, price_rub, quota FROM price_waves WHERE event_id = $1 ORDER BY wave_no`, [r.slug])).rows;
  assert.deepEqual(waves.map((w) => [w.price_rub, w.quota]), [[700, 100], [900, 100]]);
  const card = sent.find((x) => x.method === 'sendPhoto' || (x.method === 'sendMessage' && /Черновик готов/.test(x.payload.text || '')));
  assert.ok(card, 'карточка черновика');
  const kb = card.payload.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, `pub:${r.slug}`);
  assert.equal(kb[0][1].callback_data, `del:${r.slug}`);
  assert.equal(kb[1][0].callback_data, `early:${r.slug}`);
  assert.equal(kb[1][1].url, `https://px.test/admin#events/${r.slug}`);
});

test('владелец: пост без даты — подсказка, черновика нет; гостю пересланный пост не разбирается', async () => {
  sent.length = 0;
  const before = (await pg.query(`SELECT count(*)::int AS n FROM events`)).rows[0].n;
  const r = await handleUpdate({ update_id: 9002, message: { message_id: 51, chat: OWNER, forward_origin: { type: 'user' }, text: 'Скоро большая ночь, следите за анонсами! Вход 700₽' } }, ownerDeps());
  assert.equal(r.done, 'post_no_date');
  assert.match(sent.at(-1).payload.text, /дату/);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM events`)).rows[0].n, before);
  const g = await handleUpdate({ update_id: 9003, message: { message_id: 52, chat: { id: 707, type: 'private' }, forward_origin: { type: 'channel' }, text: POST } }, ownerDeps());
  assert.notEqual(g.done, 'draft_from_post');
});

test('владелец: «Опубликовать» без цен — отказ; с ценами — в продаже и предложение разослать подписчикам', async () => {
  const slug = (await pg.query(`SELECT id FROM events WHERE title = 'PROJECT X: OPENING 2030'`)).rows[0].id;
  await pg.query(`INSERT INTO events (id, title, city, venue, starts_at, age_rating, status) VALUES ('px-nowaves', 'БЕЗ ЦЕН', 'orenburg', 'клуб', '2030-10-20T22:00:00+05:00', 18, 'draft')`);
  sent.length = 0;
  let r = await handleUpdate({ update_id: 9004, callback_query: { id: 'p0', data: 'pub:px-nowaves', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 60 } } }, ownerDeps());
  assert.equal(r.done, 'publish_blocked');
  assert.equal((await pg.query(`SELECT status FROM events WHERE id = 'px-nowaves'`)).rows[0].status, 'draft');
  // подписчики: один через ссылку с сайта, второй — кнопкой
  r = await handleUpdate({ update_id: 9005, message: { message_id: 61, chat: { id: 801, type: 'private' }, text: '/start notify' } }, ownerDeps());
  assert.equal(r.done, 'subscribed');
  assert.equal(r.created, true);
  r = await handleUpdate({ update_id: 9006, callback_query: { id: 's1', data: 'sub:on', from: { id: 802 } } }, ownerDeps());
  assert.equal(r.done, 'subscribed');
  sent.length = 0;
  r = await handleUpdate({ update_id: 9007, callback_query: { id: 'p1', data: `pub:${slug}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 62, caption: 'карточка', photo: [{}] } } }, ownerDeps());
  assert.equal(r.done, 'published');
  assert.equal((await pg.query(`SELECT status FROM events WHERE id = $1`, [slug])).rows[0].status, 'onsale');
  assert.ok(sent.some((x) => x.method === 'editMessageCaption'), 'карточка помечена «Опубликовано»');
  const offer = sent.filter((x) => x.method === 'sendMessage').at(-1).payload;
  assert.equal(offer.reply_markup.inline_keyboard[0][0].callback_data, `bc:${slug}`);
  assert.match(offer.reply_markup.inline_keyboard[0][0].text, /\(2\)/);
});

test('рассылка: анонс уходит подписчикам с кнопкой брони, заблокировавший бота отписывается, повтор — «уже разослано»', async () => {
  const slug = (await pg.query(`SELECT id FROM events WHERE title = 'PROJECT X: OPENING 2030'`)).rows[0].id;
  const got = [];
  const call = async (method, payload) => {
    got.push({ method, payload });
    if (payload.chat_id === 802) return { ok: false, error: 'Forbidden: bot was blocked by the user', code: 403 };
    return { ok: true, result: { message_id: 1, photo: [{ file_id: 'TGPHOTO-small' }, { file_id: 'TGPHOTO-big' }] } };
  };
  sent.length = 0;
  // «📣 Разослать» — сначала превью владельцу: подписчикам ничего не ушло
  const pv = await handleUpdate({ update_id: 9107, callback_query: { id: 'b0', data: `bc:${slug}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 62 } } }, ownerDeps({ call }));
  assert.equal(pv.done, 'bc_preview');
  assert.ok(got.some((x) => x.method === 'sendPhoto' && x.payload.chat_id === 1 && /Новая ночь PROJECT X/.test(x.payload.caption)), 'владелец видит анонс как подписчик');
  assert.equal(got.filter((x) => x.payload.chat_id === 801 || x.payload.chat_id === 802).length, 0, 'подписчикам — ничего');
  const ctl = sent.filter((x) => x.method === 'sendMessage' && x.payload.chat_id === 1).at(-1).payload;
  assert.match(ctl.text, /Так увидят подписчики \(\d+\)/);
  assert.equal(ctl.reply_markup.inline_keyboard[0][0].callback_data, `bcgo:a-${slug}`);
  const r = await handleUpdate({ update_id: 9008, callback_query: { id: 'b1', data: `bcgo:a-${slug}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 63 } } }, ownerDeps({ call }));
  assert.equal(r.done, 'broadcast_done');
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 1);
  const toSub = got.filter((x) => x.method === 'sendPhoto' && x.payload.chat_id === 801)[0];
  assert.match(toSub.payload.caption, /Новая ночь PROJECT X/);
  assert.match(toSub.payload.caption, /\/stop/);
  assert.equal(toSub.payload.reply_markup.inline_keyboard[0][0].callback_data, `buy:${slug}`);
  assert.equal((await pg.query(`SELECT active FROM tg_subs WHERE chat_id = 802`)).rows[0].active, false);
  const again = await handleUpdate({ update_id: 9009, callback_query: { id: 'b2', data: `bc:${slug}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 64 } } }, ownerDeps({ call }));
  assert.equal(again.done, 'bc_preview_failed');
  assert.match(sent.filter((x) => x.method === 'sendMessage').at(-1).payload.text, /уже разослан/);
  // /stop — отписка
  const stop = await handleUpdate({ update_id: 9010, message: { message_id: 65, chat: { id: 801, type: 'private' }, text: '/stop' } }, ownerDeps());
  assert.equal(stop.done, 'unsubscribed');
  assert.equal(stop.was, true);
  // вернулся — «снова подписан», повторное /notify — «уже в списке»
  sent.length = 0;
  const back = await handleUpdate({ update_id: 9200, message: { message_id: 66, chat: { id: 801, type: 'private' }, text: '/notify' } }, ownerDeps());
  assert.deepEqual([back.created, back.reactivated], [false, true]);
  const twice = await handleUpdate({ update_id: 9201, message: { message_id: 67, chat: { id: 801, type: 'private' }, text: '/notify' } }, ownerDeps());
  assert.deepEqual([twice.created, twice.reactivated], [false, false]);
  assert.match(sent.at(-1).payload.text, /уже в списке/);
  const btn = await handleUpdate({ update_id: 9202, callback_query: { id: 's9', data: 'sub:on', from: { id: 801 } } }, ownerDeps());
  assert.equal(btn.done, 'subscribed');
  assert.match(sent.find((x) => x.method === 'answerCallbackQuery' && x.payload.callback_query_id === 's9').payload.text, /уже подписан/);
});

test('рассылка: прогресс сохраняется после каждой пачки — оборванный запуск не шлёт повторно; порция ограничена временем', async () => {
  const { runBroadcast } = await import('../api/_lib/broadcast.js');
  await pg.query(`INSERT INTO events (id, title, city, venue, starts_at, age_rating, status) VALUES ('px-bc-test', 'BC NIGHT', 'orenburg', 'клуб', '2030-11-20T22:00:00+05:00', 18, 'onsale')`);
  await pg.query(`INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES ('px-bc-test', 1, 'Проходка', 900, 100)`);
  await pg.query(`INSERT INTO tg_subs (chat_id, active, source) SELECT g, true, 'test' FROM generate_series(9101, 9105) g ON CONFLICT DO NOTHING`);
  const active = (await pg.query(`SELECT chat_id FROM tg_subs WHERE active ORDER BY chat_id`)).rows.map((r) => Number(r.chat_id));
  assert.ok(active.length >= 5);
  const got = new Map();
  let crashAt = null;
  const call = async (method, payload) => {
    if (payload.chat_id === crashAt) throw new Error('функцию оборвали по таймауту');
    got.set(payload.chat_id, (got.get(payload.chat_id) || 0) + 1);
    return { ok: true, result: { message_id: 1 } };
  };
  const bdeps = { sql: pg, call, tg: async () => null, origin: 'https://px.test' };
  const quiet = async () => {};
  // первая пачка ушла, на второй функцию оборвали
  crashAt = active[1];
  await assert.rejects(runBroadcast(bdeps, 'px-bc-test', { batch: 1, sleep: quiet }));
  const row = (await pg.query(`SELECT cursor, sent FROM broadcasts WHERE id = 'ann-px-bc-test'`)).rows[0];
  assert.equal(Number(row.cursor), active[0]);
  assert.equal(Number(row.sent), 1);
  // пока замок не истёк — «уже идёт», второй поток не шлёт
  const busy = await runBroadcast(bdeps, 'px-bc-test', { batch: 1, sleep: quiet });
  assert.equal(busy.busy, true);
  await pg.query(`UPDATE broadcasts SET lock_until = now() - interval '1 second' WHERE id = 'ann-px-bc-test'`);
  // дальше порциями по времени: каждая — одна пачка, пока не разошлём всем
  crashAt = null;
  let tick = 0;
  let r = null;
  for (let n = 0; n < 20 && !(r && r.done); n++) {
    r = await runBroadcast(bdeps, 'px-bc-test', { batch: 2, sleep: quiet, budgetMs: 0, now: () => tick++ });
    assert.equal(r.ok, true);
  }
  assert.equal(r.done, true);
  assert.equal(r.sent, active.length);
  for (const chat of active) assert.equal(got.get(chat), 1, `чату ${chat} анонс ушёл не один раз`);
});

test('владелец: /stats и /pending, удаление черновика, афиша без подписи — к последнему черновику', async () => {
  sent.length = 0;
  let r = await handleUpdate({ update_id: 9011, message: { message_id: 70, chat: OWNER, text: '/stats' } }, ownerDeps());
  assert.equal(r.done, 'owner_stats');
  assert.match(sent.at(-1).payload.text, /Продано/);
  r = await handleUpdate({ update_id: 9012, message: { message_id: 71, chat: OWNER, text: '/pending' } }, ownerDeps());
  assert.match(r.done, /^owner_pending/);
  // черновик без афиши → картинка без подписи прикрепляется к нему
  r = await handleUpdate({ update_id: 9013, message: { message_id: 72, chat: OWNER, text: 'НОВАЯ НОЧЬ\n12.11 в 22:00\nЛофт «Фабрика», Советская 10\nВход 800₽ — приходи пораньше, будет жарко и громко' } }, ownerDeps());
  assert.equal(r.done, 'draft_from_post');
  const slug = r.slug;
  r = await handleUpdate({ update_id: 9014, message: { message_id: 73, chat: OWNER, photo: [{ file_id: 'POSTER-ONLY-12345678901' }] } }, ownerDeps());
  assert.equal(r.done, 'poster_attached');
  assert.equal(r.slug, slug);
  assert.match((await pg.query(`SELECT poster_url FROM events WHERE id = $1`, [slug])).rows[0].poster_url, /^\/api\/poster\?id=/);
  r = await handleUpdate({ update_id: 9015, callback_query: { id: 'd1', data: `del:${slug}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 74, text: 'карточка' } } }, ownerDeps());
  assert.equal(r.done, 'deleted');
  assert.equal((await pg.query(`SELECT 1 FROM events WHERE id = $1`, [slug])).rows.length, 0);
});

test('владелец: «Удалить» на карточке уже опубликованной ночи её не снимает; альбом — без подсказок на каждую картинку', async () => {
  const pub = (await pg.query(`SELECT id FROM events WHERE status = 'onsale' AND id = 'px-bc-test'`)).rows[0].id;
  sent.length = 0;
  let r = await handleUpdate({ update_id: 9016, callback_query: { id: 'd2', data: `del:${pub}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 75, caption: 'карточка', photo: [{}] } } }, ownerDeps());
  assert.equal(r.done, 'delete_blocked');
  assert.equal((await pg.query(`SELECT status FROM events WHERE id = $1`, [pub])).rows[0].status, 'onsale');
  assert.match(sent.find((x) => x.method === 'answerCallbackQuery').payload.text, /только в панели/);
  // вторая и третья картинки альбома — без подписи: молча пропускаем
  sent.length = 0;
  r = await handleUpdate({ update_id: 9017, message: { message_id: 76, chat: OWNER, media_group_id: 'alb1', photo: [{ file_id: 'ALBUM-PART-2-1234567890' }] } }, ownerDeps());
  assert.equal(r.done, 'album_part');
  assert.equal(sent.filter((x) => x.method === 'sendMessage').length, 0);
});

test('канал без ИИ-ключа: пост с датой → черновик по правилам с карточкой владельцу; без даты — пересылка', async () => {
  sent.length = 0;
  const r = await handleUpdate({
    update_id: 9020,
    channel_post: { chat: { id: -1001 }, text: 'ХЭЛЛОУИН 2030\n31.10 · двери 22:00\nЛофт «Фабрика», Советская 10\nВход 900₽', photo: [{ file_id: 'CHANNEL-POSTER-1234567890' }] },
  }, ownerDeps({ channelId: -1001 }));
  assert.equal(r.done, 'draft_from_post');
  const ev = (await pg.query(`SELECT status, poster_url FROM events WHERE id = $1`, [r.slug])).rows[0];
  assert.equal(ev.status, 'draft');
  assert.match(ev.poster_url, /^\/api\/poster\?id=/);
  assert.ok(sent.some((x) => x.payload.chat_id === '1' && (x.method === 'sendPhoto' || x.method === 'sendMessage')));
  notifications.length = 0;
  const f = await handleUpdate({ update_id: 9021, channel_post: { chat: { id: -1001 }, text: 'Скоро анонс — следите за каналом' } }, ownerDeps({ channelId: -1001 }));
  assert.equal(f.done, 'forwarded');
  assert.match(notifications.at(-1).text, /вручную/);
});

test('переписка: вопрос гостя уходит владельцу, ответ reply — тому гостю, чей вопрос; метка в тексте гостя ответ не перехватывает', async () => {
  let mid = 5000;
  const routed = [];
  const relayDeps = (over = {}) => guestDeps({
    notify: async (text) => { notifications.push({ text }); return { message_id: ++mid }; },
    call: async (method, payload) => {
      const id = ++mid;
      routed.push({ method, payload, id });
      return { ok: true, result: { message_id: id } };
    },
    ...over,
  });
  // гость без брони пишет вопрос, вписав в имя чужую метку
  notifications.length = 0;
  const q = await handleUpdate({ message: { message_id: 77, chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Хитрый #g555' }, text: 'Как к вам добраться от вокзала?' } }, relayDeps());
  assert.equal(q.done, 'relayed');
  assert.equal(q.linked, false);
  assert.match(notifications.at(-1).text, /Вопрос в боте/);
  assert.doesNotMatch(notifications.at(-1).text, /#g555/, 'метка из имени гостя вычищена');
  const fw = routed.find((x) => x.method === 'forwardMessage');
  assert.equal(fw.payload.from_chat_id, 4242);
  const fwMsgId = fw.id; // id пересланного сообщения в чате владельца
  // «привет» без брони — не вопрос, владельца не дёргаем
  const hi = await handleUpdate({ message: { message_id: 78, chat: { id: 4243, type: 'private' }, from: { id: 4243 }, text: 'привет' } }, relayDeps());
  assert.equal(hi.done, 'unknown');
  // владелец отвечает reply на пересланное сообщение — ответ уходит 4242
  routed.length = 0;
  const ans = await handleUpdate({ message: { message_id: 79, chat: { id: 1, type: 'private' }, text: 'От вокзала 10 минут на такси', reply_to_message: { message_id: fwMsgId, forward_origin: { type: 'user' }, text: 'Как к вам добраться #g555' } } }, relayDeps());
  assert.equal(ans.done, 'owner_reply');
  assert.equal(ans.guest, 4242);
  assert.equal(routed.find((x) => x.method === 'sendMessage' && x.payload.chat_id === 4242).payload.text, '💬 Организатор: От вокзала 10 минут на такси');
  // пересланное сообщение без записи в таблице: метке из текста гостя не верим
  const forged = await handleUpdate({ message: { message_id: 80, chat: { id: 1, type: 'private' }, text: 'ответ', reply_to_message: { message_id: 999999, forward_origin: { type: 'user' }, text: 'вопрос #g555' } } }, relayDeps());
  assert.notEqual(forged.done, 'owner_reply');
  // не больше пяти сообщений за 10 минут
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await handleUpdate({ message: { message_id: 81 + i, chat: { id: 4242, type: 'private' }, from: { id: 4242 }, text: `Ещё вопрос номер ${i}?` } }, relayDeps());
  }
  assert.equal(last.done, 'relay_throttled');
});

test('сгоревшая бронь: гость всё равно жмёт «Я перевёл», владелец видит её в /pending и закрывает «Отменить»', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, starts_at, age_rating, status)
     VALUES ('ev-late', 'LATE NIGHT 2', 'orenburg', 'Лофт', now() + interval '4 days', 18, 'onsale')`
  );
  await pg.query(`INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES ('ev-late', 1, 'Проходка', 900, 5)`);
  await pg.query(ORDER_SQL, [
    1, 'ev-late', 1, 'ord_lateord1', 'Поздний Гость', '+79990005566', null, null,
    ['latetkt001'], ['Поздний Гость'], ['adult'], 'transfer', -1, 'PX-LAT1', false,
  ]);
  await pg.query(`INSERT INTO tg_links (chat_id, order_id) VALUES (560, 'ord_lateord1')`);
  await pg.query(`UPDATE orders SET tg_chat_id = 560 WHERE id = 'ord_lateord1'`);
  await pg.query(EXPIRE_SQL);
  notifications.length = 0;
  sent.length = 0;
  const c = await handleUpdate({ callback_query: { id: 'lc1', data: 'claim:ord_lateord1', from: { id: 560 } } }, guestDeps());
  assert.equal(c.done, 'claimed');
  assert.match(notifications.at(-1).text, /уже сгорела/);
  // /pending владельца: сгоревшая бронь с «Я перевёл» — в списке, с пометкой
  sent.length = 0;
  const p = await handleUpdate({ message: { chat: { id: 1, type: 'private' }, text: '/pending' } }, guestDeps());
  assert.equal(p.done, 'owner_pending');
  const card = sent.filter((x) => x.method === 'sendMessage').find((x) => /PX-LAT1/.test(x.payload.text));
  assert.ok(card, 'сгоревшей брони нет в /pending');
  assert.match(card.payload.text, /сгорела/);
  // «Отменить бронь» по сгоревшей — закрывает её и пишет гостю
  sent.length = 0;
  const d = await handleUpdate({ callback_query: { id: 'lc2', data: 'drop:ord_lateord1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 90, text: 'карточка' } } }, guestDeps());
  assert.equal(d.done, 'dropped_expired');
  assert.equal((await pg.query(`SELECT status FROM orders WHERE id = 'ord_lateord1'`)).rows[0].status, 'cancelled');
  assert.match(sent.find((x) => x.method === 'sendMessage' && x.payload.chat_id === 560).payload.text, /не нашли/);
});

test('оплата подтверждена кнопкой: время дверей из ночи и предложение подписаться на анонсы', async () => {
  await pg.query(
    `INSERT INTO events (id, title, city, venue, address, starts_at, age_rating, status)
     VALUES ('ev-doors', 'DOORS NIGHT', 'orenburg', 'Лофт', 'Советская, 10', '2030-11-14T23:30:00+05:00', 18, 'onsale')`
  );
  await pg.query(`INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota) VALUES ('ev-doors', 1, 'Проходка', 1000, 10)`);
  await pg.query(ORDER_SQL, [
    1, 'ev-doors', 1, 'ord_doorsord1', 'Гость Дверей', '+79990003344', null, null,
    ['doorstkt01'], ['Гость Дверей'], ['adult'], 'transfer', 180, 'PX-DOR1', false,
  ]);
  await pg.query(`UPDATE orders SET tg_chat_id = 909 WHERE id = 'ord_doorsord1'`);
  sent.length = 0;
  const call = async (method, payload) => { sent.push({ method, payload }); return { ok: true, result: {} }; };
  const r = await handleUpdate({ update_id: 9022, callback_query: { id: 'pp', data: 'pay:ord_doorsord1', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 80, text: 'бронь' } } }, ownerDeps({ call }));
  assert.equal(r.done, 'paid');
  const msg = sent.find((x) => x.method === 'sendMessage' && x.payload.chat_id === 909);
  assert.ok(msg, 'проходки гостю');
  assert.match(msg.payload.text, /двери 23:30/);
  assert.equal(msg.payload.reply_markup.inline_keyboard[0][0].callback_data, 'sub:on');
});
