import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promoSlug, promoLink } from '../assets/promo-link.js';

test('promoSlug: транслит, дефисы вместо мусора, обрезка', () => {
  assert.equal(promoSlug('Лев Марков'), 'lev-markov');
  assert.equal(promoSlug('  Никита_Дугаев! '), 'nikita-dugaev');
  assert.equal(promoSlug('@max.batutin'), 'max-batutin');
  assert.equal(promoSlug('Юля Щ'), 'yulya-sch');
  assert.equal(promoSlug('a'), '');
  assert.equal(promoSlug('!!!'), '');
  assert.equal(promoSlug(''), '');
  const long = promoSlug('очень-длинное-имя-промоутера-которое-не-влезает');
  assert.ok(long.length <= 24 && !long.endsWith('-'), long);
});

test('promoLink: канонический адрес без хвостового слэша и метка src', () => {
  assert.equal(promoLink('https://proxject.ru/', 'px-260926', 'lev'), 'https://proxject.ru/e/px-260926?src=lev');
  assert.equal(promoLink('https://proxject.ru', 'px-260926', 'max-b'), 'https://proxject.ru/e/px-260926?src=max-b');
});
