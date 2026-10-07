// Разбор поста-анонса (Telegram, Instagram) в черновик мероприятия — без
// ИИ и без сети: дата, время, возраст, цены и волны, площадка, адрес,
// лайн-ап, программа и описание по правилам русского текста афиш.
// Работает в браузере (панель разбирает пост мгновенно) и на сервере (бот,
// /api/event-upsert); если на сервере есть ключ ИИ, его ответ дополняет
// этот разбор, а не заменяет (см. api/_lib/analyze.js).
//
// Результат — сразу в формате формы панели:
//   { draft: { title, date, timeStart, timeEnd, ageRating, venue, address,
//              secret, descr, lineup[], program[{title,text}], waves[] },
//     found: { … }, notes: [ … ] }
// Чего в посте нет — не выдумываем: поле пустое или со значением по
// умолчанию, а в notes — человеческая подсказка, что проверить.

const MONTH_STEMS = [
  ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['ма', 5], ['июн', 6],
  ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12],
];
const MONTH_RE = '(январ[яь]|феврал[яь]|марта?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|августа?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])';
const TIME_SRC = '([01]?\\d|2[0-3])[:.]([0-5]\\d)';

// эмодзи, вариационные селекторы и склейки — из названий и адресов
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu;
const BULLET_RE = /^\s*(?:[-–—•·▪▫◾◽►▶➖➤→✔✓☑*]|\d{1,2}[.)](?![\d.])|\p{Extended_Pictographic}|️)+\s*/u;
const LOC_MARK_RE = /^\s*(?:📍|🏠|🗺|📌)|^\s*(?:место|где|локация|площадка|адрес)\s*[:—–-]/iu;

const VENUE_WORDS = /(арт[- ]?локаци|арт[- ]?пространств|лофт|loft|клуб|club|холл|hall|ресторан|кафе|караоке|пространств|резиденци|террас|коворкинг|галере|studio|студи|(?<![а-яё])бар(?:е|а)?(?![а-яё])|(?<![а-яё])зал(?:е)?(?![а-яё])|(?<![а-яё])дк(?![а-яё])|дом культуры)/i;
// «в лофте «Фабрика»» → «Лофт «Фабрика»»: площадку пишем в именительном
const VENUE_NOMINATIVE = [
  [/^арт[- ]?локаци[июя]/i, 'Арт-локация'], [/^арт[- ]?пространств[еоа]/i, 'Арт-пространство'],
  [/^лофте?/i, 'Лофт'], [/^клубе?/i, 'Клуб'], [/^баре?/i, 'Бар'], [/^зале?/i, 'Зал'], [/^холле?/i, 'Холл'],
  [/^ресторане?/i, 'Ресторан'], [/^кафе/i, 'Кафе'], [/^пространстве/i, 'Пространство'],
  [/^галере[еяи]/i, 'Галерея'], [/^резиденци[ия]/i, 'Резиденция'], [/^студи[ия]/i, 'Студия'],
];
// короткие префиксы улиц — только отдельным словом с точкой или пробелом:
// иначе «Первые 50» превращается в «пер. вые, 50»
const STREET_PREFIX = '(?<![а-яёa-z])(ул\\.|ул(?=\\s)|улица|пр-?т\\.?|проспект|пер\\.|пер(?=\\s)|переулок|ш\\.|шоссе|б-р|бульвар|наб\\.|набережная|пл\\.|площадь|мкр\\.?|проезд|тракт)';
// слова на -ого/-ая/-ий, которые не улицы: «строго 18+», «вторая 1500»
const NOT_STREET = new Set(['строго', 'только', 'всего', 'каждого', 'нового', 'первого', 'второго', 'третьего', 'того', 'много', 'одного', 'вторая', 'первая', 'третья', 'новая', 'ранняя', 'последняя', 'большая', 'главная', 'такая', 'другая', 'поздняя', 'входная', 'тематическая', 'полная', 'обычная', 'общая']);
const SECRET_RE = /(secret\s*place|секретн|адрес\s+(?:сообщим|скинем|при[дш]л[её]м|придёт|придет|узна[её]шь|откроем|в\s+проходке)|локаци[яю]\s+(?:в\s+секрете|скрыт))/i;
const FREE_RE = /(вход\s+(?:свободный|бесплатный)|бесплатный\s+вход|free\s+entry|вход\s+free)/i;
const CTA_RE = /(ссылк|в шапке|в профил|директ|подписыва|бронь стол|бронируй стол|репост|t\.me\/|https?:\/\/|www\.|[a-z0-9-]\.ru(?![а-яё])|(?:^|\s)@[\w.]+)/i;
const LINEUP_HEAD_RE = /^(?:лайн-?ап|line-?up|lineup|за пультом|диджеи|dj['`’]?s|артисты|хедлайнер\w*|headliner\w*)\s*[:—–-]\s*/i;
const PROGRAM_HEAD_RE = /^(?:что\s+(?:тебя|вас)\s+жд[её]т|что\s+внутри|в\s+программе|программа(?:\s+ночи)?|тебя\s+жд[её]т|будет|в\s+этот\s+раз)\s*[:!.]?\s*$/i;
const RULES_RE = /(fc\s*\/\s*dc|фейс-?контрол|дресс-?код|по\s+паспорт|паспорт|спортивн|строго\s+1[468]\s*\+)/i;

const pad2 = (n) => String(n).padStart(2, '0');
const stripEmoji = (s) => String(s || '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const isCaps = (s) => /[А-ЯЁA-Z]/.test(s) && !/[а-яёa-z]/.test(s);
const priceRe = () => /(?:от\s*)?(\d{1,3}(?:[ .]\d{3})+|\d{2,5})\s*(?:₽|руб(?:лей|ля|\.)?|р\.?(?![а-яё])|rub(?![a-z]))/gi;
const priceWordRe = () => /(вход|цена|стоимость|проходк[аи]|билет[ыа]?)\s*[:—–-]?\s*(?:от\s*)?(\d{3,5})(?![\d:.₽])/gi;
const hasPrice = (s) => priceRe().test(s) || priceWordRe().test(s) || FREE_RE.test(s);

// «АРТ ЛОКАЦИЯ РЕЖИССЕР» → «Арт локация Режиссер». Стилизованные имена из
// латиницы и кириллицы («CTUDИЯ CLUB») не трогаем — это бренд площадки.
function tidyCase(s) {
  const t = String(s || '').trim();
  if (!isCaps(t) || /[A-Z]/.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s«"(-])([а-яё])/g, (m, a, b) => a + b.toUpperCase());
}

function cleanLine(raw) {
  return stripEmoji(String(raw || '').replace(BULLET_RE, ''))
    .replace(/^[|·•:—–-]+\s*/, '').replace(/\s*[|·•—–-]+$/, '').trim();
}

// Дата и сегодня — в поясе площадки (Оренбург, UTC+5)
function localToday(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60_000);
  return { y: d.getUTCFullYear(), iso: d.toISOString().slice(0, 10) };
}
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
function validDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function monthOf(word) {
  const w = word.toLowerCase();
  for (const [stem, n] of MONTH_STEMS) if (w.startsWith(stem)) return n;
  return 0;
}
function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Даты строки: «26.09», «26.09.2026», «1 октября», «31/10/2026».
// weak — срок волны («до 25.10», «по 20.09»), а не дата ночи.
function datesIn(line, today) {
  const out = [];
  const withYear = (d, m, y) => {
    let year = y ? (y < 100 ? 2000 + y : y) : today.y;
    if (!validDay(year, m, d)) return null;
    // без года: прошедшая больше недели назад дата — следующий год (анонс января в декабре)
    if (!y && isoDate(year, m, d) < shiftIso(today.iso, -7)) year += 1;
    return validDay(year, m, d) ? isoDate(year, m, d) : null;
  };
  const weakBefore = (i) => /(?:^|[^а-яё])(?:до|по|с)\s*$/i.test(line.slice(Math.max(0, i - 6), i));
  const timeBefore = (i) => /(?:^|[^а-яё])(?:в|к|начало|старт|сбор|двери)\s*$/i.test(line.slice(Math.max(0, i - 10), i));
  let m;
  const num = /(?<![\d.,:/])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?![\d:]|\.\d)/g;
  while ((m = num.exec(line))) {
    if (timeBefore(m.index) && !m[3]) continue; // «в 22.00», «в 23.30» — время
    const iso = withYear(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
    if (iso) out.push({ iso, index: m.index, len: m[0].length, weak: weakBefore(m.index) });
  }
  const word = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:-?го\\s*)?${MONTH_RE}(?:\\s+(\\d{4}))?`, 'gi');
  while ((m = word.exec(line))) {
    const iso = withYear(Number(m[1]), monthOf(m[2]), m[3] ? Number(m[3]) : null);
    if (iso) out.push({ iso, index: m.index, len: m[0].length, weak: weakBefore(m.index) });
  }
  const slash = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g;
  while ((m = slash.exec(line))) {
    const iso = withYear(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.push({ iso, index: m.index, len: m[0].length, weak: weakBefore(m.index) });
  }
  return out.sort((a, b) => a.index - b.index);
}

// Время: двери/старт/финиш по словам рядом; диапазон «22:00–05:00».
// Строки с ценами пропускаем: «девушкам до 23:00 — 500₽» — это не финиш.
function findTimes(lines) {
  const res = { doors: null, start: null, end: null, untilMorning: false };
  const range = new RegExp(`(?<![\\d.])${TIME_SRC}\\s*(?:[-–—]|до)\\s*${TIME_SRC}(?![\\d])`, 'g');
  const single = new RegExp(`(?<![\\d.,])${TIME_SRC}(?![\\d]|\\.\\d)`, 'g');
  for (const L of lines) {
    if (L.blank || L.price) continue;
    const text = L.clean;
    if (/до\s+утра|до\s+последнего\s+гост|till\s+morning/i.test(text)) res.untilMorning = true;
    const used = [];
    let m;
    while ((m = range.exec(text))) {
      if (!res.start) res.start = `${pad2(m[1])}:${m[2]}`;
      if (!res.end) res.end = `${pad2(m[3])}:${m[4]}`;
      used.push([m.index, m.index + m[0].length]);
    }
    while ((m = single.exec(text))) {
      const at = m.index;
      if (used.some(([a, b]) => at >= a && at < b)) continue;
      // «26.09»: точка и «месяц» ≤ 12 — это дата, если перед ней нет «в/с/до»
      const before = text.slice(Math.max(0, at - 22), at).toLowerCase();
      if (text[at + m[1].length] === '.' && Number(m[2]) <= 12 && !/(?:^|[^а-яё])(в|с|до|начало|старт|сбор|двери)\s*$/.test(before)) continue;
      const t = `${pad2(m[1])}:${m[2]}`;
      // слово должно стоять прямо перед временем: в «двери 22:00, финиш 05:00»
      // второе время — финиш, а не ещё одни «двери»
      if (/(двер\w*|сбор\w*|вход\s+с|открыт\w*|open|гост\w*\s+с)\s*(?:в|с|:|[-–—])?\s*$/i.test(before)) res.doors = res.doors || t;
      else if (/(?:^|[^а-яё])(до|финиш|окончан|закрыт|until|till)\s*$/.test(before)) res.end = res.end || t;
      else if (/(старт|начал|start|(?:^|[^а-яё])[вс])\s*$/.test(before)) res.start = res.start || t;
      else if (!res.start && !res.doors) res.start = t;
      else if (!res.end) res.end = t;
    }
  }
  return res;
}

// Имя волны по словам рядом с ценой
function waveName(ctx, index, total) {
  const c = ctx.toLowerCase();
  const first = /перв(?:ые|ых|ая)\s*(\d{1,4})/.exec(c);
  if (first) return { name: `Первые ${first[1]}`, quota: Number(first[1]) };
  const num = /(?<!\d)(\d)\s*(?:-?(?:я|ая|ья))?\s*волн/.exec(c) || /волн[аы]?\s*(?:№\s*)?(\d)(?![\d\s]*(?:₽|р|руб))/.exec(c);
  if (num) return { name: `${num[1]} волна` };
  if (/ранн/.test(c)) return { name: 'Ранняя волна' };
  if (/на\s+входе|на\s+кассе|в\s+день\s+(?:ночи|вечеринки|мероприятия)|на\s+месте|у\s+входа/.test(c)) return { name: 'На входе', door: true };
  if (/втор/.test(c)) return { name: 'Вторая волна' };
  if (/трет/.test(c)) return { name: 'Третья волна' };
  if (/заключит/.test(c)) return { name: 'Заключительная волна' };
  if (/финальн/.test(c)) return { name: 'Финальная волна' };
  if (/последн|поздн/.test(c)) return { name: 'Последняя волна' };
  const until = /до\s+(\d{1,2}\.\d{1,2}|\d{1,2}\s+[а-яё]+)/.exec(c);
  if (until) return { name: `До ${until[1]}` };
  if (/дал|дальше|после|затем|потом|остальн|следующ/.test(c)) return { name: index === 1 ? 'Вторая волна' : 'Следующая волна' };
  return { name: total === 1 ? 'Проходка' : `Волна ${index + 1}` };
}

function findWaves(lines, notes) {
  const raw = [];
  const seen = new Set();
  const flagged = { gender: false, vip: false, promo: false, free: false };
  for (const L of lines) {
    if (L.blank || !L.price) continue;
    if (FREE_RE.test(L.clean)) { flagged.free = true; continue; }
    // сегменты: «ранняя волна 500₽ / вторая волна 700₽ / на входе 1000₽»
    const segs = L.clean.split(/\s+\/\s+|[;|]|,\s+(?!\d{3})/);
    for (const seg of segs) {
      let hits = [...seg.matchAll(priceRe())].map((h) => ({
        rub: Number(String(h[1]).replace(/[ .]/g, '')), at: h.index, len: h[0].length,
      }));
      if (!hits.length) {
        hits = [...seg.matchAll(priceWordRe())].map((h) => ({ rub: Number(h[2]), at: h.index + h[0].lastIndexOf(h[2]), len: h[2].length }));
      }
      hits.forEach((h, k) => {
        const from = k ? hits[k - 1].at + hits[k - 1].len : 0;
        const to = k + 1 < hits.length ? hits[k + 1].at : seg.length;
        const ctx = `${seg.slice(from, h.at)} ${seg.slice(h.at + h.len, Math.min(to, h.at + h.len + 30))}`;
        const c = ctx.toLowerCase();
        if (/девуш|парн|девоч|мальч|для\s+дам|для\s+мужч/.test(c)) { flagged.gender = true; return; }
        if (/депозит|vip|вип|(?<![а-яё])стол(?:ик)?(?:ы|а)?(?![а-яё])|бутыл|кальян/.test(c)) { flagged.vip = true; return; }
        if (/промокод|скидк|-\s*\d+\s*%/.test(c)) { flagged.promo = true; return; }
        if (!Number.isInteger(h.rub) || h.rub < 0 || h.rub > 50000) return;
        const key = `${h.rub}|${c.replace(/[^а-яёa-z0-9]/g, '').slice(0, 24)}`;
        if (seen.has(key)) return;
        seen.add(key);
        // квота: «(100 шт)», «100 проходок»; «первые 50» — в имени волны
        const q = /\(?\s*(\d{1,4})\s*(?:шт|мест|проходок|билетов)\.?\s*\)?/i.exec(seg.slice(h.at + h.len, to));
        raw.push({ rub: h.rub, ctx, quota: q ? Number(q[1]) : null });
      });
    }
  }
  const waves = [];
  if (!raw.length && flagged.free) {
    waves.push({ waveNo: 1, name: 'Бесплатная проходка', priceRub: 0, quota: 100, public: true });
    notes.push('Вход свободный — проходка за 0 ₽: бронь всё равно нужна для списка гостей');
  }
  raw.forEach((w, i) => {
    const n = waveName(w.ctx, i, raw.length);
    waves.push({ waveNo: waves.length + 1, name: n.name, priceRub: w.rub, quota: w.quota || n.quota || 100, public: !n.door });
  });
  if (flagged.gender) notes.push('Цены для девушек и парней в волны не добавлены: сайт продаёт волны по очереди, одну цену для всех');
  if (flagged.vip) notes.push('Депозиты и VIP-столы в волны не добавлены: проходки продаются отдельно от столов');
  if (flagged.promo) notes.push('В посте промокод или скидка — скидки сайт пока не считает');
  if (waves.some((w) => !w.public)) notes.push('Цена «на входе» добавлена скрытой волной: её продаёт касса, на сайте её нет');
  return waves;
}

// Адрес: «Волгоградская 46/3», «ул. Терешковой, 10», «пр-т Победы 15а»
const HOUSE = '(?:д\\.?\\s*)?(\\d{1,4}[а-яА-Я]?(?:\\s*[/к]\\s*\\d{1,3})?)(?![\\d+₽%]|\\s*(?:₽|руб|р\\.|лет|шт|мест|чел|проход|билет|\\+|:))';
function addressIn(text) {
  const withPrefix = new RegExp(`${STREET_PREFIX}\\s*([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z.\\-]{1,24}(?:\\s+[А-ЯЁ][А-ЯЁа-яё.\\-]{1,24})?)[ ,]+${HOUSE}`, 'u');
  let m = withPrefix.exec(text);
  if (m && /^[А-ЯЁA-Z]/.test(m[2])) {
    const prefix = m[1].toLowerCase().replace(/^улица$/, 'ул.').replace(/^ул$/, 'ул.').replace(/^пер$/, 'пер.');
    return { value: `${prefix} ${tidyCase(m[2].trim())}, ${m[3].replace(/\s+/g, '')}`, street: m[2].trim() };
  }
  const bare = new RegExp(`(?<![а-яёa-z])([А-ЯЁ][А-ЯЁа-яё-]{3,}(?:ская|цкая|ской|ой|ий|ый|ая|ова|ева|ина|ына|ого|его))[ ,]+${HOUSE}`, 'gu');
  while ((m = bare.exec(text))) {
    if (NOT_STREET.has(m[1].toLowerCase())) continue;
    const street = tidyCase(m[1]);
    return { value: `${cap(street)}, ${m[2].replace(/\s+/g, '')}`, street: m[1] };
  }
  return null;
}

function nominativeVenue(v) {
  let s = v.trim();
  for (const [re, nom] of VENUE_NOMINATIVE) {
    if (re.test(s)) {
      s = s.replace(re, nom);
      break;
    }
  }
  // «Арт-локация Режиссер» → «Арт-локация «Режиссер»»
  const typed = /^(Арт-локация|Арт-пространство|Лофт|Клуб|Бар|Кафе|Ресторан|Галерея|Резиденция|Студия)\s+([^«"].{1,30})$/.exec(s);
  if (typed && !/\s(?:на|в|у)\s/i.test(typed[2])) s = `${typed[1]} «${typed[2].trim()}»`;
  return s;
}

// Площадка: сначала строки с 📍/«Место:», потом остальные, кроме заголовка
function findVenue(lines, titleIdx, street) {
  const ordered = [...lines.filter((L) => L.loc), ...lines.filter((L) => !L.loc)];
  for (const L of ordered) {
    if (L.blank || L.price || L.idx === titleIdx || L.cta) continue;
    const line = L.clean.replace(/^(?:место|где|локация|площадка|адрес)\s*[:—–-]\s*/i, '');
    if (SECRET_RE.test(line)) return { venue: 'SECRET PLACE', secret: true };
    for (let seg of line.split(/\s*[|·•]\s*|,\s+/)) {
      if (!VENUE_WORDS.test(seg) && !/«[^»]{2,40}»/.test(seg)) continue;
      // дата и день недели в той же фразе: «27 декабря (суббота) в лофте …»
      seg = seg.replace(new RegExp(`(?<!\\d)\\d{1,2}\\s*${MONTH_RE}(?:\\s+\\d{4})?`, 'gi'), ' ')
        .replace(/(?<![\d.])\d{1,2}\.\d{1,2}(?:\.\d{2,4})?/g, ' ')
        .replace(/\((?:[а-яё]{2,11})\)/gi, ' ')
        .replace(new RegExp(TIME_SRC, 'g'), ' ')
        .replace(/(?<!\d)1[468]\s*\+/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
      if (street) {
        const at = seg.toLowerCase().indexOf(street.toLowerCase());
        if (at === 0) continue; // сегмент — это адрес
        if (at > 0) seg = seg.slice(0, at);
      }
      seg = seg.replace(/^(?:[вна]|во)\s+/i, '').replace(/[\s,.:—–-]+$/, '').replace(/^[\s,.:—–-]+/, '').trim();
      if (seg.length >= 3 && seg.length <= 60 && /[а-яёa-z]/i.test(seg)) return { venue: nominativeVenue(tidyCase(seg)), secret: false };
    }
  }
  return { venue: null, secret: false };
}

function stripMeta(s) {
  return s
    .replace(new RegExp(`(?<!\\d)\\d{1,2}\\s*${MONTH_RE}(?:\\s+\\d{4})?`, 'gi'), ' ')
    .replace(/(?<![\d.])\d{1,2}\.\d{1,2}(?:\.\d{2,4})?(?![\d])/g, ' ')
    .replace(new RegExp(`(?<![\\d.])${TIME_SRC}(?:\\s*[-–—]\\s*${TIME_SRC})?`, 'g'), ' ')
    .replace(/(?<!\d)1[468]\s*\+/g, ' ')
    .replace(/\((?:пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)\)/gi, ' ')
    .replace(/\s*[|·•]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:—–-]+|[\s,.:—–-]+$/g, '')
    .trim();
}

// Строка-слоган под названием («ВЕЧЕРИНКА С БЕСПЛАТНЫМ БАРОМ»): капсом,
// короткая, без даты, цены, места и ссылок — это подзаголовок, он идёт
// первой фразой описания, а не в название
function isTagline(L) {
  if (!L || L.blank || L.price || L.cta || L.loc || L.hashtag || L.secret || L.rules || L.dates.length) return false;
  const t = stripMeta(L.clean);
  return t.length >= 8 && t.length <= 50 && isCaps(t) && /[А-ЯЁ]{3}/.test(t) && t.split(/\s+/).length >= 2
    && !VENUE_WORDS.test(t) && !PROGRAM_HEAD_RE.test(L.clean) && !LINEUP_HEAD_RE.test(L.clean)
    && !new RegExp(`(?<![\\d.])${TIME_SRC}`).test(L.clean);
}

function findTitle(lines) {
  const firsts = lines.filter((L) => !L.blank).slice(0, 4);
  for (let i = 0; i < firsts.length; i++) {
    const L = firsts[i];
    if (L.cta || L.hashtag || L.price || PROGRAM_HEAD_RE.test(L.clean) || LINEUP_HEAD_RE.test(L.clean) || L.loc) continue;
    let t = stripMeta(L.clean);
    if (t.length < 3 || !/[а-яёa-z]{2}/i.test(t)) continue;
    if (VENUE_WORDS.test(t) && !/project\s*x/i.test(t) && !isCaps(t)) continue;
    // «PROJECT X» отдельной строкой + название следующей — склеиваем
    if (/^project\s*x$/i.test(t) && firsts[i + 1]) {
      const next = stripMeta(firsts[i + 1].clean);
      if (next.length >= 3 && next.length <= 40 && isCaps(next) && !firsts[i + 1].price) {
        return { title: `${t} — ${next}`.slice(0, 60), idx: L.idx, idx2: firsts[i + 1].idx, tagline: '' };
      }
    }
    // «PROJECT X TINDER PARTY ВЕЧЕРИНКА С БЕСПЛАТНЫМ БАРОМ» одной строкой:
    // латинское название + русский слоган капсом — делим на два
    const split = /^([A-Z0-9][A-Z0-9 :&'’.!×x-]*?[A-Z0-9!])\s+([А-ЯЁ][А-ЯЁ0-9 ,.!«»"-]{6,})$/.exec(t);
    if (split && t.length > 30 && split[1].split(/\s+/).length >= 2 && split[2].split(/\s+/).length >= 2) {
      return { title: split[1], idx: L.idx, tagline: split[2] };
    }
    if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '');
    // слоган строкой ниже
    const next = firsts[i + 1];
    if (next && !/^project\s*x$/i.test(t) && isTagline(next)) return { title: t, idx: L.idx, idx2: next.idx, tagline: stripMeta(next.clean) };
    return { title: t, idx: L.idx, tagline: '' };
  }
  return { title: null, idx: -1, tagline: '' };
}

function findLineup(lines) {
  const out = [];
  const used = new Set();
  for (const L of lines) {
    if (L.blank || L.price) continue;
    const head = LINEUP_HEAD_RE.test(L.clean);
    const named = /(?:^|[\s,(])(?:DJ|MC|Dj)\s+[A-ZА-ЯЁ0-9]/.test(L.clean);
    if (!head && !named) continue;
    used.add(L.idx);
    const body = L.clean.replace(LINEUP_HEAD_RE, '');
    const parts = body.split(/\s+(?:x|х|b2b|&|и)\s+(?=(?:DJ|MC)\s)|\s*[,/•·]\s*/).map((p) => p.trim()).filter((p) => p.length >= 2);
    for (const p of parts) if (out.length < 8 && !out.includes(p)) out.push(p.slice(0, 60));
  }
  return { lineup: out, used };
}

// Капс в строке поста — крик, а не смысл: «БЕСПЛАТНЫЙ БАР ВСЁ ВРЕМЯ» →
// «Бесплатный бар всё время». Короткие латинские сокращения (DJ, MC, PS5,
// FC/DC) и слова с цифрами оставляем как есть.
const PHRASES = { 'show program': 'Шоу-программа', 'шоу программа': 'Шоу-программа' };
const KEEP_CAPS = /^(?:[A-Z]{1,3}\d*|[A-Z]+\/[A-Z]+|\S*\d\S*)$/;
function sentenceCase(s) {
  const t = String(s || '').trim();
  if (!isCaps(t)) return t;
  return cap(t.split(/(\s+)/).map((w) => (KEEP_CAPS.test(w) ? w : w.toLowerCase())).join(''));
}
const lowerFirst = (s) => (/^[А-ЯЁA-Z][а-яёa-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
// хвост заголовка не обрывается на предлоге, союзе или знаке
const DANGLING = new Set(['в', 'во', 'на', 'с', 'со', 'и', 'а', 'для', 'по', 'из', 'к', 'у', 'о', 'об', 'от', 'до', 'за', 'под', 'над', 'при', 'без', 'через', 'или', 'где', 'что', 'как', 'же']);
function tidyTitle(s) {
  let t = String(s || '').replace(/[\s,;:/|(«"—–-]+$/, '').trim();
  if (t.length > 40) t = t.slice(0, 38).replace(/\s+\S*$/, '');
  const words = t.split(/\s+/);
  while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').replace(/[\s,;:/|(«"—–-]+$/, '').trim();
}
// непарную скобку из обрезанной строки поста убираем
function balance(s) {
  let t = s;
  if ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) t = t.replace(/\(\s*/, '');
  if ((t.match(/\)/g) || []).length > (t.match(/\(/g) || []).length) t = t.replace(/\s*\)(?!.*\))/, '');
  return t;
}

// Пункт программы: короткий заголовок + пояснение. Короткая строка — целиком
// заголовок; длинная делится на естественной границе (двоеточие, «/», тире,
// скобка, запятая), а причастный или придаточный оборот уходит в пояснение:
// «4 комнаты сделанные в разных стилях: …» → «4 комнаты» + «Сделанные в…»
function toProgramItem(text) {
  let t = sentenceCase(text.replace(/[.;]+$/, '').trim());
  t = cap(PHRASES[t.toLowerCase()] || t);
  if (!t) return null;
  if (t.length <= 40) return { title: tidyTitle(t) || t, text: '' };
  const m = /\s*:\s*|\s+\/\s*|\/\s+|\s+[—–-]\s+|\s*\(|,\s*/.exec(t);
  let title = m && m.index >= 3 ? t.slice(0, m.index) : t;
  const clause = /\s(?:сделанн|созданн|оформленн|посвящ[её]нн|выполненн|которы|где\s|чтобы\s)/i.exec(title);
  if (clause && clause.index >= 3) title = title.slice(0, clause.index);
  title = tidyTitle(title);
  const rest = balance(t.slice(title.length).replace(/^[\s,;:/|(—–-]+/, '').trim());
  return { title, text: rest ? `${cap(rest.replace(/[.;,]+$/, ''))}.` : '' };
}

// Главное из программы — для описания: бар, welcome, шоу и т.п. вперёд,
// не больше четырёх, без того, что уже сказано в слогане
const HIGHLIGHT = [/бар(?![а-яё]{3})/i, /welcome|велком/i, /шоу|show/i, /фонтан/i, /комнат/i, /танцпол/i, /кальян/i, /конкурс|приз/i, /караоке|турнир|игр/i, /фото/i];
function highlights(program, tagline, n = 4) {
  const said = String(tagline || '').toLowerCase();
  const scored = program
    .map((p, i) => {
      const phrase = lowerFirst(p.title.split(/,\s*/)[0].trim());
      const k = HIGHLIGHT.findIndex((re) => re.test(p.title));
      return { phrase, i, k: k < 0 ? 99 : k };
    })
    .filter((x) => x.phrase.length >= 3 && !(said && said.includes(x.phrase.toLowerCase().slice(0, 5))));
  scored.sort((a, b) => a.k - b.k || a.i - b.i);
  return scored.slice(0, n).map((x) => x.phrase);
}
const listRu = (xs) => (xs.length < 2 || / и /.test(xs[xs.length - 1])
  ? xs.join(', ')
  : `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}`);

// Условия входа — одной фразой бренда, а не обрывком строки поста
function conditions(rulesText, ageRating, ageFound) {
  const fcdc = /fc\s*[|/\\]\s*dc|фейс-?контрол|дресс-?код/i.test(rulesText);
  const sport = /спортивн/i.test(rulesText);
  if (!fcdc && !sport && !ageFound) return '';
  let s = `Строго ${ageRating}+${/паспорт/i.test(rulesText) || ageFound ? ' по паспорту' : ''}`;
  if (fcdc) s += ', FC/DC';
  if (sport) s += ' — в спортивной одежде не пустим';
  return `${s}.`;
}

// Описание ночи: связный текст поста, если он есть; иначе — короткий
// рассказ из разобранного: слоган, главное из программы, кто за пультом,
// условия входа. Весь список программы — в блоках «Что внутри», не здесь.
function buildDescr({ tagline, prose, program, lineup, rulesText, ageRating, ageFound }) {
  const lead = tagline ? `${sentenceCase(tagline).replace(/[.!…]+$/, '')}.` : '';
  const text = prose.map(sentenceCase).map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`)).join(' ');
  if (text.length >= 60) {
    const cond = conditions(rulesText, ageRating, ageFound);
    const body = [lead, text].filter(Boolean).join(' ');
    return { descr: [body, cond && !/fc\s*\/\s*dc|паспорт|спортивн/i.test(body) ? cond : ''].filter(Boolean).join(' '), auto: false };
  }
  const hi = highlights(program, tagline);
  if (!lead && !hi.length) return { descr: text, auto: false };
  const parts = [lead, text];
  if (hi.length) parts.push(`В программе — ${listRu(hi)}.`);
  if (lineup.length) parts.push(`За пультом — ${listRu(lineup.slice(0, 3))}.`);
  parts.push(conditions(rulesText, ageRating, ageFound));
  return { descr: parts.filter(Boolean).join(' '), auto: true };
}

// text → { draft, found, notes }
export function parsePost(text, { nowMs = Date.now(), offsetMin = 300 } = {}) {
  const src = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​‌⁠]/g, '');
  const today = localToday(nowMs, offsetMin);
  const notes = [];

  // ---- разметка строк: пустые сохраняем, они разделяют блоки поста ----
  const lines = src.split('\n').map((raw, idx) => {
    const t = raw.trim();
    const clean = cleanLine(t);
    return {
      idx, raw: t, clean, blank: !clean,
      bullet: BULLET_RE.test(t) && !/^\d{1,2}[.)]\d/.test(t),
      loc: LOC_MARK_RE.test(t),
      price: Boolean(clean) && hasPrice(clean),
      cta: CTA_RE.test(clean),
      hashtag: /^#/.test(t) || /^(?:#[\wа-яё]+\s*)+$/i.test(clean),
      secret: SECRET_RE.test(clean),
      rules: RULES_RE.test(clean),
      dates: clean ? datesIn(clean, today) : [],
    };
  });

  // ---- дата ночи: первая будущая «сильная» дата (не срок волны) ----
  const all = lines.flatMap((L) => (L.price ? L.dates.map((d) => ({ ...d, weak: true })) : L.dates));
  const strong = all.filter((d) => !d.weak);
  const pick = strong.find((d) => d.iso >= today.iso) || strong[0] || null;
  const date = pick ? pick.iso : null;
  if (!date) notes.push('Дата не найдена — укажи её вручную');
  else if (date < today.iso) notes.push(`Дата ${date.split('-').reverse().join('.')} уже прошла — проверь число и год`);

  // ---- время ----
  const times = findTimes(lines);
  const timeStart = times.doors || times.start || null;
  const timeEnd = times.end || null;
  if (!timeStart) notes.push('Время начала не найдено — стоит 22:00');
  if (!timeEnd) notes.push(times.untilMorning ? '«До утра» — поставили финиш 05:00' : 'Время окончания не найдено — стоит 04:00');

  // ---- возраст ----
  const flat = lines.map((L) => L.clean).join('\n');
  const ageM = /(?<!\d)(14|16|18|21)\s*\+/.exec(flat) || /(?<!\d)(16|18)\s*лет/.exec(flat);
  let ageRating = ageM ? Number(ageM[1]) : 18;
  if (ageM && ![16, 18].includes(ageRating)) {
    notes.push(`В посте ${ageRating}+ — на сайте бывает 16+ или 18+, поставили 18+`);
    ageRating = 18;
  }

  // ---- название ----
  const { title, idx: titleIdx, idx2: titleIdx2, tagline } = findTitle(lines);
  if (!title) notes.push('Название не найдено — впиши его');

  // ---- адрес и площадка ----
  const secret = lines.some((L) => L.secret);
  let address = null;
  if (!secret) {
    const addrLines = [...lines.filter((L) => L.loc), ...lines.filter((L) => !L.loc && !L.price && L.idx !== titleIdx)];
    for (const L of addrLines) {
      if (L.blank) continue;
      const a = addressIn(L.clean);
      if (a) { address = a; break; }
    }
  }
  let venue = secret ? 'SECRET PLACE' : findVenue(lines, titleIdx, address?.street).venue;
  if (!venue && !secret) notes.push('Площадка не найдена — впиши название');
  if (!address && !secret) notes.push('Адрес не найден — впиши его или включи SECRET PLACE');

  // ---- цены ----
  const waves = findWaves(lines, notes);
  if (!waves.length) notes.push('Цены не найдены — добавь хотя бы одну волну');
  else if (waves.some((w) => w.quota === 100 && !/^Первые/.test(w.name))) notes.push('Сколько проходок в волнах, в посте нет — стоит по 100, проверь');

  // ---- лайн-ап, программа, описание ----
  const { lineup, used } = findLineup(lines);
  const program = [];
  const prose = [];
  const rules = [];
  let inProgram = false;
  const streetLc = address ? address.street.toLowerCase() : null;
  for (const L of lines) {
    if (L.blank) { inProgram = false; continue; }
    if (used.has(L.idx) || L.idx === titleIdx || L.idx === titleIdx2 || L.hashtag) continue;
    if (PROGRAM_HEAD_RE.test(L.clean)) { inProgram = true; continue; }
    const timeLine = new RegExp(`(?<![\\d.])${TIME_SRC}`).test(L.clean) && L.clean.length < 70;
    const meta = L.price || L.cta || L.loc || L.secret || timeLine
      || (L.dates.length && L.clean.length < 70)
      || (streetLc && L.clean.toLowerCase().includes(streetLc))
      || /^(?:место|где|локация|площадка|адрес|вход|время|начало|старт|двери|сбор|цена|билеты|проходки)\s*[:—–-]/i.test(L.clean);
    if (meta) continue;
    // правила входа — в описание одной фразой бренда (см. conditions)
    if (L.rules) { rules.push(L.clean); continue; }
    if ((L.bullet || inProgram) && L.clean.length >= 6) {
      const item = toProgramItem(L.clean);
      if (item && program.length < 12) program.push(item);
      continue;
    }
    if (L.clean.length >= 20 && /[а-яё]{3}/i.test(L.clean)) prose.push(L.clean);
  }
  const built = buildDescr({ tagline, prose, program, lineup, rulesText: rules.join(' '), ageRating, ageFound: Boolean(ageM) });
  let descr = built.descr.replace(/\s{2,}/g, ' ').trim();
  if (descr.length > 700) descr = `${descr.slice(0, 700).replace(/\s+\S*$/, '')}…`;

  const draft = {
    title: title ? title.toUpperCase().slice(0, 60) : '',
    date: date || '',
    timeStart: timeStart || '22:00',
    timeEnd: timeEnd || (times.untilMorning ? '05:00' : '04:00'),
    ageRating,
    venue: venue || '',
    address: address ? address.value : '',
    secret,
    descr,
    lineup,
    program,
    waves,
  };
  const found = {
    title: Boolean(title), date: Boolean(date), timeStart: Boolean(timeStart), timeEnd: Boolean(timeEnd),
    age: Boolean(ageM), venue: Boolean(venue), address: Boolean(address) || secret, waves: waves.length,
    lineup: lineup.length, program: program.length, descr: descr.length >= 40,
    // описание собрано из программы, а не взято из текста поста: ИИ (если
    // подключён) может написать лучше
    descrAuto: built.auto,
  };
  return { draft, found, notes };
}
