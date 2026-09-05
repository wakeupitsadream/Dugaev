import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceControl, shareText } from '../assets/facecontrol.js';

test('младше 18 — «рано», с корректным склонением лет ожидания', () => {
  const r6 = faceControl(6);
  assert.equal(r6.verdict, 'early');
  assert.equal(r6.age, 6);
  assert.equal(r6.wait, 12);
  assert.ok(r6.sub.includes('12 лет'), r6.sub);
  assert.equal(faceControl(17).wait, 1);
  assert.ok(faceControl(17).sub.includes('1 год —'), 'wait=1 → «1 год»');
  assert.ok(faceControl(16).sub.includes('2 года'), 'wait=2 → «2 года»');
  assert.ok(faceControl(7).sub.includes('11 лет'), 'wait=11 → «лет», а не «год»');
  assert.ok(faceControl(1).sub.includes('17 лет'), 'wait=17 → «лет»');
});

test('граница 18: 17 не проходит, 18 проходит', () => {
  assert.equal(faceControl(17).verdict, 'early');
  assert.equal(faceControl(18).verdict, 'okay');
});

test('18+ — проходишь: паспорт на входе и танцпол до утра', () => {
  for (const age of [18, 25, 99, 120]) {
    const r = faceControl(age);
    assert.equal(r.verdict, 'okay', String(age));
    assert.equal(r.age, age);
    assert.equal(r.title, 'Проходишь');
    assert.ok(r.sub.includes(String(age)), r.sub);
    assert.ok(r.sub.includes('паспорт'), r.sub);
  }
});

test('ветки «в списке» в 18+ бренде нет ни на одном возрасте', () => {
  for (let age = 1; age <= 120; age++) {
    const v = faceControl(age).verdict;
    assert.ok(v === 'early' || v === 'okay', `${age} → ${v}`);
    assert.notEqual(v, 'list', String(age));
  }
});

test('мусор отбрасывается', () => {
  for (const bad of ['', '   ', 'abc', '12.5', '18+', '-0', 0, -3, 121, 1000, null, undefined, NaN, {}]) {
    assert.equal(faceControl(bad).verdict, 'invalid', String(bad));
  }
});

test('строковый ввод из input принимается', () => {
  assert.equal(faceControl(' 21 ').verdict, 'okay');
  assert.equal(faceControl('17').verdict, 'early');
  assert.equal(faceControl('18').age, 18);
});

test('shareText содержит вердикт, бренд и ссылку', () => {
  const ok = shareText(faceControl(21), 'https://example.com');
  assert.ok(ok.includes('ПРОХОДИШЬ'), ok);
  assert.ok(ok.includes('PROJECT X'), ok);
  assert.ok(ok.includes('https://example.com'), ok);

  const early = shareText(faceControl(15), 'https://example.com');
  assert.ok(early.includes('РАНО'), early);
  assert.ok(early.includes('https://example.com'), early);
});
