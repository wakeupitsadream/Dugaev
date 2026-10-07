// Форма ночи в панели: разбор поста поверх уже заполненной формы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDraft, toForm } from '../assets/admin/event-model.js';

const ev = {
  title: 'PROJECT X TINDER PARTY ВЕЧЕРИНКА С БЕСПЛАТНЫМ БАРОМ',
  startsAt: '2026-10-17T17:00:00.000Z', endsAt: '2026-10-17T23:00:00.000Z', ageRating: 18,
  venue: '«Режиссёр»', address: 'Волгоградская, 46/3', descr: 'В программе: большой танцпол, …',
  lineup: ['DJ DIZAYNER'], program: [{ title: 'SHOW PROGRAM', text: '' }],
  waves: [
    { waveNo: 1, name: 'Ранняя волна', priceRub: 790, quota: 25, sold: 1 },
    { waveNo: 2, name: 'Вторая волна', priceRub: 990, quota: 125, sold: 0 },
  ],
};
const draft = {
  title: 'PROJECT X TINDER PARTY', date: '2026-10-18', timeStart: '23:00', timeEnd: '05:00',
  venue: 'Другая площадка', address: 'Другой адрес', ageRating: 16, secret: true,
  descr: 'Вечеринка с бесплатным баром.', lineup: ['DJ DIZAYNER', 'MC'],
  program: [{ title: 'Шоу-программа', text: '' }],
  waves: [{ name: 'Проходка', priceRub: 500, quota: 100 }],
};

test('ночь уже на сайте: пост обновляет только тексты — дата, место, возраст и волны прежние', () => {
  const f = applyDraft(toForm(ev), draft, { contentOnly: true });
  assert.equal(f.title, 'PROJECT X TINDER PARTY');
  assert.equal(f.descr, 'Вечеринка с бесплатным баром.');
  assert.deepEqual(f.lineup, ['DJ DIZAYNER', 'MC']);
  assert.deepEqual(f.program, [{ title: 'Шоу-программа', text: '' }]);
  assert.deepEqual([f.date, f.timeStart, f.timeEnd], ['2026-10-17', '22:00', '04:00']);
  assert.deepEqual([f.venue, f.address, f.ageRating, f.secret], ['«Режиссёр»', 'Волгоградская, 46/3', 18, false]);
  assert.deepEqual(f.waves.map((w) => [w.priceRub, w.quota, w.sold]), [[790, 25, 1], [990, 125, 0]]);
});

test('черновик и копия: пост заполняет всё; волны с продажами не трогаются', () => {
  const full = applyDraft(toForm({ ...ev, waves: [] }), draft);
  assert.deepEqual([full.date, full.timeStart, full.venue, full.ageRating], ['2026-10-18', '23:00', 'Другая площадка', 16]);
  assert.deepEqual(full.waves.map((w) => [w.name, w.priceRub, w.quota]), [['Проходка', 500, 100]]);
  const kept = applyDraft(toForm(ev), draft, { keepWaves: true });
  assert.deepEqual(kept.waves.map((w) => w.sold), [1, 0]);
});
