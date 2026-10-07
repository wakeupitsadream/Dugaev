// Разбор поста-анонса без ИИ: реальные форматы афиш бренда и типичные
// посты Telegram/Instagram. Проверяем то, что попадает в форму панели.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost } from '../assets/post-parse.js';

const NOW = Date.parse('2026-09-17T12:00:00+05:00');
const parse = (t) => parsePost(t, { nowMs: NOW });

test('пост ночи 26.09: название, дата, время, площадка, адрес, волны «первые 50 / далее», программа', () => {
  const { draft, notes } = parse(`PROJECT X — БЕСПЛАТНЫЙ БАР 🔥
26.09 | 18+ | 22:00
📍 АРТ ЛОКАЦИЯ РЕЖИССЕР, Волгоградская 46/3

Что тебя ждёт:
— большой танцпол, мягкие места у камина
— неоновые качели, фотозоны и двухметровый Беарбрик
— 4 тематические комнаты: «Пикми», «Плохая девочка», «Dalli» и «Джентльмены»
— диджеи и MC, конкурсы, призы от партнёров, фотограф

🎟 Первые 50 проходок — 1000₽, далее — 1500₽
Строго 18+ по паспорту. FC/DC — в спортивной одежде не пустим.
Двери в 22:00, старт в 23:00, до 04:00
Проходки — по ссылке в шапке профиля`);
  assert.equal(draft.title, 'PROJECT X — БЕСПЛАТНЫЙ БАР');
  assert.equal(draft.date, '2026-09-26');
  assert.equal(draft.timeStart, '22:00');
  assert.equal(draft.timeEnd, '04:00');
  assert.equal(draft.ageRating, 18);
  assert.equal(draft.venue, 'Арт-локация «Режиссер»');
  assert.equal(draft.address, 'Волгоградская, 46/3');
  assert.equal(draft.secret, false);
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub, w.quota, w.public]), [
    ['Первые 50', 1000, 50, true], ['Вторая волна', 1500, 100, true],
  ]);
  assert.equal(draft.program.length, 4);
  assert.deepEqual(draft.program[2], { title: '4 тематические комнаты', text: '«Пикми», «Плохая девочка», «Dalli» и «Джентльмены».' });
  // описание — короткий рассказ из программы, а не весь её список
  assert.equal(draft.descr, 'В программе — 4 тематические комнаты, большой танцпол, неоновые качели, диджеи и MC. Строго 18+ по паспорту, FC/DC — в спортивной одежде не пустим.');
  assert.ok(notes.some((n) => /по 100/.test(n)), 'квота второй волны — подсказка проверить');
});

test('старый формат: волны через слеш, цена на входе — скрытой волной, лайн-ап «DJ x DJ», стилизованное имя клуба', () => {
  const { draft } = parse(`СУМАСШЕДШИЙ ПОСВЯТ 🤪
1 октября | CTUDИЯ CLUB | Алтайская 5/1
Старт в 23:00
Вход: ранняя волна 500₽ / вторая волна 700₽ / на входе 1000₽
DJ SHENDI x DJ JOKER
18+ FC/DC`);
  assert.equal(draft.date, '2026-10-01');
  assert.equal(draft.timeStart, '23:00');
  assert.equal(draft.venue, 'CTUDИЯ CLUB');
  assert.equal(draft.address, 'Алтайская, 5/1');
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub, w.public]), [
    ['Ранняя волна', 500, true], ['Вторая волна', 700, true], ['На входе', 1000, false],
  ]);
  assert.deepEqual(draft.lineup, ['DJ SHENDI', 'DJ JOKER']);
  assert.equal(draft.descr, '', '«18+ FC/DC» — не описание');
});

test('SECRET PLACE, дата словами, «до утра», срок волны «до 25.10» — не дата ночи', () => {
  const { draft, notes } = parse(`ХЭЛЛОУИН 🎃
В субботу, 31 октября — SECRET PLACE
Адрес скинем купившим за сутки
Сбор с 22:00 до утра
Билеты: 800 руб. до 25.10, потом 1200 руб.
#projectx #оренбург`);
  assert.equal(draft.date, '2026-10-31');
  assert.equal(draft.secret, true);
  assert.equal(draft.venue, 'SECRET PLACE');
  assert.equal(draft.address, '');
  assert.equal(draft.timeStart, '22:00');
  assert.equal(draft.timeEnd, '05:00');
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub]), [['До 25.10', 800], ['Вторая волна', 1200]]);
  assert.ok(notes.some((n) => /До утра/.test(n)));
});

test('прошедшая без года дата — следующий год; свободный вход — проходка за 0 ₽', () => {
  const { draft, notes } = parse(`НОЧЬ СТУДЕНТА
16 мая, начало в 22:00
«Режиссёр», Волгоградская 46/3
Вход свободный по студенческому!`);
  assert.equal(draft.date, '2027-05-16');
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub]), [['Бесплатная проходка', 0]]);
  assert.ok(notes.some((n) => /0 ₽/.test(n)));
});

test('Telegram-формат: диапазон времени, «ул.», квота «(100 шт)», лайн-ап через «Лайн-ап:», ссылки не в описании', () => {
  const { draft } = parse(`PROJECT X: OPENING 2026
📅 10.10 (сб)
⏰ 22:00–05:00
📍 Клуб «Гигант Холл», ул. Терешковой 10
1 волна — 700₽ (100 шт)
2 волна — 900₽
3 волна — 1200₽
Лайн-ап: ARTURQUE, VANULA, KEENDY
Проходки: proxject.ru`);
  assert.equal(draft.title, 'PROJECT X: OPENING 2026');
  assert.equal(draft.date, '2026-10-10');
  assert.equal(draft.timeStart, '22:00');
  assert.equal(draft.timeEnd, '05:00');
  assert.equal(draft.venue, 'Клуб «Гигант Холл»');
  assert.equal(draft.address, 'ул. Терешковой, 10');
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub]), [['1 волна', 700], ['2 волна', 900], ['3 волна', 1200]]);
  assert.deepEqual(draft.lineup, ['ARTURQUE', 'VANULA', 'KEENDY']);
  assert.equal(draft.descr, '');
});

test('«PROJECT X» + название строкой ниже, площадка в предложном падеже, цены по полу и депозиты не становятся волнами', () => {
  const { draft, notes } = parse(`🔥 PROJECT X
НОВОГОДНИЙ РЕЙВ

27 декабря (суббота) в лофте «Фабрика», пр-т Победы 15а

Ты знаешь, как мы отдыхаем: свет, дым, бас в грудь и танцпол до утра.

В программе:
• DJ DYSSHA b2b DJ DIZAYNER
• фотозона с ёлкой и гирляндами
• конкурс костюмов: победитель получает VIP-стол на следующую ночь

Девушкам до 23:00 — 500₽, парням — 900₽
Депозит на стол от 10 000₽
Билеты в боте @projectx56_bot`);
  assert.equal(draft.title, 'PROJECT X — НОВОГОДНИЙ РЕЙВ');
  assert.equal(draft.date, '2026-12-27');
  assert.equal(draft.venue, 'Лофт «Фабрика»');
  assert.equal(draft.address, 'пр-т Победы, 15а');
  assert.equal(draft.waves.length, 0);
  assert.equal(draft.timeEnd, '05:00', 'время из строки с ценой — не финиш ночи');
  assert.deepEqual(draft.lineup, ['DJ DYSSHA', 'DJ DIZAYNER']);
  assert.deepEqual(draft.program.map((p) => p.title), ['Фотозона с ёлкой и гирляндами', 'Конкурс костюмов']);
  assert.match(draft.descr, /^Ты знаешь, как мы отдыхаем/);
  assert.ok(notes.some((n) => /девушек и парней/.test(n)));
  assert.ok(notes.some((n) => /Депозиты/.test(n)));
});

test('«Первые 50», «Строго 18», «вторая 1500» — не адреса; пустой текст — пустой черновик с подсказками', () => {
  const { draft } = parse('Первые 50 проходок — 1000₽\nСтрого 18+\nВторая 1500₽');
  assert.equal(draft.address, '');
  const empty = parse('');
  assert.equal(empty.draft.date, '');
  assert.equal(empty.draft.waves.length, 0);
  assert.ok(empty.notes.length >= 3);
});

test('время через точку «в 22.00» — время, «26.09 в 22.00» — дата и время', () => {
  const { draft } = parse('ТУСА\n26.09 в 22.00, до 05.00\nКлуб «Икс», Советская 10\nВход 700₽');
  assert.equal(draft.date, '2026-09-26');
  assert.equal(draft.timeStart, '22:00');
  assert.equal(draft.timeEnd, '05:00');
  assert.equal(draft.address, 'Советская, 10');
  assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub]), [['Проходка', 700]]);
});

test('«двери 22:00, финиш 05:00» в одной строке: второе время — финиш', () => {
  const r = parsePost('PROJECT X: OPENING\n17.10 · двери 22:00, финиш 05:00\nЛофт «Фабрика», ул. Советская 10\nВход 900₽', { nowMs: NOW });
  assert.equal(r.draft.timeStart, '22:00');
  assert.equal(r.draft.timeEnd, '05:00');
  assert.ok(r.found.timeEnd);
  const g = parsePost('НОЧЬ\n12.12\nсбор гостей с 21:30, до 04:00\nВход 500₽', { nowMs: NOW });
  assert.deepEqual([g.draft.timeStart, g.draft.timeEnd], ['21:30', '04:00']);
});

test('пост 17.10: слоган капсом — в описание, а не в название; пункты программы без обрывов на полуслове; капс — обычным регистром', () => {
  const post = (head) => `${head}

📅 17 октября (СБ)
⏰ 22:00 – 04:00
📍 «Режиссёр», Волгоградская, 46/3

В программе:
— Большой танцпол
— Неоновые качели, фотозоны
— Настольный теннис, дартс, настолки 18+
— 4 комнаты сделанные в разных тематических стилях: (ПИКМИ, ПЛОХАЯ ДЕВОЧКА, DALLI, ДЖЕНТЕЛЬМЕНЫ, где мы специально для вас проведём крутые интерактивы
— Электрические кальяны без угля / НОВИНКА В ОРЕНБУРГЕ
— SHOW PROGRAM
— БЕСПЛАТНЫЙ БАР ВСЁ ВРЕМЯ
— WELCOME DRINK

DJ DIZAYNER

Ранняя волна — 790₽ (25 шт)
Вторая волна — 990₽
Заключительная волна — 1490₽

FC | DC - возраст 18+, спортивная одежда запрещена.`;
  for (const head of ['PROJECT X TINDER PARTY\nВЕЧЕРИНКА С БЕСПЛАТНЫМ БАРОМ', 'PROJECT X TINDER PARTY ВЕЧЕРИНКА С БЕСПЛАТНЫМ БАРОМ']) {
    const { draft, found } = parsePost(post(head), { nowMs: Date.parse('2026-10-07T12:00:00+05:00') });
    assert.equal(draft.title, 'PROJECT X TINDER PARTY');
    assert.equal(draft.descr, 'Вечеринка с бесплатным баром. В программе — welcome drink, шоу-программа, 4 комнаты и большой танцпол. За пультом — DJ DIZAYNER. Строго 18+ по паспорту, FC/DC — в спортивной одежде не пустим.');
    assert.equal(found.descrAuto, true, 'описание собрано из программы — ИИ может переписать');
    const titles = draft.program.map((p) => p.title);
    assert.deepEqual(titles, ['Большой танцпол', 'Неоновые качели, фотозоны', 'Настольный теннис, дартс, настолки 18+', '4 комнаты', 'Электрические кальяны без угля', 'Шоу-программа', 'Бесплатный бар всё время', 'Welcome drink']);
    assert.equal(draft.program[3].text, 'Сделанные в разных тематических стилях: ПИКМИ, ПЛОХАЯ ДЕВОЧКА, DALLI, ДЖЕНТЕЛЬМЕНЫ, где мы специально для вас проведём крутые интерактивы.');
    assert.equal(draft.program[4].text, 'НОВИНКА В ОРЕНБУРГЕ.');
    assert.ok(titles.every((t) => !/[\s/,(:-]$/.test(t)), 'заголовок не обрывается на знаке');
    assert.deepEqual(draft.waves.map((w) => [w.name, w.priceRub, w.quota]), [['Ранняя волна', 790, 25], ['Вторая волна', 990, 100], ['Заключительная волна', 1490, 100]]);
  }
});

test('связный текст поста остаётся описанием; условия входа дописываются одной фразой, если их там нет', () => {
  const { draft, found } = parsePost(`ХЭЛЛОУИН
31.10 · 22:00
Лофт «Фабрика», Советская 10
Город переодевается, а мы открываем двери в самую страшную ночь осени: грим, дым и танцпол до утра.
Вход 900₽
18+ FC/DC`, { nowMs: Date.parse('2026-10-07T12:00:00+05:00') });
  assert.equal(draft.descr, 'Город переодевается, а мы открываем двери в самую страшную ночь осени: грим, дым и танцпол до утра. Строго 18+ по паспорту, FC/DC.');
  assert.equal(found.descrAuto, false);
});
