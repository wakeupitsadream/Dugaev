// Анализ поста TG-канала. Два провайдера:
//  - Polza AI (приоритет): российский OpenAI-совместимый агрегатор, оплата
//    в рублях. Чистый fetch на /chat/completions, response_format json_object.
//    Модель и base URL меняются env-переменными без кода.
//  - Anthropic (фолбэк): строгий tool use на Haiku.
// Экономика: пост ≤3000 симв, max_tokens 700, temperature 0, один вызов на
// пост (идемпотентность по update_id в вебхуке) — при 1–2 постах в день
// это единицы рублей в месяц на любой мини-модели.
// Нет ключей/ошибка — вызывающий код деградирует в «переслать владельцу».
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const POLZA_DEFAULT_BASE = 'https://api.polza.ai/api/v1';
const POLZA_DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function pickProvider(env = process.env) {
  if (env.POLZA_API_KEY) return 'polza';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function extractorAvailable() {
  return pickProvider() !== null;
}

// Схема результата — общая для обоих провайдеров
const FIELDS_DOC = `{
  "kind": "announcement | update | cancellation | other",
  "confidence": "high | medium | low",
  "event": {
    "title": "название вечеринки или null",
    "city": "город или null",
    "venue": "клуб/площадка или null",
    "date": "дата вечеринки YYYY-MM-DD или null",
    "timeStart": "HH:MM или null",
    "timeEnd": "HH:MM или null",
    "ageRating": "16 или 18 (число, у бренда почти всегда 18) или null",
    "prices": [{ "name": "название тарифа/волны", "priceRub": 300 }],
    "descr": "описание для страницы ночи: 2-3 живых предложения — что это за ночь, главное из программы (не перечисляй её всю), условия входа (возраст, FC/DC, дресс-код); без цен, дат, адреса и ссылок; или null",
    "address": "улица и дом, например «Волгоградская, 46/3», или null",
    "secret": "true, если адрес держат в секрете (SECRET PLACE), иначе false",
    "lineup": ["имена диджеев и артистов, как в посте"],
    "program": [{ "title": "короткий пункт программы", "text": "одно предложение подробнее или пустая строка" }],
    "targetSlug": "для update/cancellation: слаг существующего события или null"
  }
}`;

function systemPrompt(knownEvents, nowIso) {
  const known = (knownEvents || [])
    .map((e) => `- ${e.id}: ${e.title} (${String(e.startsAt).slice(0, 10)})`)
    .join('\n');
  return (
    `Ты анализируешь посты канала организатора вечеринок PROJECT X ` +
    `(ночные вечеринки строго 18+ в Оренбурге: двери обычно 22:00, старт 23:00, финиш 04:00-06:00; ` +
    `вход по паспорту). timeStart — время открытия дверей (если указано «двери»/«сбор»), иначе старта. ` +
    `prices — только цены входа для всех (волны по порядку); цены для девушек/парней, депозиты, столы и промокоды не включай. ` +
    `program — пункты «что будет» из поста (до 10), lineup — только имена. ` +
    `Сегодня ${nowIso}. Классификация kind: announcement — анонс новой вечеринки с датой; ` +
    `update — изменение цен/условий/места уже анонсированной; cancellation — отмена или перенос; ` +
    `other — всё остальное (фотоотчёты, мемы, розыгрыши, опросы). ` +
    `Извлекай ТОЛЬКО то, что явно написано в посте; чего нет — null. Ничего не выдумывай. ` +
    `Даты вида «21 сентября» относи к ближайшему будущему. ` +
    `Существующие события на сайте:\n${known || '(нет)'}`
  );
}

// Приведение сырого JSON от модели к контракту вебхука.
// Модель может вернуть что угодно — здесь только форма; смысл (даты, цены)
// валидирует normalizeAnnouncement.
export function coerceExtracted(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      // модели иногда заворачивают JSON в ```-заборы
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      obj = JSON.parse(cleaned);
    } catch {
      return { kind: 'error' };
    }
  }
  if (!obj || typeof obj !== 'object') return { kind: 'error' };
  const KINDS = ['announcement', 'update', 'cancellation', 'other'];
  const kind = KINDS.includes(obj.kind) ? obj.kind : 'other';
  const ev = obj.event && typeof obj.event === 'object' ? obj.event : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const num = (v) => (Number.isInteger(v) ? v : Number.isInteger(Number(v)) ? Number(v) : null);
  return {
    kind,
    confidence: ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'low',
    event: {
      title: str(ev.title),
      city: str(ev.city),
      venue: str(ev.venue),
      date: str(ev.date),
      timeStart: str(ev.timeStart),
      timeEnd: str(ev.timeEnd),
      ageRating: num(ev.ageRating),
      prices: Array.isArray(ev.prices)
        ? ev.prices
            .filter((p) => p && typeof p === 'object')
            .map((p) => ({ name: String(p.name || 'Тариф'), priceRub: num(p.priceRub) }))
            .filter((p) => p.priceRub !== null)
        : [],
      descr: str(ev.descr),
      address: str(ev.address),
      secret: ev.secret === true,
      lineup: Array.isArray(ev.lineup) ? ev.lineup.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10) : [],
      program: Array.isArray(ev.program)
        ? ev.program
            .filter((p) => p && typeof p === 'object' && String(p.title || '').trim())
            .map((p) => ({ title: String(p.title).trim().slice(0, 60), text: String(p.text || '').trim().slice(0, 400) }))
            .slice(0, 12)
        : [],
      targetSlug: str(ev.targetSlug),
    },
  };
}

// ---------- Polza AI (OpenAI-совместимый) ----------
async function extractViaPolza(text, knownEvents, nowIso, timeoutMs = 20_000) {
  const base = (process.env.POLZA_BASE_URL || POLZA_DEFAULT_BASE).replace(/\/$/, '');
  const model = process.env.POLZA_MODEL || POLZA_DEFAULT_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${systemPrompt(knownEvents, nowIso)}\n\nОтветь ТОЛЬКО валидным JSON строго такой формы:\n${FIELDS_DOC}`,
          },
          { role: 'user', content: `Пост канала:\n\n${String(text).slice(0, 3000)}` },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`polza extract HTTP ${r.status}`);
      return { kind: 'error' };
    }
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return { kind: 'error' };
    return coerceExtracted(content);
  } catch (e) {
    console.warn('polza extract failed:', e.message);
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Anthropic (фолбэк) ----------
const TOOL = {
  name: 'save_post_analysis',
  description: 'Сохранить результат анализа поста канала вечеринок',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'confidence', 'event'],
    properties: {
      kind: { type: 'string', enum: ['announcement', 'update', 'cancellation', 'other'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      event: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'city', 'venue', 'date', 'timeStart', 'timeEnd', 'ageRating', 'prices', 'descr', 'address', 'secret', 'lineup', 'program', 'targetSlug'],
        properties: {
          title: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          venue: { type: ['string', 'null'] },
          date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
          timeStart: { type: ['string', 'null'], description: 'HH:MM' },
          timeEnd: { type: ['string', 'null'], description: 'HH:MM' },
          ageRating: { type: ['integer', 'null'] },
          prices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'priceRub'],
              properties: { name: { type: 'string' }, priceRub: { type: 'integer' } },
            },
          },
          descr: { type: ['string', 'null'], description: '2-3 предложения для страницы ночи: что за ночь, главное из программы, условия входа; без цен, дат, адреса и ссылок' },
          address: { type: ['string', 'null'] },
          secret: { type: 'boolean' },
          lineup: { type: 'array', items: { type: 'string' } },
          program: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'text'],
              properties: { title: { type: 'string' }, text: { type: 'string' } },
            },
          },
          targetSlug: { type: ['string', 'null'] },
        },
      },
    },
  },
};

async function extractViaAnthropic(text, knownEvents, nowIso, timeoutMs = 20_000, retries = 1) {
  // SDK тяжёлый, а нужен только владельцу при разборе постов: грузим лениво,
  // чтобы холодный старт вебхука не платил за него на каждом сообщении гостя
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: retries });
  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: systemPrompt(knownEvents, nowIso),
      messages: [{ role: 'user', content: `Пост канала:\n\n${String(text).slice(0, 3000)}` }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'save_post_analysis' },
    });
    const call = response.content.find((b) => b.type === 'tool_use');
    if (!call) return { kind: 'error' };
    return coerceExtracted(call.input);
  } catch (e) {
    console.warn('anthropic extract failed:', e.message);
    return { kind: 'error' };
  }
}

// text — текст/подпись поста; knownEvents — [{id,title,startsAt}] для матчинга.
// Из вебхука бота — короче и без повтора: функция живёт 30 секунд, а после
// разбора ещё качается афиша; не успели — черновик соберут правила
export async function extractPost(text, knownEvents, nowIso, { timeoutMs = 20_000, retries = 1 } = {}) {
  const provider = pickProvider();
  if (provider === 'polza') return extractViaPolza(text, knownEvents, nowIso, timeoutMs);
  if (provider === 'anthropic') return extractViaAnthropic(text, knownEvents, nowIso, timeoutMs, retries);
  return { kind: 'unavailable' };
}
