// Дымовой e2e боевого сценария на локальном стенде (scripts/devserver.mjs,
// DEV_PGLITE=1). Запуск из projectx:
//   NODE_PATH=<папка с playwright-core> node scripts/e2e-smoke.mjs
// Проверяет то, без чего нельзя принимать деньги: ночь создаётся в панели
// из текста поста и публикуется → страница ночи с превью ссылки → бронь на
// сайте → экран перевода с реквизитами из конфига → «Я перевёл» →
// подтверждение во вкладке «Брони» → проходка активна → дверь по ключу
// двери; плюс страницы условий и политики, честный счётчик и 404.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const B = `http://localhost:${process.env.PORT || 8791}`;
const KEY = process.env.ADMIN_KEY || 'test-admin-123';
const DOOR = process.env.DOOR_KEY || 'test-door-456';
let NIGHT = '';
let pass = 0; let fail = 0;
const step = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const api = async (path, opts = {}) => {
  const r = await fetch(`${B}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const admin = { 'X-Admin-Key': KEY, 'X-Admin-Name': encodeURIComponent('Тест') };

const { SITE } = await import('../assets/data/config.js');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));

// ---- сид ----
const seed = await api('/api/seed', { method: 'POST', headers: admin, body: JSON.stringify({ demoSold: false }) });
step('сид афиши', seed.j?.ok === true, `событий ${seed.j?.seeded}`);

// ---- панель: новая ночь из текста поста ----
// дата — через 10 дней в поясе площадки, чтобы ночь всегда была впереди
const day = new Date(Date.now() + 10 * 86400_000).toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: '2-digit', month: '2-digit' });
const POST = `PROJECT X: SMOKE NIGHT
${day} · двери 22:00, финиш 05:00
📍 Арт-локация «Режиссёр», ул. Волгоградская, 46/3
Первые 50 проходок — 1000₽, дальше 1200₽
Лайн-ап: ARTURQUE, VANULA

Что тебя ждёт:
— лазер-шоу и дым
— фотозона с неоном
— welcome-шот на входе`;
const adm = await ctx.newPage();
adm.on('pageerror', (e) => errors.push(`${adm.url()}: ${e.message}`));
await adm.goto(`${B}/admin`, { waitUntil: 'load' });
await adm.fill('#gate-key', KEY);
await adm.fill('#gate-name', 'Тест');
await adm.click('#gate-go');
await adm.waitForSelector('#app:not([hidden])', { timeout: 10000 });
step('панель: вход по ключу', true);
await adm.goto(`${B}/admin#events/new`);
await adm.waitForSelector('#ed-post', { state: 'visible' });
await adm.fill('#ed-post', POST);
await adm.click('#ed-analyze');
await adm.waitForSelector('#ed-found:not([hidden]) .fc', { timeout: 10000 });
const form = await adm.evaluate(() => ({
  title: document.querySelector('[data-k="title"]').value,
  date: document.querySelector('[data-k="date"]').value,
  start: document.querySelector('[data-k="timeStart"]').value,
  end: document.querySelector('[data-k="timeEnd"]').value,
  venue: document.querySelector('[data-k="venue"]').value,
  address: document.querySelector('[data-k="address"]').value,
  waves: [...document.querySelectorAll('[data-wk="priceRub"]')].map((i) => i.value),
  program: [...document.querySelectorAll('[data-pk="title"]')].map((i) => i.value),
  lineup: [...document.querySelectorAll('#ed-lineup .tg')].map((t) => t.textContent.trim()),
  miss: [...document.querySelectorAll('.fc.is-miss')].map((c) => c.textContent.trim()),
}));
step('панель: пост разобран — название, дата, время, место, цены, лайн-ап, программа',
  form.title === 'PROJECT X: SMOKE NIGHT' && /^\d{4}-\d{2}-\d{2}$/.test(form.date) && form.start === '22:00' && form.end === '05:00'
  && /Режиссёр/.test(form.venue) && /Волгоградская/.test(form.address) && form.waves.join() === '1000,1200'
  && form.program.length === 3 && form.lineup.length === 2 && !form.miss.length,
  `${form.date} ${form.venue}; цены ${form.waves.join('/')}; пропущено: ${form.miss.join(', ') || 'ничего'}`);
await adm.setInputFiles('#ed-file', new URL('../assets/photos/poster-halloween.jpg', import.meta.url).pathname);
await adm.waitForFunction(() => /Загружено/.test(document.getElementById('ed-poster-note')?.textContent || ''), null, { timeout: 15000 });
step('панель: афиша загружена в базу', true);
await adm.click('#ed-publish');
await adm.waitForSelector('dialog[open] .dlg-a .b-primary');
await adm.click('dialog[open] .dlg-a .b-primary');
await adm.waitForFunction(() => /Ночь в продаже/.test(document.querySelector('dialog[open]')?.textContent || ''), null, { timeout: 15000 });
NIGHT = decodeURIComponent((await adm.evaluate(() => location.hash)).replace('#events/', ''));
await adm.keyboard.press('Escape');
const live = await api('/api/events');
const ev = (live.j?.events || []).find((e) => e.id === NIGHT);
step('панель: ночь опубликована — в афише, с программой, лайн-апом и афишей',
  Boolean(ev && ev.status === 'onsale' && ev.program.length === 3 && ev.lineup.length === 2 && /^\/api\/poster\?id=/.test(ev.posterUrl || '')), NIGHT);

// ---- превью ссылки: страница ночи с её мета-тегами ----
const html = await (await fetch(`${B}/e/${NIGHT}`)).text();
step('страница ночи: свой og:title, афиша в og:image, данные вшиты',
  /<meta property="og:title" content="PROJECT X: SMOKE NIGHT · /.test(html) && /og:image" content="[^"]*\/api\/poster\?id=/.test(html) && html.includes('id="ev-data"'));

// ---- страница ночи: без выдуманного счётчика, цены из волн ----
await page.goto(`${B}/e/${NIGHT}`, { waitUntil: 'load' });
await page.waitForSelector('#buy-open', { timeout: 10000 });
await page.waitForTimeout(500);
const goingHidden = await page.evaluate(() => document.getElementById('ev-going')?.hidden === true || !document.getElementById('ev-going')?.textContent.trim());
step('счётчик «уже идут» скрыт, пока продаж меньше порога', goingHidden);
step('кнопка с ценой первой волны', /1\u00A0000 ₽/.test(await page.textContent('#buy-open')));
step('canonical ночи выставлен', (await page.evaluate(() => document.querySelector('link[rel="canonical"]')?.href)) === `${SITE.siteUrl}/e/${NIGHT}`);

// ---- бронь на сайте ----
await page.click('#buy-open');
await page.waitForSelector('body.sheet-open');
await page.fill('#att-0', 'Гость Дымовой');
await page.fill('#f-phone', '9120001122');
await page.check('#f-consent');
const note = await page.textContent('#submit-note');
const noteLinks = await page.evaluate(() => [...document.querySelectorAll('#submit-note a')].map((a) => a.getAttribute('href')));
step('под кнопкой — условия покупки и правила ссылками, срок брони', /условия покупки/.test(note) && /за сутки до ночи — час/.test(note) && noteLinks.includes('/offer') && noteLinks.includes('/rules'), note.trim().slice(0, 90));
await page.click('#submit-order');
await page.waitForSelector('#pay-box', { timeout: 15000 });
const payBox = await page.textContent('#pay-box');
const payCode = await page.textContent('#pay-code');
step('экран брони: код, сумма, инструкция и кнопки копирования', /^PX-[0-9A-Z]{4}$/.test(payCode.trim()) && /1\u00A0000 ₽/.test(payBox) && /По номеру телефона/.test(payBox) && Boolean(await page.$('#pay-copy-phone')) && Boolean(await page.$('#pay-copy-sum')), payCode.trim());
step('реквизиты из конфига: телефон, банк, получатель', payBox.includes(SITE.transfer.phone) && payBox.includes(SITE.transfer.bank) && payBox.includes(SITE.transfer.recipient), SITE.transfer.recipient);
step('кнопка «Получить проходку в Telegram» с именем бота', (await page.getAttribute('#pay-tg', 'href') || '').includes('t.me/projectx56_bot'));
await page.click('#pay-claim');
await page.waitForFunction(() => /Спасибо/.test(document.getElementById('pay-status')?.textContent || ''), null, { timeout: 10000 });
step('«Я перевёл» принят', true);

// ---- панель: бронь ждёт во вкладке «Брони», подтверждаем кнопкой ----
const pending = await api(`/api/stats?event_id=${NIGHT}`, { headers: admin });
const mine = (pending.j?.pending || []).find((o) => o.pay_code === payCode.trim());
step('панель видит бронь в ожидающих с отметкой «я перевёл»', Boolean(mine && mine.claimed_at), mine ? mine.buyer_name : JSON.stringify(pending.j).slice(0, 80));
await adm.goto(`${B}/admin#orders`);
await adm.reload();
const row = `.pend[data-code="${payCode.trim()}"]`;
await adm.waitForSelector(row, { timeout: 15000 });
step('вкладка «Брони»: строка с кодом, «нажал Я перевёл» и бейдж', /Я перевёл/.test(await adm.textContent(row)) && (await adm.textContent('.nav [data-badge="pending"]')).trim() === '1');
await adm.click(`${row} [data-act="confirm"]`);
await adm.waitForSelector('dialog[open] .dlg-a .b-ok');
await adm.click('dialog[open] .dlg-a .b-ok');
await adm.waitForFunction((sel) => !document.querySelector(sel), row, { timeout: 15000 });
const after = await api(`/api/stats?event_id=${NIGHT}`, { headers: admin });
step('подтверждение кнопкой в панели', !(after.j?.pending || []).some((o) => o.pay_code === payCode.trim()) && after.j?.sold >= 1, `продано ${after.j?.sold}`);
const again = await api('/api/walkin', { method: 'POST', headers: admin, body: JSON.stringify({ action: 'confirm', pay_code: payCode.trim() }) });
step('повторное подтверждение по коду не проходит', again.status === 409, again.j?.message || '');

// ---- проходка ожила, дверь по ключу двери ----
const ticketUrl = await page.evaluate(() => document.querySelector('#success-list a, #saved-list a, a[href^="/t/"]')?.getAttribute('href'));
step('ссылка на проходку есть на экране', Boolean(ticketUrl), ticketUrl || '');
const token = (ticketUrl || '').split('/t/')[1] || '';
await page.goto(`${B}/t/${token}`, { waitUntil: 'load' });
await page.waitForSelector('#ticket-card:not([hidden])', { timeout: 10000 });
await page.waitForFunction(() => !document.querySelector('#ticket-card').classList.contains('is-reserved'), null, { timeout: 10000 });
step('проходка активна после подтверждения', await page.evaluate(() => document.querySelector('#t-pay')?.hidden === true));
const door = await ctx.newPage();
await door.goto(`${B}/s/${token}`);
await door.waitForSelector('#staff-btn');
await door.click('#staff-btn');
await door.fill('#pin-key', DOOR);
await door.fill('#pin-name', 'Хостес');
await door.click('#pin-save');
await door.waitForSelector('#do-checkin', { timeout: 10000 });
step('дверь по ключу двери видит зелёный экран', /Проходит/.test(await door.textContent('#stage')));
await door.click('#do-checkin');
await door.waitForFunction(() => document.querySelector('#stage')?.textContent.includes('Впущен'), null, { timeout: 10000 });
step('чек-ин прошёл', true);

// ---- дверь: гость без проходки прямо со сканера ----
await door.goto(`${B}/scan`, { waitUntil: 'load' });
await door.waitForSelector('#walkin-open', { timeout: 10000 });
await door.click('#walkin-open');
await door.waitForSelector('#wk-name', { timeout: 10000 });
const waveOptions = await door.$$eval('#wk-wave option', (els) => els.map((o) => o.textContent));
step('дверь: форма гостя с волнами из афиши', waveOptions.length >= 1 && /1000 ₽/.test(waveOptions[0]), waveOptions[0]);
await door.fill('#wk-name', 'Гость Свхода');
await door.click('#wk-add');
await door.waitForFunction(() => /Оформлен/.test(document.querySelector('#stage')?.textContent || ''), null, { timeout: 10000 });
step('дверь: гость оформлен и впущен', /впущен/.test(await door.textContent('#stage')) && /1000 ₽/.test(await door.textContent('#stage')));
const guests = await api(`/api/stats?event_id=${NIGHT}&list=1`, { headers: admin });
const walk = (guests.j?.tickets || []).find((t) => t.holder_name === 'Гость Свхода');
step('панель: гость с двери в списке, уже вошёл', Boolean(walk && walk.checked_in_at));

// ---- выгрузка оплат для чеков ----
const orders = await api(`/api/stats?event_id=${NIGHT}&orders=1`, { headers: admin });
const paid = orders.j?.orders || [];
step('оплаты для чеков: перевод и касса с суммами и датами', paid.length >= 2 && paid.every((o) => o.paid_at && o.amount_rub > 0) && paid.some((o) => o.provider === 'door') && paid.some((o) => o.provider === 'transfer'), `${paid.length} оплат`);
const doorDenied = await api(`/api/stats?event_id=${NIGHT}&orders=1`, { headers: { 'X-Admin-Key': DOOR } });
step('выгрузка оплат закрыта для ключа двери', doorDenied.status === 403);

// ---- условия и политика: продавец из конфига ----
await page.goto(`${B}/offer`, { waitUntil: 'load' });
await page.waitForTimeout(500);
const offer = await page.evaluate((inn) => ({
  seller: document.querySelector('[data-seller]')?.textContent || '',
  recipient: document.querySelector('[data-transfer-recipient]')?.textContent || '',
  receipt: document.querySelector('[data-receipt]')?.textContent || '',
  refund: document.querySelector('[data-refund-until]')?.textContent || '',
  ladder: document.querySelector('[data-ladder]')?.textContent || '',
  props: document.getElementById('seller-props')?.textContent || '',
  propsTwice: Boolean(document.getElementById('seller-props-2')),
  email: document.getElementById('offer-email')?.textContent || '',
  innCount: inn ? (document.body.textContent.match(new RegExp(inn, 'g')) || []).length : 0,
  photo: /фотограф/.test(document.getElementById('entry')?.nextElementSibling?.nextElementSibling?.textContent || ''),
}), SITE.legal.seller.inn);
step('условия: продавец, получатель и чек из конфига', offer.seller.includes(SITE.legal.seller.name) && offer.recipient === SITE.transfer.recipient && /Мой налог/.test(offer.receipt), offer.seller);
step('условия: дата возврата и лесенка цен', /2026/.test(offer.refund) && /1 000/.test(offer.ladder), `${offer.refund}; ${offer.ladder}`);
step('условия: ФИО и ИНН продавца один раз (раздел 11), e-mail в претензиях, согласие на съёмку',
  offer.props.includes(SITE.legal.seller.fullName) && offer.props.includes(SITE.legal.seller.inn) && !offer.propsTwice
  && offer.innCount === 1 && offer.email.includes(SITE.legal.seller.email) && offer.photo, `${offer.props} · ИНН ×${offer.innCount}`);
await page.goto(`${B}/privacy`, { waitUntil: 'load' });
await page.waitForTimeout(400);
step('политика: оператор и продавец из конфига', (await page.textContent('[data-legal-operator]')).includes(SITE.legal.operator.name) && (await page.textContent('[data-seller]')).includes(SITE.legal.seller.name));

// ---- главная: правило SECRET PLACE с открытым адресом, футер ----
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForTimeout(800);
const home = await page.evaluate(() => ({
  note: document.querySelector('[data-secret-note]')?.textContent || '',
  legal: document.querySelector('[data-legal-line]')?.textContent || '',
  going: document.body.innerText.includes('уже идут'),
}));
step('главная: правило SECRET PLACE говорит об открытом адресе', /открытым адресом/.test(home.note) && /Волгоградская/.test(home.note), home.note);
step('главная: футер с организатором и продавцом из конфига, без выдуманного счётчика', home.legal.includes(SITE.legal.operator.short) && home.legal.includes(SITE.legal.seller.name) && !home.going, home.legal);

// ---- /night: то же правило с приписки об адресе ----
await page.goto(`${B}/night`, { waitUntil: 'load' });
await page.waitForFunction(() => /адресом|SECRET/.test(document.querySelector('[data-secret-note]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
const nightNote = await page.evaluate(() => document.querySelector('[data-secret-note]')?.textContent || '');
step('/night: приписка об открытом адресе подгружается из афиши', /открытым адресом/.test(nightNote), nightNote);

// ---- 404 ----
const nf = await page.goto(`${B}/takoy-stranicy-net`);
step('404 — своя страница', nf?.status() === 404 && /Такой страницы/.test(await page.textContent('body')));

step('нет ошибок JS', errors.length === 0, errors.join(' | ').slice(0, 200));
await browser.close();
console.log(`\npassed: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
