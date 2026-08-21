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
    timeStart: '16:00', timeEnd: '22:00', ageRating: 14,
    prices: [{ name: 'Первая волна', priceRub: 300 }], descr: null, targetSlug: null,
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
  const slug = 'th-novaya-era-0912';
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
    { callback_query: { id: 'cb2', data: 'pub:th-novaya-era-0912', from: { id: 1 } } },
    deps(null)
  );
  assert.equal(r.done, 'noop');
});

test('«Пропустить» удаляет черновик без продаж', async () => {
  await handleUpdate(
    { update_id: 102, channel_post: { text: 'Ещё анонс' } },
    deps({ ...ANNOUNCE, event: { ...ANNOUNCE.event, title: 'ВТОРАЯ', date: '2026-09-26' } })
  );
  const slug = 'th-vtoraya-0926';
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
    { callback_query: { id: 'cb5', data: 'cancel:th-novaya-era-0912', from: { id: 1 } } },
    deps(null)
  );
  assert.equal(r.done, 'cancelled');
  const ev = (await pg.query(`SELECT status FROM events WHERE id = 'th-novaya-era-0912'`)).rows[0];
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
