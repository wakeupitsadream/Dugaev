// Подписка на анонсы и рассылка «новая ночь» подписчикам бота.
//
// Подписка — только по явному согласию (кнопка «🔔 Сообщать о новых ночах»
// или ссылка t.me/<бот>?start=notify с сайта): анонс платной вечеринки —
// реклама, а реклама по сетям связи — только с согласия получателя.
// Отписка — /stop или кнопка под анонсом.
//
// Рассылка идёт порциями: Telegram пропускает ~30 сообщений в секунду, а
// функция живёт секунды. Курсор и счётчики — в таблице broadcasts, поэтому
// порции можно гнать из панели (кнопка) или из бота («Продолжить»).
import { rowsOf, callOf, posterUrl, originOf, fmtDay, fmtTimeOnly, fmtWhen, escHtml, plural, sender, loadEvent, eventWaves } from './bot-kit.js';
import { fmtRub } from '../../assets/waves.js';
import { SITE } from '../../assets/data/config.js';

// Две рассылки на ночь, у каждой своя строка broadcasts: анонс открытой
// продажи ('ann') и ранний доступ для подписчиков до анонса ('early')
export const bcId = (kind, eventId) => `${kind === 'early' ? 'early' : 'ann'}-${eventId}`;
const needStatus = (kind) => (kind === 'early' ? 'early' : 'onsale');
const wrongStatus = (kind) => (kind === 'early'
  ? 'Ранний доступ закрыт: ночь уже в открытой продаже или снова черновик'
  : 'Рассылать можно только ночь в продаже — сначала опубликуй');

// → { created } новый подписчик, { reactivated } вернулся после /stop,
// { already } уже был в списке — гостю отвечаем по-разному
export async function subscribe(sql, chatId, source = 'bot') {
  const r = rowsOf(await sql.query(
    `WITH prev AS (SELECT active FROM tg_subs WHERE chat_id = $1)
     INSERT INTO tg_subs (chat_id, active, source) VALUES ($1, true, $2)
     ON CONFLICT (chat_id) DO UPDATE SET active = true, updated_at = now()
     RETURNING (SELECT active FROM prev) AS was_active`,
    [chatId, String(source).slice(0, 32)]
  ))[0] || {};
  const was = r.was_active;
  return { created: was === null || was === undefined, reactivated: was === false, already: was === true };
}

export async function unsubscribe(sql, chatId) {
  return rowsOf(await sql.query(
    `UPDATE tg_subs SET active = false, updated_at = now() WHERE chat_id = $1 AND active RETURNING chat_id`, [chatId]
  )).length > 0;
}

export async function isSubscribed(sql, chatId) {
  try {
    return rowsOf(await sql.query(`SELECT 1 FROM tg_subs WHERE chat_id = $1 AND active`, [chatId])).length > 0;
  } catch {
    return false;
  }
}

export async function subsCount(sql) {
  try {
    return Number(rowsOf(await sql.query(`SELECT count(*)::int AS n FROM tg_subs WHERE active`))[0]?.n || 0);
  } catch {
    return 0;
  }
}

export const SUB_BUTTON = { text: '🔔 Сообщать о новых ночах', callback_data: 'sub:on' };

// Владельцу после публикации (кнопкой в боте или из панели): ссылка на
// страницу и предложение разослать анонс подписчикам
export function publishedNotice(origin, slug, title, subs) {
  const url = `${origin}/e/${slug}`;
  return {
    text: `✅ «${title}» в продаже: ${url}` +
      (subs ? `\n\nРазослать анонс подписчикам бота (${subs})? Каждый получит афишу и кнопку брони.` : ''),
    markup: { inline_keyboard: [[
      ...(subs ? [{ text: `📣 Разослать (${subs})`, callback_data: `bc:${slug}` }] : []),
      { text: '🌐 Открыть страницу', url },
    ]] },
  };
}

// Текст анонса: афиша, дата, место, цена — и две кнопки
export function announcement(ev, waves, origin) {
  const open = waves.filter((w) => w.public && w.sold < w.quota);
  const from = open.length ? Math.min(...open.map((w) => w.priceRub)) : null;
  const first = open[0];
  const where = ev.secret ? 'SECRET PLACE — адрес придёт в проходке' : [ev.venue, ev.address].filter(Boolean).join(', ');
  const scarce = first && first.quota - first.sold <= 60 && open.length > 1
    ? ` — первые ${first.quota - first.sold} по этой цене`
    : '';
  const caption =
    `🔥 <b>Новая ночь PROJECT X</b>\n\n<b>${escHtml(ev.title)}</b>\n` +
    `📅 ${escHtml(fmtDay(ev.starts_at))} · двери ${escHtml(fmtTimeOnly(ev.starts_at))}\n` +
    `📍 ${escHtml(where)}\n` +
    (from !== null ? `🎟 Проходки от <b>${fmtRub(from)} ₽</b>${scarce}\n` : '') +
    `\nСтрого 18+, FC/DC. Бронь — прямо здесь, за минуту.\n\n<i>Не присылать анонсы — /stop</i>`;
  const markup = {
    inline_keyboard: [[
      { text: '🎟 Забронировать', callback_data: `buy:${ev.id}` },
      { text: '🌐 Подробнее', url: `${origin}/e/${ev.id}?src=tgbc` },
    ]],
  };
  return { caption, markup };
}

// Ранний доступ: ночи ещё нет на сайте — без ссылки, бронь только здесь
export function earlyAnnouncement(ev, waves) {
  const w = waves.find((x) => x.early && x.sold < x.quota) || null;
  const open = waves.filter((x) => x.public);
  const from = open.length ? Math.min(...open.map((x) => x.priceRub)) : null;
  const left = w ? w.quota - w.sold : 0;
  const where = ev.secret ? 'SECRET PLACE — адрес придёт в проходке' : [ev.venue, ev.address].filter(Boolean).join(', ');
  const caption =
    `🔑 <b>Ранний доступ для своих</b>\n\n<b>${escHtml(ev.title)}</b>\n` +
    `📅 ${escHtml(fmtDay(ev.starts_at))} · двери ${escHtml(fmtTimeOnly(ev.starts_at))}\n` +
    (where ? `📍 ${escHtml(where)}\n` : '') +
    (w ? `🎟 ${left} ${plural(left, 'проходка', 'проходки', 'проходок')} по <b>${fmtRub(w.priceRub)} ₽</b>` +
      `${from !== null && from > w.priceRub ? ` — в открытой продаже будет от ${fmtRub(from)} ₽` : ''}\n` : '') +
    `\nТолько для подписчиков этого бота, до публичного анонса. Бронь — прямо здесь, за минуту.\n\n<i>Не присылать анонсы — /stop</i>`;
  const markup = {
    inline_keyboard: [[
      { text: w ? `🔑 Забронировать за ${fmtRub(w.priceRub)} ₽` : '🔑 Забронировать', callback_data: `buy:${ev.id}` },
    ]],
  };
  return { caption, markup };
}

const contentFor = (kind, ev, waves, origin) => (kind === 'early' ? earlyAnnouncement(ev, waves) : announcement(ev, waves, origin));

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Одна порция рассылки. → { ok, sent, failed, total, done, busy?, message? }
// Порция ограничена и числом получателей, и временем: функция живёт 30 секунд,
// а прогресс сохраняется после каждой пачки — оборванный запуск не пришлёт
// людям анонс второй раз, следующий продолжит с того же места.
export async function runBroadcast(deps, eventId, { kind = 'ann', limit = 200, batch = 20, sleep = sleepMs, budgetMs = 12_000, now = Date.now } = {}) {
  const sql = deps.sql;
  const id = bcId(kind, eventId);
  const ev = await loadEvent(sql, eventId);
  if (!ev) return { ok: false, message: 'Мероприятие не найдено' };
  if (ev.status !== needStatus(kind)) return { ok: false, message: wrongStatus(kind) };
  await sql.query(
    `INSERT INTO broadcasts (id, event_id, kind, total) VALUES ($1, $2, $3, (SELECT count(*) FROM tg_subs WHERE active))
     ON CONFLICT (id) DO NOTHING`,
    [id, eventId, kind === 'early' ? 'early' : 'ann']
  );
  // замок на 90 секунд: две вкладки панели или панель + бот не шлют одно и то же
  const lock = rowsOf(await sql.query(
    `UPDATE broadcasts SET lock_until = now() + interval '90 seconds', updated_at = now()
     WHERE id = $1 AND NOT done AND (lock_until IS NULL OR lock_until < now())
     RETURNING cursor, sent, failed, total, photo_id`,
    [id]
  ))[0];
  if (!lock) {
    const st = rowsOf(await sql.query(`SELECT sent, failed, total, done FROM broadcasts WHERE id = $1`, [id]))[0] || {};
    return {
      ok: true, busy: !st.done, done: Boolean(st.done),
      sent: Number(st.sent || 0), failed: Number(st.failed || 0), total: Number(st.total || 0),
      message: st.done ? (kind === 'early' ? 'Ранний доступ уже разослан' : 'Анонс уже разослан') : 'Рассылка уже идёт — подожди минуту',
    };
  }
  const subs = rowsOf(await sql.query(
    `SELECT chat_id FROM tg_subs WHERE active AND chat_id > $1 ORDER BY chat_id LIMIT $2`,
    [Number(lock.cursor), limit]
  )).map((r) => Number(r.chat_id));

  const call = callOf(deps);
  const { caption, markup } = contentFor(kind, ev, await eventWaves(sql, eventId), originOf(deps));
  let photo = lock.photo_id || posterUrl(ev.poster_url, deps);
  let sent = Number(lock.sent);
  let failed = Number(lock.failed);
  let cursor = Number(lock.cursor);

  const sendOne = async (chatId) => {
    const payload = photo
      ? { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: markup }
      : { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true };
    let r = await call(photo ? 'sendPhoto' : 'sendMessage', payload);
    if (!r.ok && r.code === 429) {
      // Telegram говорит, сколько ждать; дольше двух секунд не стоим —
      // не дошедшее посчитается в «не дошло»
      await sleep(Math.min(2000, Math.max(1000, Number(r.retryAfter || 1.5) * 1000)));
      r = await call(photo ? 'sendPhoto' : 'sendMessage', payload);
    }
    if (!r.ok && photo && r.code === 400 && /photo|file|image|wrong/i.test(String(r.error || ''))) {
      // Telegram не скачал афишу — шлём текстом, дальше без картинки
      photo = null;
      r = await call('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
    }
    return r;
  };

  const started = now();
  let cut = false;
  for (let i = 0; i < subs.length; i += batch) {
    if (i > 0 && now() - started > budgetMs) { cut = true; break; }
    const t0 = Date.now();
    const part = subs.slice(i, i + batch);
    const dead = [];
    // первое сообщение — отдельно: его file_id афиши переиспользуем, чтобы
    // Telegram не качал картинку с сайта для каждого подписчика
    let results;
    if (photo && /^https?:/.test(photo) && i === 0) {
      const head = await sendOne(part[0]);
      const sizes = head.ok && head.result && head.result.photo;
      if (Array.isArray(sizes) && sizes.length) photo = sizes[sizes.length - 1].file_id;
      results = [head, ...(await Promise.all(part.slice(1).map(sendOne)))];
    } else {
      results = await Promise.all(part.map(sendOne));
    }
    results.forEach((r, k) => {
      if (r.ok) sent++;
      else {
        failed++;
        // заблокировал бота или удалил аккаунт — больше не пишем
        if (r.code === 403 || /chat not found|user is deactivated|bot was blocked/i.test(String(r.error || ''))) dead.push(part[k]);
      }
    });
    cursor = part[part.length - 1];
    if (dead.length) {
      await sql.query(`UPDATE tg_subs SET active = false, updated_at = now() WHERE chat_id = ANY($1::bigint[])`, [dead]);
    }
    await sql.query(
      `UPDATE broadcasts SET cursor = $2, sent = $3, failed = $4, photo_id = COALESCE($5, photo_id),
              lock_until = now() + interval '90 seconds', updated_at = now()
       WHERE id = $1`,
      [id, cursor, sent, failed, photo && !/^https?:/.test(photo) ? photo : null]
    );
    const spent = Date.now() - t0;
    if (i + batch < subs.length && spent < 1100) await sleep(1100 - spent);
  }

  const done = !cut && subs.length < limit;
  await sql.query(
    `UPDATE broadcasts SET done = $2, lock_until = NULL, updated_at = now() WHERE id = $1`,
    [id, done]
  );
  const total = Number(lock.total);
  return { ok: true, sent, failed, total: Math.max(total, sent + failed), done };
}

// Состояние рассылки: не начата / запланирована / идёт / разослано.
// started — ушло хотя бы одно сообщение (запись могла появиться и от плана)
export async function broadcastStatus(sql, eventId, kind = 'ann') {
  try {
    const r = rowsOf(await sql.query(
      `SELECT sent, failed, total, done, cursor, scheduled_at FROM broadcasts WHERE id = $1`, [bcId(kind, eventId)]
    ))[0];
    if (!r) return { started: false };
    return {
      started: Number(r.cursor) > 0 || Boolean(r.done),
      sent: Number(r.sent), failed: Number(r.failed), total: Number(r.total), done: Boolean(r.done),
      scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
    };
  } catch {
    return { started: false };
  }
}

// ---------- сначала себе: превью и отправка по времени ----------

// Время площадки (Оренбург, UTC+5) — так же, как его видит владелец
const TZ_OFFSET_MS = 5 * 3600_000;
const localDay = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
const atLocal = (day, hh, mm) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:00`);
const dayPlus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// Кнопки «когда отправить»: ближайшие удобные часы (не раньше чем через 15 минут)
export function sendSlots(nowMs) {
  const today = localDay(nowMs);
  const cands = [
    [today, 12, 'Сегодня 12:00'], [today, 15, 'Сегодня 15:00'], [today, 19, 'Сегодня 19:00'], [today, 21, 'Сегодня 21:00'],
    [dayPlus(today, 1), 12, 'Завтра 12:00'], [dayPlus(today, 1), 19, 'Завтра 19:00'], [dayPlus(today, 2), 12, 'Послезавтра 12:00'],
  ];
  return cands
    .map(([d, h, label]) => ({ at: atLocal(d, h, 0), label }))
    .filter((x) => x.at >= nowMs + 15 * 60_000)
    .slice(0, 4);
}

// «20:30», «в 19», «завтра 18:00», «18.10 19:00», «18.10 в 19:30» → мс или null.
// Только время и оно уже прошло сегодня — значит, завтра. Не дальше двух недель.
export function parseWhen(text, nowMs) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е').trim();
  const tm = /(\d{1,2})(?:[:.\s](\d{2}))?\s*$/.exec(t.replace(/\s*ч(?:ас(?:ов|а)?)?\.?$/, ''));
  if (!tm) return null;
  const hh = Number(tm[1]);
  const mm = Number(tm[2] || 0);
  if (hh > 23 || mm > 59) return null;
  const head = t.slice(0, tm.index);
  const today = localDay(nowMs);
  let day = null;
  const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  const named = /(\d{1,2})\s+([а-я]+)/.exec(head);
  const mon = named ? MONTHS.findIndex((m) => named[2].startsWith(m) && (m !== 'ма' || /^ма[йя]$/.test(named[2]))) : -1;
  const dm = /(\d{1,2})\.(\d{1,2})/.exec(head) || (mon >= 0 ? [null, named[1], String(mon + 1)] : null);
  if (dm) {
    const y = Number(today.slice(0, 4));
    const d = `${y}-${String(Number(dm[2])).padStart(2, '0')}-${String(Number(dm[1])).padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(`${d}T12:00:00Z`))) return null;
    day = d < today ? `${y + 1}${d.slice(4)}` : d;
  } else if (/послезавтра/.test(head)) day = dayPlus(today, 2);
  else if (/завтра/.test(head)) day = dayPlus(today, 1);
  else if (/сегодня/.test(head) || !head.replace(/(?:^|\s)в(?=\s|$)/g, '').trim()) day = today;
  else return null;
  let at = atLocal(day, hh, mm);
  if (!dm && !/завтра|сегодня/.test(head) && at <= nowMs) at = atLocal(dayPlus(today, 1), hh, mm);
  if (at < nowMs + 60_000 || at > nowMs + 14 * 86400_000) return null;
  return at;
}

export async function scheduleBroadcast(sql, eventId, kind, atMs) {
  const r = rowsOf(await sql.query(
    `INSERT INTO broadcasts (id, event_id, kind, total, scheduled_at)
     VALUES ($1, $2, $3, (SELECT count(*) FROM tg_subs WHERE active), $4)
     ON CONFLICT (id) DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, reported = false, updated_at = now()
     WHERE NOT broadcasts.done AND broadcasts.cursor = 0
     RETURNING scheduled_at`,
    [bcId(kind, eventId), eventId, kind === 'early' ? 'early' : 'ann', new Date(atMs).toISOString()]
  ))[0];
  return r ? new Date(r.scheduled_at).toISOString() : null;
}

// Отменить отправку по времени можно, пока не ушло ни одного сообщения
export async function cancelScheduled(sql, eventId, kind) {
  return rowsOf(await sql.query(
    `UPDATE broadcasts SET scheduled_at = NULL, updated_at = now()
     WHERE id = $1 AND NOT done AND cursor = 0 AND scheduled_at IS NOT NULL RETURNING id`,
    [bcId(kind, eventId)]
  )).length > 0;
}

// Пульт под превью: отправить сейчас, по времени или отменить план.
// Короткий код вида: a — анонс, e — ранний доступ
export const kindCode = (kind) => (kind === 'early' ? 'e' : 'a');
export const kindOf = (code) => (code === 'e' ? 'early' : 'ann');
export function previewControls(eventId, kind, subs, nowMs, scheduledAt, origin) {
  const k = kindCode(kind);
  const slots = sendSlots(nowMs).map((x) => ({
    text: `🕒 ${x.label}`, callback_data: `bct:${k}${Math.round(x.at / 60_000).toString(36)}-${eventId}`,
  }));
  const rows = [[{ text: `✅ Отправить сейчас (${subs})`, callback_data: `bcgo:${k}-${eventId}` }]];
  for (let i = 0; i < slots.length; i += 2) rows.push(slots.slice(i, i + 2));
  rows.push([
    { text: '✍️ Другое время', callback_data: `bcw:${k}-${eventId}` },
    { text: '✏️ Править в панели', url: `${origin}/admin#events/${eventId}` },
  ]);
  if (scheduledAt) rows.push([{ text: '✖ Не отправлять по времени', callback_data: `bcx:${k}-${eventId}` }]);
  const what = kind === 'early' ? 'Ранний доступ' : 'Анонс';
  const text =
    `👆 Так увидят подписчики (${subs}). ${what} уходит один раз — проверь афишу, цены и текст.` +
    (scheduledAt ? `\n\n🕒 Запланировано на ${fmtWhen(scheduledAt)}.` : '') +
    '\n\nКогда отправить?';
  return { text, markup: { inline_keyboard: rows } };
}

// Превью владельцу: ровно то сообщение, что получат подписчики, и пульт под ним
export async function sendPreview(deps, chatId, eventId, kind = 'ann') {
  const sql = deps.sql;
  const ev = await loadEvent(sql, eventId);
  if (!ev) return { ok: false, message: 'Мероприятие не найдено' };
  if (ev.status !== needStatus(kind)) return { ok: false, message: wrongStatus(kind) };
  const st = await broadcastStatus(sql, eventId, kind);
  if (st.done) return { ok: false, message: kind === 'early' ? 'Ранний доступ этой ночи уже разослан' : 'Анонс этой ночи уже разослан' };
  const origin = originOf(deps);
  const { caption, markup } = contentFor(kind, ev, await eventWaves(sql, eventId), origin);
  const call = callOf(deps);
  const photo = posterUrl(ev.poster_url, deps);
  let r = photo ? await call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: markup }) : null;
  if (!r || !r.ok) r = await call('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
  const subs = await subsCount(sql);
  const c = previewControls(eventId, kind, subs, deps.nowMs, st.scheduledAt, origin);
  await sender(deps, chatId)(c.text, c.markup);
  return { ok: true, subs };
}

// Владельцу после рассылки по расписанию — что дошло
export function reportText(kind, title, r) {
  const what = kind === 'early' ? 'Ранний доступ' : 'Анонс';
  return `📣 ${what} «${title}» разослан по расписанию: доставлено ${r.sent}` +
    (r.failed ? `, не дошло ${r.failed} (бот заблокирован или аккаунт удалён — больше не пишем)` : '') + '.';
}
// бренд для подписи — из конфига, чтобы тексты не расходились с сайтом
export const BRAND = SITE.brandName || 'PROJECT X';
