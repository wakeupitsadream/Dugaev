// Разбор и проверка формы события из админки — чистые функции без БД,
// покрыты тестами. Всё, что зависит от Postgres, живёт в api/event-upsert.js.
import { translitSlug } from './post-normalize.js';

const TZ_OFFSET = '+05:00'; // Оренбург
const STATUSES = ['draft', 'onsale', 'past'];
const AGES = [16, 18];

const isDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 2026-02-31 → нет
};
// Часы 00–23, минуты 00–59: одного «четыре цифры с двоеточием» мало —
// иначе 25:99 доедет до Date.parse и превратит диапазон в NaN.
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

// Слаг нового события: px-<название>-<MMDD>. Для существующего id не меняется
// никогда — иначе оборвутся ссылки на билеты и QR уже проданных проходок.
export function makeEventId(title, dateIso) {
  const mmdd = String(dateIso || '').replaceAll('-', '').slice(4, 8);
  return `px-${translitSlug(title, 28)}${mmdd ? '-' + mmdd : ''}`;
}

// Следующий календарный день — для ночных событий (23:00 → 06:00 назавтра)
function nextDay(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Собирает начало и конец с фиксированным поясом площадки (браузер админа
// может быть в любом поясе — на это опираться нельзя).
export function buildRange(date, timeStart, timeEnd) {
  const startsAt = `${date}T${timeStart}:00${TZ_OFFSET}`;
  let endsAt = `${date}T${timeEnd}:00${TZ_OFFSET}`;
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    endsAt = `${nextDay(date)}T${timeEnd}:00${TZ_OFFSET}`;
  }
  return { startsAt, endsAt };
}

// body формы → { ok, event, waves, warnings } | { ok: false, errors }
// existing: { id, waves: [{waveNo, sold}] } — текущее состояние события в БД
// (для проверки квот и вычисления сносимых волн); null для нового.
export function parseEventForm(body, ctx = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const warnings = [];
  const nowMs = ctx.nowMs ?? 0;
  const existing = ctx.existing || null;

  const title = String(b.title || '').trim().slice(0, 60);
  if (title.length < 2) errors.push({ field: 'title', message: 'Название — минимум 2 символа' });

  const date = isDate(b.date) ? b.date : null;
  if (!date) errors.push({ field: 'date', message: 'Дата в формате ГГГГ-ММ-ДД' });

  const timeStart = isTime(b.timeStart) ? b.timeStart : null;
  const timeEnd = isTime(b.timeEnd) ? b.timeEnd : null;
  if (!timeStart) errors.push({ field: 'timeStart', message: 'Время начала в формате ЧЧ:ММ' });
  if (!timeEnd) errors.push({ field: 'timeEnd', message: 'Время окончания в формате ЧЧ:ММ' });

  const status = STATUSES.includes(b.status) ? b.status : null;
  if (!status) errors.push({ field: 'status', message: 'Статус: черновик, в продаже или прошедшее' });

  const ageRating = AGES.includes(Number(b.ageRating)) ? Number(b.ageRating) : null;
  if (!ageRating) errors.push({ field: 'ageRating', message: 'Возраст: 16+ или 18+' });

  const venue = String(b.venue || '').trim().slice(0, 80) || 'площадка придёт в билете';
  const descr = String(b.descr || '').trim().slice(0, 400) || null;

  // ---- волны ----
  const rawWaves = Array.isArray(b.waves) ? b.waves.slice(0, 6) : [];
  if (!rawWaves.length) errors.push({ field: 'waves', message: 'Нужна хотя бы одна волна цен' });
  const soldByNo = new Map((existing?.waves || []).map((w) => [Number(w.waveNo), Number(w.sold) || 0]));
  const waves = [];
  rawWaves.forEach((w, i) => {
    const waveNo = Number.isInteger(Number(w?.waveNo)) && Number(w.waveNo) > 0 ? Number(w.waveNo) : i + 1;
    const name = String(w?.name || '').trim().slice(0, 40) || `Волна ${waveNo}`;
    const priceRub = Number(w?.priceRub);
    const quota = Number(w?.quota);
    if (!Number.isInteger(priceRub) || priceRub < 0 || priceRub > 50000) {
      errors.push({ field: `wave-${waveNo}-price`, message: `«${name}»: цена от 0 до 50 000 ₽` });
      return;
    }
    if (!Number.isInteger(quota) || quota < 1 || quota > 5000) {
      errors.push({ field: `wave-${waveNo}-quota`, message: `«${name}»: квота от 1 до 5000` });
      return;
    }
    const sold = soldByNo.get(waveNo) || 0;
    if (quota < sold) {
      // не ошибка: квоту поднимаем до проданного, но владелец должен знать
      warnings.push(`«${name}»: уже продано ${sold} — квота поднята до ${sold}`);
    }
    waves.push({ waveNo, name, priceRub, quota: Math.max(quota, sold) });
  });
  if (new Set(waves.map((w) => w.waveNo)).size !== waves.length) {
    errors.push({ field: 'waves', message: 'Номера волн повторяются' });
  }

  // волны, убранные из формы: снести можно только непроданные
  const keep = waves.map((w) => w.waveNo);
  const doomed = (existing?.waves || []).filter((w) => !keep.includes(Number(w.waveNo)));
  for (const d of doomed) {
    if (Number(d.sold) > 0) {
      errors.push({
        field: `wave-${d.waveNo}`,
        message: `Волну ${d.waveNo} нельзя удалить: по ней продано ${d.sold}`,
      });
    }
  }

  if (errors.length) return { ok: false, errors };

  const { startsAt, endsAt } = buildRange(date, timeStart, timeEnd);
  if (status === 'onsale' && Date.parse(startsAt) <= nowMs) {
    return {
      ok: false,
      errors: [{ field: 'date', message: 'Дата уже прошла — в продажу такое событие не поставить' }],
    };
  }

  const id = String(b.id || '').trim() || makeEventId(title, date);
  return {
    ok: true,
    event: {
      id,
      brand: 'projectx',
      title: title.toUpperCase(),
      city: 'orenburg',
      venue,
      address: String(b.address || '').trim().slice(0, 120) || 'Оренбург',
      startsAt,
      endsAt,
      ageRating,
      status,
      descr,
    },
    waves,
    prune: doomed.map((w) => Number(w.waveNo)),
    warnings,
  };
}
