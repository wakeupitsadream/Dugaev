// Страница ночи с мета-тегами (превью ссылки в Telegram/VK), статус
// «прошла» на лету, загрузка и выдача афиш из базы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DEV_PGLITE = '1';
process.env.ADMIN_KEY = 'adm-page-test';
const { default: events, mapRow, renderPage, pageMeta } = await import('../api/events.js');
const { default: poster } = await import('../api/poster.js');

const res = () => ({
  code: 0, body: null, headers: {}, sent: null,
  status(c) { this.code = c; return this; },
  json(j) { this.body = j; },
  send(b) { this.sent = b; },
  end(b) { this.sent = b; },
  setHeader(k, v) { this.headers[k] = v; },
});

const row = (over = {}) => ({
  id: 'px-test-1010', brand: 'projectx', title: 'ТЕСТОВАЯ НОЧЬ', city: 'orenburg', venue: 'Клуб «Икс»',
  address: 'Советская, 10', secret: false, capacity: 200, starts_at: new Date('2030-10-10T17:00:00Z'),
  ends_at: new Date('2030-10-10T23:00:00Z'), age_rating: 18, status: 'onsale', poster_url: '/api/poster?id=0123456789abcdef01234567',
  descr: 'Описание', lineup: ['DJ A'], program: [{ title: 'Танцпол', text: '' }],
  waves: [{ waveNo: 1, name: 'Первые 50', priceRub: 1000, quota: 50, sold: 50 }, { waveNo: 2, name: 'Вторая', priceRub: 1500, quota: 150, sold: 3 }],
  ...over,
});

test('mapRow: программа и лайн-ап из базы, закончившаяся ночь «в продаже» для гостей — «прошла»', () => {
  const e = mapRow(row(), Date.parse('2030-10-01'));
  assert.equal(e.status, 'onsale');
  assert.deepEqual(e.program, [{ title: 'Танцпол', text: '' }]);
  assert.deepEqual(e.lineup, ['DJ A']);
  const past = mapRow(row(), Date.parse('2030-10-12'));
  assert.equal(past.status, 'past');
  // program пришла строкой (старый драйвер) или её нет вовсе — не падаем
  assert.deepEqual(mapRow(row({ program: null }), 0).program, []);
  assert.deepEqual(mapRow(row({ program: '[{"title":"X","text":""}]' }), 0).program, [{ title: 'X', text: '' }]);
});

test('мета страницы ночи: название, дата, цена «от» по открытым волнам, абсолютная афиша', () => {
  const e = mapRow(row(), Date.parse('2030-10-01'));
  const m = pageMeta(e, 'https://proxject.ru');
  assert.equal(m.url, 'https://proxject.ru/e/px-test-1010');
  assert.match(m.title, /^ТЕСТОВАЯ НОЧЬ · 10 октября · проходки/);
  assert.match(m.description, /Проходки от 1 500 ₽/, 'первая волна распродана — «от» по второй');
  assert.equal(m.image, 'https://proxject.ru/api/poster?id=0123456789abcdef01234567');
});

test('renderPage: мета-теги заменены, canonical, JSON-LD и данные ночи вшиты, теги экранированы', () => {
  const html = readFileSync(new URL('../event.html', import.meta.url), 'utf8');
  const e = mapRow(row({ title: 'НОЧЬ <script>' }), Date.parse('2030-10-01'));
  const out = renderPage(html, e, 'https://proxject.ru');
  assert.match(out, /<title>НОЧЬ &lt;script&gt; · 10 октября/);
  assert.match(out, /<meta property="og:image" content="https:\/\/proxject\.ru\/api\/poster\?id=0123456789abcdef01234567" \/>/);
  assert.match(out, /<link rel="canonical" href="https:\/\/proxject\.ru\/e\/px-test-1010" \/>/);
  assert.match(out, /"@type":"Event"/);
  const data = /<script type="application\/json" id="ev-data">(.*?)<\/script>/s.exec(out)[1];
  assert.ok(!data.includes('<script>'), 'закрывающий тег в данных экранирован');
  assert.equal(JSON.parse(data).id, 'px-test-1010');
  assert.ok(!/og-260926/.test(out), 'старая афиша 26.09 в превью не осталась');
});

test('GET /api/events?page=…: ночи нет в базе — страница из сида, неизвестный id — обычная страница', async () => {
  const r = res();
  await events({ method: 'GET', query: { page: 'px-260926' }, headers: {} }, r);
  assert.equal(r.code, 200);
  assert.match(r.headers['Content-Type'], /text\/html/);
  assert.match(r.headers['Cache-Control'], /s-maxage=120/);
  assert.match(r.sent, /<title>PROJECT X — БЕСПЛАТНЫЙ БАР · 26 сентября/);
  const u = res();
  await events({ method: 'GET', query: { page: 'нет-такой' }, headers: {} }, u);
  assert.equal(u.code, 200);
  assert.ok(!/id="ev-data"/.test(u.sent));
});

test('афиша: загрузка только с админ-ключом и только картинка, выдача по id с вечным кэшем', async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(100, 1)]);
  const denied = res();
  await poster({ method: 'POST', headers: {}, body: { data: jpeg.toString('base64') }, query: {} }, denied);
  assert.equal(denied.code, 403);
  const notImage = res();
  await poster({ method: 'POST', headers: { 'x-admin-key': 'adm-page-test' }, body: { data: Buffer.from('<svg/>').toString('base64') }, query: {} }, notImage);
  assert.equal(notImage.code, 400);
  const up = res();
  await poster({ method: 'POST', headers: { 'x-admin-key': 'adm-page-test' }, body: { data: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, query: {} }, up);
  assert.equal(up.code, 200);
  assert.match(up.body.url, /^\/api\/poster\?id=[0-9a-f]{24}$/);
  const get = res();
  await poster({ method: 'GET', headers: {}, query: { id: up.body.id } }, get);
  assert.equal(get.code, 200);
  assert.equal(get.headers['Content-Type'], 'image/jpeg');
  assert.match(get.headers['Cache-Control'], /immutable/);
  assert.ok(Buffer.compare(get.sent, jpeg) === 0);
  const miss = res();
  await poster({ method: 'GET', headers: {}, query: { id: 'f'.repeat(24) } }, miss);
  assert.equal(miss.code, 404);
});
