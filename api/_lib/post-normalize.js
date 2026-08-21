// Нормализация результата LLM-анализа поста канала — чистые функции,
// покрыты тестами. LLM может ошибиться: здесь всё проверяется по правилам
// бизнеса, сомнительное — в problems (видит владелец в подтверждении).
const CITY_MAP = {
  'оренбург': 'orenburg',
  'orenburg': 'orenburg',
  'магнитогорск': 'magnitogorsk',
  'магнитка': 'magnitogorsk',
  'magnitogorsk': 'magnitogorsk',
};

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function translitSlug(s, maxLen = 40) {
  const lower = String(s || '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[\s_/.-]/.test(ch)) out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, maxLen) || 'party';
}

export function eventSlug(title, dateIso) {
  const d = String(dateIso || '').replaceAll('-', '').slice(4, 8); // MMDD
  return `th-${translitSlug(title, 28)}${d ? '-' + d : ''}`;
}

// Волны по умолчанию, когда в посте нет цен (стандартный прайс бренда)
export const DEFAULT_WAVES = [
  { waveNo: 1, name: 'Первая волна', priceRub: 300, quota: 100 },
  { waveNo: 2, name: 'Вторая волна', priceRub: 400, quota: 100 },
  { waveNo: 3, name: 'На входе', priceRub: 500, quota: 100 },
];

const TZ_OFFSET = '+05:00'; // Оренбург/Магнитогорск

// extracted: { kind, confidence, event: {...} } из extract.js
// ctx: { nowMs }
export function normalizeAnnouncement(extracted, ctx) {
  const problems = [];
  const ev = (extracted && extracted.event) || {};

  const title = String(ev.title || '').trim().toUpperCase().slice(0, 60) || 'TRAP HOUSE PARTY';
  if (!ev.title) problems.push('название не распознано — подставлено «TRAP HOUSE PARTY»');

  let city = CITY_MAP[String(ev.city || '').trim().toLowerCase()];
  if (!city) {
    if (ev.city) {
      city = translitSlug(ev.city, 20);
      problems.push(`город «${ev.city}» не из базовых — проверь`);
    } else {
      city = 'orenburg';
      problems.push('город не распознан — подставлен Оренбург');
    }
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || '')) ? ev.date : null;
  if (!date) {
    return { ok: false, problems: [...problems, 'дата не распознана — событие не создано'] };
  }
  const timeStart = /^\d{2}:\d{2}$/.test(String(ev.timeStart || '')) ? ev.timeStart : '16:00';
  const timeEnd = /^\d{2}:\d{2}$/.test(String(ev.timeEnd || '')) ? ev.timeEnd : '22:00';
  const startsAt = `${date}T${timeStart}:00${TZ_OFFSET}`;
  let endsAt = `${date}T${timeEnd}:00${TZ_OFFSET}`;
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    // ночной формат: финиш после полуночи
    endsAt = `${nextDay(date)}T${timeEnd}:00${TZ_OFFSET}`;
  }
  if (Date.parse(startsAt) <= ctx.nowMs) {
    return { ok: false, problems: [...problems, `дата ${date} уже в прошлом — событие не создано`] };
  }

  let ageRating = Number.isInteger(ev.ageRating) && [14, 16, 18].includes(ev.ageRating) ? ev.ageRating : 14;
  if (!Number.isInteger(ev.ageRating)) problems.push('возраст не распознан — подставлен 14+');

  let waves = Array.isArray(ev.prices)
    ? ev.prices
        .filter((p) => p && typeof p.name === 'string' && Number.isInteger(p.priceRub))
        .filter((p) => {
          const okPrice = p.priceRub >= 50 && p.priceRub <= 5000;
          if (!okPrice) problems.push(`цена ${p.priceRub} ₽ выглядит странно — отброшена`);
          return okPrice;
        })
        .slice(0, 5)
        .map((p, i) => ({ waveNo: i + 1, name: p.name.slice(0, 40), priceRub: p.priceRub, quota: 100 }))
    : [];
  if (!waves.length) {
    waves = DEFAULT_WAVES;
    problems.push('цены не распознаны — подставлен стандартный прайс 300/400/500');
  }

  const event = {
    id: eventSlug(title, date),
    brand: 'traphouse',
    title,
    city,
    venue: String(ev.venue || '').trim().slice(0, 80) || 'площадка придёт в билете',
    address: null,
    startsAt,
    endsAt,
    ageRating,
    descr: String(ev.descr || '').trim().slice(0, 400) || null,
  };
  return { ok: true, event, waves, problems };
}

function nextDay(dateIso) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Текст-превью для сообщения владельцу с кнопками подтверждения
export function previewText(norm, source) {
  const w = norm.waves.map((x) => `${x.name} — ${x.priceRub} ₽`).join(' · ');
  const lines = [
    `Новый анонс в канале → черновик на сайте:`,
    ``,
    `${norm.event.title}`,
    `${norm.event.city} · ${norm.event.venue}`,
    `${norm.event.startsAt.slice(0, 10)} ${norm.event.startsAt.slice(11, 16)}–${norm.event.endsAt.slice(11, 16)} · ${norm.event.ageRating}+`,
    `Волны: ${w}`,
  ];
  if (norm.problems.length) lines.push(``, `⚠ Проверь: ${norm.problems.join('; ')}`);
  if (source) lines.push(``, `Источник: ${String(source).slice(0, 200)}`);
  return lines.join('\n');
}
