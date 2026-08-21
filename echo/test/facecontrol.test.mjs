import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceControl, shareText } from '../assets/facecontrol.js';

test('14–17 — «дневная твоя» (браслет, ночная с 18)', () => {
  for (const age of [14, 15, 16, 17]) {
    const r = faceControl(age);
    assert.equal(r.verdict, 'list', String(age));
    assert.ok(r.sub.includes('браслет') && r.sub.includes('ночную'));
  }
});

test('младше 14 — «рано», с корректным склонением лет ожидания', () => {
  const r6 = faceControl(6);
  assert.equal(r6.verdict, 'early');
  assert.equal(r6.wait, 8);
  assert.ok(r6.sub.includes('8 лет'));
  assert.ok(faceControl(13).sub.includes('1 год'));
  assert.ok(faceControl(11).sub.includes('3 года'));
});

test('18+ — «обе твои»', () => {
  assert.equal(faceControl(18).verdict, 'okay');
  assert.equal(faceControl(99).verdict, 'okay');
});

test('мусор отбрасывается', () => {
  for (const bad of ['', 'abc', '12.5', 0, -3, 121, null, undefined]) {
    assert.equal(faceControl(bad).verdict, 'invalid', String(bad));
  }
});

test('строковый ввод из input принимается', () => {
  assert.equal(faceControl(' 15 ').verdict, 'list');
});

test('shareText содержит вердикт и ссылку', () => {
  const t = shareText(faceControl(15), 'https://example.com');
  assert.ok(t.includes('ДНЕВНАЯ ТВОЯ') && t.includes('https://example.com'));
});
