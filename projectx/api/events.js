// Публичная афиша: события + волны с остатками. При недоступной БД молча
// отдаёт сид — гость ошибок не видит, но и выдуманных продаж не видит.
//
// GET /api/events            → { events }
// GET /api/events?page=<id>  → HTML страницы ночи (/e/<id> переписан сюда в
//   vercel.json): тот же event.html, но с заголовком, описанием и афишей
//   именно этой ночи в мета-тегах — превью ссылки в Telegram и VK показывает
//   ночь, а не общую заглушку. Данные ночи вшиты в страницу, поэтому она
//   рисуется сразу, без ожидания /api/events.
import { readFileSync } from 'node:fs';
import { EVENTS } from '../assets/data/events.js';
import { demoWaves, fmtRub } from '../assets/waves.js';
import { addressIsPublic, publicRevealAt } from '../assets/secret-place.js';
import { SITE } from '../assets/data/config.js';
import { db, hasDb, withTimeout } from './_lib/db.js';
import { ok, onlyMethod } from './_lib/respond.js';
import { EXPIRE_SQL } from './_lib/queries.js';
import { paymentMode } from './_lib/booking.js';

// program читаем через to_jsonb(e): колонка появилась в v8, и если схема
// боевой базы ещё не доведена, запрос не должен падать
const EVENTS_SQL = `
SELECT e.id, e.brand, e.title, e.city, e.venue, e.address, e.secret, e.capacity,
       e.starts_at, e.ends_at, e.age_rating, e.status, e.poster_url, e.descr, e.lineup,
       to_jsonb(e) -> 'program' AS program,
       coalesce(
         json_agg(json_build_object(
           'waveNo', w.wave_no, 'name', w.name,
           'priceRub', w.price_rub, 'quota', w.quota, 'sold', w.sold
         ) ORDER BY w.wave_no) FILTER (WHERE w.id IS NOT NULL AND w.public),
         '[]'
       ) AS waves
FROM events e
LEFT JOIN price_waves w ON w.event_id = e.id
WHERE e.status IN ('onsale', 'soldout', 'past') AND ($1::text IS NULL OR e.id = $1)
GROUP BY e.id
ORDER BY e.starts_at`;

export default async function handler(req, res) {
  if (!onlyMethod(req, res, 'GET')) return;
  if (req.query && req.query.page) return page(req, res, String(req.query.page));

  if (hasDb()) {
    try {
      // сгоревшие брони возвращают места до того, как афиша покажет остатки:
      // иначе «всё продано» висело бы до следующего заказа или открытия панели
      try { await withTimeout(db().query(EXPIRE_SQL), 2000); } catch { /* не критично для афиши */ }
      const rows = await withTimeout(db().query(EVENTS_SQL, [null]), 4000);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
      return ok(res, { events: (rows.rows || rows).map((r) => mapRow(r)) });
    } catch (err) {
      console.warn('events: БД недоступна, отдаю сид:', err.message);
    }
  }
  // сид — временная подмена: CDN его не запоминает, следующий заход спросит базу
  res.setHeader('Cache-Control', 'no-store');
  ok(res, { degraded: true, events: EVENTS.map((e) => seedEvent(e)) });
}

function seedEvent(e, nowMs = Date.now()) {
  return {
    ...e,
    status: derivedStatus(e.status, e.startsAt, e.endsAt, nowMs),
    address: !e.secret || addressIsPublic(e) ? e.address : null,
    addressPublicAt: e.secret ? publicRevealAt(e.startsAt) : null,
    // боевой режим: при недоступной БД остатки не выдумываем — sold = 0
    waves: paymentMode() === 'demo'
      ? demoWaves({ ...e, waves: e.waves.filter((w) => w.public !== false) }, nowMs)
      : e.waves.filter((w) => w.public !== false).map((w) => ({ waveNo: w.waveNo, name: w.name, priceRub: w.priceRub, quota: w.quota, sold: 0 })),
  };
}

// Ночь закончилась, а статус «в продаже»: для гостей это уже прошлое —
// в архив, без кнопки покупки (в базе статус меняет владелец)
function derivedStatus(status, startsAt, endsAt, nowMs = Date.now()) {
  if (status !== 'onsale' && status !== 'soldout') return status;
  const end = endsAt ? Date.parse(endsAt) : Date.parse(startsAt) + 8 * 3600_000;
  return Number.isFinite(end) && end <= nowMs ? 'past' : status;
}

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export function mapRow(r, nowMs = Date.now()) {
  const startsAt = toIso(r.starts_at);
  const endsAt = toIso(r.ends_at);
  const status = derivedStatus(r.status, startsAt, endsAt, nowMs);
  const program = json(r.program);
  return {
    id: r.id,
    brand: r.brand,
    title: r.title,
    city: r.city,
    venue: r.venue,
    // SECRET PLACE (флаг secret у ночи): адрес уходит в публичную афишу только
    // за сутки до старта. Купившим он виден сразу — через /api/ticket по
    // подписанному токену. Открытая ночь показывает адрес всем и сразу.
    address: !r.secret || addressIsPublic({ startsAt: r.starts_at, status }, nowMs) ? r.address : null,
    addressPublicAt: r.secret ? publicRevealAt(r.starts_at) : null,
    secret: Boolean(r.secret),
    capacity: r.capacity == null ? null : Number(r.capacity),
    startsAt,
    endsAt,
    ageRating: Number(r.age_rating),
    status,
    posterUrl: r.poster_url,
    descr: r.descr,
    lineup: Array.isArray(json(r.lineup)) ? json(r.lineup) : [],
    program: Array.isArray(program) ? program : [],
    waves: (json(r.waves) || []).map((w) => ({
      waveNo: Number(w.waveNo),
      name: w.name,
      priceRub: Number(w.priceRub),
      quota: Number(w.quota),
      sold: Number(w.sold),
    })),
  };
}

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ---------- страница ночи с мета-тегами ----------
let TEMPLATE = null;
function template() {
  if (TEMPLATE) return TEMPLATE;
  // event.html лежит рядом с api/ (vercel.json: includeFiles)
  TEMPLATE = readFileSync(new URL('../event.html', import.meta.url), 'utf8');
  return TEMPLATE;
}

const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const local = (iso, opts) => new Date(iso).toLocaleString('ru-RU', { timeZone: SITE.tz || 'Asia/Yekaterinburg', ...opts });

export function pageMeta(e, origin) {
  const url = `${SITE.siteUrl || origin}/e/${e.id}`;
  const day = local(e.startsAt, { day: 'numeric', month: 'long' });
  const doors = local(e.startsAt, { hour: '2-digit', minute: '2-digit' });
  const open = e.waves.filter((w) => w.sold < w.quota);
  const from = open.length ? Math.min(...open.map((w) => w.priceRub)) : null;
  const where = [e.venue, e.address].filter(Boolean).join(', ');
  const past = e.status === 'past';
  const title = past
    ? `${e.title} · ${day} · PROJECT X Оренбург`
    : `${e.title} · ${day} · проходки · PROJECT X Оренбург`;
  const description = past
    ? `Как это было: ${day}, ${where}. Ближайшие ночи PROJECT X — на афише.`
    : `${day}, ${where}. ${e.ageRating}+, FC/DC. Двери ${doors}. ` +
      `${from !== null ? `Проходки от ${fmtRub(from)} ₽ — бронь` : 'Бронь'} за минуту, вход по именному QR.`;
  const poster = e.posterUrl ? (/^https?:/.test(e.posterUrl) ? e.posterUrl : `${origin}${e.posterUrl}`) : `${origin}/assets/photos/og-brand.jpg`;
  return { url, title, description, image: poster, from };
}

function jsonLd(e, meta) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: e.title,
    startDate: e.startsAt,
    ...(e.endsAt ? { endDate: e.endsAt } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: e.venue || 'SECRET PLACE',
      address: { '@type': 'PostalAddress', addressLocality: 'Оренбург', addressCountry: 'RU', ...(e.address ? { streetAddress: e.address } : {}) },
    },
    image: [meta.image],
    description: meta.description,
    organizer: { '@type': 'Organization', name: 'PROJECT X', url: SITE.siteUrl },
    typicalAgeRange: `${e.ageRating}-`,
    ...(meta.from !== null && e.status !== 'past'
      ? { offers: { '@type': 'Offer', price: meta.from, priceCurrency: 'RUB', availability: 'https://schema.org/InStock', url: meta.url } }
      : {}),
  };
  return JSON.stringify(ld).replace(/</g, '\\u003c');
}

export function renderPage(html, e, origin) {
  const m = pageMeta(e, origin);
  const head = [
    `<link rel="canonical" href="${escAttr(m.url)}" />`,
    `<meta property="og:url" content="${escAttr(m.url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="PROJECT X Оренбург" />`,
    `<meta property="og:locale" content="ru_RU" />`,
    `<script type="application/ld+json">${jsonLd(e, m)}</script>`,
    `<script type="application/json" id="ev-data">${JSON.stringify(e).replace(/</g, '\\u003c')}</script>`,
  ].join('\n  ');
  // замены — функциями: строка-замена понимает «$&», «$'» и прочие шаблоны,
  // и «$'» в названии ночи из панели размножил бы весь документ
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escAttr(m.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, () => `<meta name="description" content="${escAttr(m.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, () => `<meta property="og:title" content="${escAttr(m.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, () => `<meta property="og:description" content="${escAttr(m.description)}" />`)
    .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, () => `<meta property="og:image" content="${escAttr(m.image)}" />`)
    .replace('</head>', () => `  ${head}\n</head>`);
}

async function page(req, res, slug) {
  // картинки — с того же хоста, что отдал страницу: голый домен уводит на
  // www редиректом, а сборщики превью не всегда идут по нему за афишей
  const host = String(req.headers?.host || '');
  const origin = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)
    ? `https://${host}`
    : String(SITE.siteUrl || 'https://proxject.ru').replace(/\/+$/, '');
  let html;
  try {
    html = template();
  } catch (err) {
    // шаблон не попал в бандл функции — отдаём статическую страницу ночи
    console.warn('events page: нет event.html:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', `/event?id=${encodeURIComponent(slug)}`);
    return res.status(307).end('');
  }
  let e = null;
  // без базы страница всегда из сида — её можно кэшировать
  let answered = !hasDb();
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    if (hasDb()) {
      try {
        // холодный Neon просыпается до пары секунд — ждём с запасом
        const rows = await withTimeout(db().query(EVENTS_SQL, [slug]), 4500);
        answered = true;
        const r = (rows.rows || rows)[0];
        if (r) e = mapRow(r);
      } catch (err) {
        console.warn('events page: БД не ответила:', err.message);
      }
    }
    if (!e) {
      const s = EVENTS.find((x) => x.id === slug);
      if (s) e = seedEvent(s);
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // CDN держит страницу 2 минуты: правка в панели доезжает быстро, а наплыв
  // гостей по ссылке из сторис не будит базу на каждый заход. Запасной ответ
  // (база не ответила, ночь ещё черновик или не найдена) не кэшируем: иначе
  // Telegram и VK запомнили бы пустое превью, а гости 10 минут видели бы
  // «не найдена» или старые данные из сида
  res.setHeader('Cache-Control', answered && e
    ? 'public, max-age=0, s-maxage=120, stale-while-revalidate=600'
    : 'no-store');
  return res.status(200).send(e ? renderPage(html, e, origin) : html);
}
