// Выбор LLM-провайдера и приведение сырого ответа модели к контракту.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProvider, coerceExtracted } from '../api/_lib/extract.js';

test('pickProvider: Polza приоритетнее Anthropic, без ключей — null', () => {
  assert.equal(pickProvider({ POLZA_API_KEY: 'p', ANTHROPIC_API_KEY: 'a' }), 'polza');
  assert.equal(pickProvider({ POLZA_API_KEY: 'p' }), 'polza');
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(pickProvider({}), null);
});

test('coerceExtracted: валидный JSON-строкой проходит', () => {
  const r = coerceExtracted(JSON.stringify({
    kind: 'announcement', confidence: 'high',
    event: { title: 'ТУСА', city: 'Оренбург', date: '2026-09-12', prices: [{ name: 'Вход', priceRub: 300 }] },
  }));
  assert.equal(r.kind, 'announcement');
  assert.equal(r.event.title, 'ТУСА');
  assert.equal(r.event.prices[0].priceRub, 300);
  assert.equal(r.event.venue, null); // недостающие поля добираются null-ами
});

test('coerceExtracted: JSON в ```-заборе очищается', () => {
  const r = coerceExtracted('```json\n{"kind":"other","confidence":"low","event":{}}\n```');
  assert.equal(r.kind, 'other');
});

test('coerceExtracted: не-JSON → error', () => {
  assert.equal(coerceExtracted('извините, не могу').kind, 'error');
  assert.equal(coerceExtracted('').kind, 'error');
});

test('coerceExtracted: мусорные значения нормализуются', () => {
  const r = coerceExtracted({
    kind: 'ВЕЧЕРИНКА!!', confidence: 'sure',
    event: {
      title: '  ', ageRating: '16',
      prices: [{ name: 'Вход', priceRub: 'триста' }, { name: 'Вип', priceRub: 500 }, null],
    },
  });
  assert.equal(r.kind, 'other');          // неизвестный kind → other
  assert.equal(r.confidence, 'low');
  assert.equal(r.event.title, null);      // пустая строка → null
  assert.equal(r.event.ageRating, 16);    // строка-число → число
  assert.equal(r.event.prices.length, 1); // нечисловая цена и null отброшены
  assert.equal(r.event.prices[0].priceRub, 500);
});

test('coerceExtracted: null/объект без event → other с пустым event', () => {
  assert.equal(coerceExtracted(null).kind, 'error');
  const r = coerceExtracted({ kind: 'update' });
  assert.equal(r.kind, 'update');
  assert.equal(r.event.targetSlug, null);
});
