// Цикл «пост канала → черновик → публикация кнопкой» на настоящем Postgres
// (PGlite). Экстрактор мокается — сетевых вызовов нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA } from '../db/schema.js';
import { handleUpdate } from '../api/tg-webhook.js';

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
  assert.match(msg.payload.text, /2000 ₽/);
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
  assert.match(sent[0].payload.text, /Получить в Telegram/);
});
