// Дымовой e2e боевого сценария на локальном стенде (scripts/devserver.mjs,
// DEV_PGLITE=1). Запуск из projectx:
//   NODE_PATH=<папка с playwright-core> node test/e2e/smoke.mjs
// Проверяет то, без чего нельзя принимать деньги: бронь на сайте → экран
// перевода с реквизитами из конфига → «Я перевёл» → подтверждение в панели
// → проходка активна → дверь по ключу двери; плюс страницы условий и
// политики с реквизитами продавца, честный счётчик и 404.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const B = `http://localhost:${process.env.PORT || 8791}`;
const KEY = process.env.ADMIN_KEY || 'test-admin-123';
const DOOR = process.env.DOOR_KEY || 'test-door-456';
const NIGHT = 'px-260926';
let pass = 0; let fail = 0;
const step = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const api = async (path, opts = {}) => {
  const r = await fetch(`${B}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const admin = { 'X-Admin-Key': KEY, 'X-Admin-Name': encodeURIComponent('Тест') };

const { SITE } = await import('../../assets/data/config.js');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));

// ---- сид ----
const seed = await api('/api/seed', { method: 'POST', headers: admin, body: JSON.stringify({ demoSold: false }) });
step('сид афиши', seed.j?.ok === true, `событий ${seed.j?.seeded}`);

// ---- страница ночи: без выдуманного счётчика, цены из волн ----
await page.goto(`${B}/e/${NIGHT}`, { waitUntil: 'load' });
await page.waitForSelector('#buy-open', { timeout: 10000 });
await page.waitForTimeout(500);
const goingHidden = await page.evaluate(() => document.getElementById('ev-going')?.hidden === true || !document.getElementById('ev-going')?.textContent.trim());
step('счётчик «уже идут» скрыт, пока продаж меньше порога', goingHidden);
step('кнопка с ценой первой волны', /1000/.test(await page.textContent('#buy-open')));
step('canonical ночи выставлен', (await page.evaluate(() => document.querySelector('link[rel="canonical"]')?.href)) === `${SITE.siteUrl}/e/${NIGHT}`);

// ---- бронь на сайте ----
await page.click('#buy-open');
await page.waitForSelector('body.sheet-open');
await page.fill('#att-0', 'Гость Дымовой');
await page.fill('#f-phone', '9120001122');
await page.check('#f-consent');
const note = await page.textContent('#submit-note');
step('под кнопкой — условия покупки, правила и срок брони', /условия покупки/.test(note) && /в день ночи — час/.test(note), note.trim().slice(0, 90));
await page.click('#submit-order');
await page.waitForSelector('#pay-box', { timeout: 15000 });
const payBox = await page.textContent('#pay-box');
const payCode = await page.textContent('#pay-code');
step('экран брони: код и сумма', /^PX-[0-9A-Z]{4}$/.test(payCode.trim()) && /1000 ₽/.test(payBox), payCode.trim());
step('реквизиты из конфига: телефон, банк, получатель', payBox.includes(SITE.transfer.phone) && payBox.includes(SITE.transfer.bank) && payBox.includes(SITE.transfer.recipient), SITE.transfer.recipient);
step('кнопка «Получить проходку в Telegram» с именем бота', (await page.getAttribute('#pay-tg', 'href') || '').includes('t.me/projectx56_bot'));
await page.click('#pay-claim');
await page.waitForFunction(() => /Спасибо/.test(document.getElementById('pay-status')?.textContent || ''), null, { timeout: 10000 });
step('«Я перевёл» принят', true);

// ---- панель: бронь ждёт, подтверждаем по коду ----
const pending = await api(`/api/stats?event_id=${NIGHT}`, { headers: admin });
const mine = (pending.j?.pending || []).find((o) => o.pay_code === payCode.trim());
step('панель видит бронь в ожидающих с отметкой «я перевёл»', Boolean(mine && mine.claimed_at), mine ? mine.buyer_name : JSON.stringify(pending.j).slice(0, 80));
const confirm = await api('/api/walkin', { method: 'POST', headers: admin, body: JSON.stringify({ action: 'confirm', pay_code: payCode.trim() }) });
step('подтверждение по коду', confirm.j?.ok === true, confirm.j?.message || '');

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
step('дверь по ключу двери видит зелёный экран', /Пропустить/.test(await door.textContent('#stage')));
await door.click('#do-checkin');
await door.waitForFunction(() => document.querySelector('#stage')?.textContent.includes('Впущен'), null, { timeout: 10000 });
step('чек-ин прошёл', true);

// ---- условия и политика: продавец из конфига ----
await page.goto(`${B}/offer`, { waitUntil: 'load' });
await page.waitForTimeout(500);
const offer = await page.evaluate(() => ({
  seller: document.querySelector('[data-seller]')?.textContent || '',
  recipient: document.querySelector('[data-transfer-recipient]')?.textContent || '',
  receipt: document.querySelector('[data-receipt]')?.textContent || '',
  refund: document.querySelector('[data-refund-until]')?.textContent || '',
  ladder: document.querySelector('[data-ladder]')?.textContent || '',
}));
step('условия: продавец, получатель и чек из конфига', offer.seller.includes(SITE.legal.operator) && offer.recipient === SITE.transfer.recipient && /Мой налог/.test(offer.receipt), offer.seller);
step('условия: дата возврата и лесенка цен', /2026/.test(offer.refund) && /1 000/.test(offer.ladder), `${offer.refund}; ${offer.ladder}`);
await page.goto(`${B}/privacy`, { waitUntil: 'load' });
await page.waitForTimeout(400);
step('политика: оператор из конфига', (await page.textContent('[data-legal-operator]')).includes(SITE.legal.operator));

// ---- главная: правило SECRET PLACE с открытым адресом, футер ----
await page.goto(`${B}/`, { waitUntil: 'load' });
await page.waitForTimeout(800);
const home = await page.evaluate(() => ({
  note: document.querySelector('[data-secret-note]')?.textContent || '',
  legal: document.querySelector('[data-legal-line]')?.textContent || '',
  going: document.body.innerText.includes('уже идут'),
}));
step('главная: правило SECRET PLACE говорит об открытом адресе', /открытым адресом/.test(home.note) && /Волгоградская/.test(home.note), home.note);
step('главная: футер с продавцом из конфига, без выдуманного счётчика', home.legal.includes(SITE.legal.operatorShort) && !home.going, home.legal);

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
