// Ночь в трёх видах: как её отдаёт API, как её правит форма и как её
// принимает /api/event-upsert. Чистые функции — без DOM и сети.

// Площадка в Оренбурге (UTC+5): форма показывает её часы, а не часы
// телефона, с которого открыта панель.
const OFFSET = '+05:00';
const OFFSET_MS = 5 * 3600_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localParts(iso) {
  const d = new Date(Date.parse(iso) + OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

export const emptyForm = () => ({
  title: '', date: '', timeStart: '22:00', timeEnd: '05:00', ageRating: 18,
  venue: '', address: '', secret: false, capacity: '',
  posterUrl: '', descr: '', lineup: [], program: [], waves: [],
});

export function toForm(ev) {
  const st = localParts(ev.startsAt);
  const en = ev.endsAt ? localParts(ev.endsAt) : { time: '05:00' };
  return {
    title: ev.title || '',
    date: st.date,
    timeStart: st.time,
    timeEnd: en.time,
    ageRating: Number(ev.ageRating) === 16 ? 16 : 18,
    venue: ev.venue || '',
    address: ev.address || '',
    secret: Boolean(ev.secret),
    capacity: ev.capacity == null || Number(ev.capacity) === 0 ? '' : String(ev.capacity),
    posterUrl: ev.posterUrl || '',
    descr: ev.descr || '',
    lineup: Array.isArray(ev.lineup) ? ev.lineup.map(String) : [],
    program: Array.isArray(ev.program) ? ev.program.map((p) => ({ title: String(p.title || ''), text: String(p.text || '') })) : [],
    waves: (ev.waves || []).map((w) => ({
      waveNo: Number(w.waveNo),
      name: String(w.name || ''),
      priceRub: Number(w.priceRub),
      quota: Number(w.quota),
      sold: Number(w.sold) || 0,
      public: w.public !== false,
    })),
  };
}

// Копия ночи для следующей даты: место, цены, программа и лайн-ап те же;
// дата и афиша — новые (на старой афише старая дата), продаж нет.
export function copyForm(ev) {
  const f = toForm(ev);
  return { ...f, date: '', posterUrl: '', waves: f.waves.map((w, i) => ({ ...w, waveNo: i + 1, sold: 0 })) };
}

// Разбор поста → поверх текущей формы: заполняем то, что нашлось, остальное
// не трогаем (человек мог уже что-то вписать руками).
export function applyDraft(form, d, { keepWaves = false } = {}) {
  const f = { ...form };
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  for (const k of ['title', 'date', 'timeStart', 'timeEnd', 'venue', 'address', 'descr']) {
    if (has(d[k])) f[k] = String(d[k]);
  }
  if (Number(d.ageRating) === 16 || Number(d.ageRating) === 18) f.ageRating = Number(d.ageRating);
  if (d.secret) f.secret = true;
  if (Array.isArray(d.lineup) && d.lineup.length) f.lineup = d.lineup.map(String).slice(0, 10);
  if (Array.isArray(d.program) && d.program.length) {
    f.program = d.program.slice(0, 16).map((p) => ({ title: String(p.title || ''), text: String(p.text || '') }));
  }
  if (!keepWaves && Array.isArray(d.waves) && d.waves.length) {
    f.waves = d.waves.slice(0, 8).map((w, i) => ({
      waveNo: i + 1,
      name: String(w.name || `Волна ${i + 1}`),
      priceRub: Number(w.priceRub) || 0,
      quota: Number(w.quota) || 100,
      sold: 0,
      public: w.public !== false,
    }));
  }
  return f;
}

export function toBody(f, { id = null, status }) {
  return {
    ...(id ? { id } : {}),
    title: String(f.title).trim(),
    date: f.date,
    timeStart: f.timeStart,
    timeEnd: f.timeEnd,
    ageRating: Number(f.ageRating),
    status,
    venue: String(f.venue).trim(),
    address: String(f.address).trim(),
    secret: Boolean(f.secret),
    capacity: String(f.capacity ?? '').trim() === '' ? '' : Number(f.capacity),
    posterUrl: f.posterUrl || '',
    descr: String(f.descr).trim(),
    lineup: f.lineup.map((x) => String(x).trim()).filter(Boolean),
    program: f.program.map((p) => ({ title: String(p.title).trim(), text: String(p.text).trim() })).filter((p) => p.title),
    waves: f.waves.map((w) => ({
      waveNo: Number(w.waveNo),
      name: String(w.name).trim(),
      priceRub: Number(w.priceRub),
      quota: Number(w.quota),
      public: w.public !== false,
    })),
  };
}

// Начало и конец ночи: финиш раньше старта — значит, утром следующего дня
export function rangeOf(f) {
  if (!DATE_RE.test(f.date) || !TIME_RE.test(f.timeStart)) return null;
  const startsAt = `${f.date}T${f.timeStart}:00${OFFSET}`;
  let endsAt = TIME_RE.test(f.timeEnd) ? `${f.date}T${f.timeEnd}:00${OFFSET}` : null;
  if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    const d = new Date(`${f.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    endsAt = `${d.toISOString().slice(0, 10)}T${f.timeEnd}:00${OFFSET}`;
  }
  return { startsAt, endsAt };
}

// Проверка до отправки — те же правила, что на сервере, но со словами для
// человека и с указанием поля. Сервер всё равно проверит ещё раз.
export function validate(f, status, nowMs = Date.now()) {
  const errs = [];
  if (String(f.title).trim().length < 2) errs.push({ field: 'title', message: 'Как называется ночь?' });
  if (!DATE_RE.test(f.date)) errs.push({ field: 'date', message: 'Выбери дату ночи' });
  if (!TIME_RE.test(f.timeStart)) errs.push({ field: 'timeStart', message: 'Во сколько открываются двери?' });
  if (!TIME_RE.test(f.timeEnd)) errs.push({ field: 'timeEnd', message: 'Во сколько финиш?' });
  const cap = String(f.capacity ?? '').trim();
  if (cap && (!Number.isInteger(Number(cap)) || Number(cap) < 0 || Number(cap) > 20000)) {
    errs.push({ field: 'capacity', message: 'Вместимость — целое число гостей' });
  }
  for (const w of f.waves) {
    const name = String(w.name).trim() || `Волна ${w.waveNo}`;
    const price = String(w.priceRub ?? '').trim();
    const quota = String(w.quota ?? '').trim();
    if (price === '' || !Number.isInteger(Number(price)) || Number(price) < 0 || Number(price) > 50000) {
      errs.push({ field: `wave-${w.waveNo}-price`, message: `«${name}»: цена от 0 до 50 000 ₽` });
    }
    if (quota === '' || !Number.isInteger(Number(quota)) || Number(quota) < 1 || Number(quota) > 5000) {
      errs.push({ field: `wave-${w.waveNo}-quota`, message: `«${name}»: от 1 до 5000 проходок` });
    }
  }
  if (status === 'onsale') {
    if (!f.waves.length) errs.push({ field: 'waves', message: 'Добавь хотя бы одну цену — без неё не продать' });
    else if (!f.waves.some((w) => w.public !== false)) errs.push({ field: 'waves', message: 'Хотя бы одна волна должна быть видна на сайте' });
    const r = rangeOf(f);
    if (r && r.endsAt && Date.parse(r.endsAt) <= nowMs) {
      errs.push({ field: 'date', message: 'Эта ночь уже закончилась — в продажу её не поставить' });
    }
  }
  return errs;
}

// Шаблоны цен для пустой ночи: числа — подсказка, их правят под себя
export const WAVE_TEMPLATES = {
  one: { label: 'Одна цена', hint: 'Проходка — 1 000 ₽ × 200', waves: [{ name: 'Проходка', priceRub: 1000, quota: 200, public: true }] },
  ladder: {
    label: 'Лесенка цен',
    hint: 'Ранняя 700 → Вторая 900 → Последняя 1 100, на входе 1 300',
    waves: [
      { name: 'Ранняя', priceRub: 700, quota: 50, public: true },
      { name: 'Вторая волна', priceRub: 900, quota: 100, public: true },
      { name: 'Последняя волна', priceRub: 1100, quota: 100, public: true },
      { name: 'На входе', priceRub: 1300, quota: 100, public: false },
    ],
  },
};

export const PROGRAM_IDEAS = ['Лазер-шоу', 'Фотозона', 'Welcome-шот', 'Конкурсы и призы', 'Танцпол до утра', 'Бар'];
