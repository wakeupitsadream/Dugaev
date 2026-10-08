// Согласие на cookie Метрики: без номера счётчика — ничего; с номером —
// плашка до выбора, счётчик только после «Разрешить», отказ стирает _ym-cookie.
// Браузер подменён минимальными заглушками: DOM здесь не нужен целиком.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
let jar = new Map();
const nodes = [];
const listeners = {};
const fakeEl = () => {
  const el = {
    id: '', className: '', innerHTML: '', handlers: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener(type, fn) { el.handlers[type] = fn; },
    remove() { const i = nodes.indexOf(el); if (i >= 0) nodes.splice(i, 1); },
  };
  return el;
};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.location = { hostname: 'www.proxject.ru' };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
globalThis.document = {
  get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
  set cookie(s) {
    const [pair, ...attrs] = String(s).split(';');
    const [k, v] = pair.split('=');
    if (attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k.trim());
    else jar.set(k.trim(), v);
  },
  getElementById: (id) => nodes.find((n) => n.id === id) || null,
  createElement: () => fakeEl(),
  body: { appendChild: (el) => { nodes.push(el); } },
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
};

const { SITE } = await import('../assets/data/config.js');
const { initConsent, setConsent, consentState, consentNeeded } = await import('../assets/consent.js');
const KEY = 'px_consent_metrika';
const banner = () => nodes.find((n) => n.id === 'consent-bar') || null;
const original = SITE.metrikaId;
after(() => { SITE.metrikaId = original; });
beforeEach(() => {
  store.clear();
  jar = new Map();
  nodes.length = 0;
  SITE.metrikaId = '';
});

test('без номера счётчика: ни плашки, ни запуска', () => {
  let started = 0;
  assert.equal(consentNeeded(), false);
  initConsent({ onAccept: () => { started++; } });
  assert.equal(started, 0);
  assert.equal(banner(), null);
});

test('счётчик настроен, выбора нет: плашка, счётчик ждёт «Разрешить»', () => {
  SITE.metrikaId = '12345678';
  let started = 0;
  initConsent({ onAccept: () => { started++; } });
  assert.ok(banner(), 'плашка показана');
  assert.match(banner().innerHTML, /Яндекс Метрик/);
  assert.match(banner().innerHTML, /href="\/privacy#cookies"/);
  assert.equal(started, 0, 'до согласия счётчик не запускается');
  // нажали «Разрешить» в плашке
  banner().handlers.click({ target: { closest: () => ({ dataset: { consent: 'yes' } }) } });
  assert.equal(started, 1);
  assert.equal(consentState(), 'yes');
  banner()?.handlers.transitionend?.();
  assert.equal(banner(), null, 'плашка убрана');
});

test('согласие уже есть: счётчик сразу, без плашки; отказ — нет ни того, ни другого', () => {
  SITE.metrikaId = '12345678';
  store.set(KEY, JSON.stringify({ v: 'yes', at: '2026-10-08T00:00:00Z' }));
  let started = 0;
  initConsent({ onAccept: () => { started++; } });
  assert.equal(started, 1);
  assert.equal(banner(), null);
  store.set(KEY, JSON.stringify({ v: 'no', at: '2026-10-08T00:00:00Z' }));
  initConsent({ onAccept: () => { started++; } });
  assert.equal(started, 1);
  assert.equal(banner(), null);
});

test('передумал после согласия: cookie Метрики стёрты, чужие не тронуты, событие для страницы политики', () => {
  SITE.metrikaId = '12345678';
  store.set(KEY, JSON.stringify({ v: 'yes' }));
  jar.set('_ym_uid', '1');
  jar.set('_ym_d', '2');
  jar.set('other', '3');
  let seen = null;
  document.addEventListener('px:consent', (e) => { seen = e.detail; });
  setConsent('no');
  assert.equal(consentState(), 'no');
  assert.deepEqual([...jar.keys()], ['other']);
  assert.equal(seen, 'no');
});

test('мусор в памяти браузера — как будто выбора не было', () => {
  store.set(KEY, '{битый json');
  assert.equal(consentState(), null);
  store.set(KEY, JSON.stringify({ v: 'maybe' }));
  assert.equal(consentState(), null);
});
