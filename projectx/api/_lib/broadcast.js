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
import { rowsOf, callOf, posterUrl, originOf, fmtDay, fmtTimeOnly, escHtml, loadEvent, eventWaves } from './bot-kit.js';
import { fmtRub } from '../../assets/waves.js';

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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Одна порция рассылки. → { ok, sent, failed, total, done, busy?, message? }
// Порция ограничена и числом получателей, и временем: функция живёт 30 секунд,
// а прогресс сохраняется после каждой пачки — оборванный запуск не пришлёт
// людям анонс второй раз, следующий продолжит с того же места.
export async function runBroadcast(deps, eventId, { limit = 200, batch = 20, sleep = sleepMs, budgetMs = 12_000, now = Date.now } = {}) {
  const sql = deps.sql;
  const id = `ann-${eventId}`;
  const ev = await loadEvent(sql, eventId);
  if (!ev) return { ok: false, message: 'Мероприятие не найдено' };
  if (ev.status !== 'onsale') return { ok: false, message: 'Рассылать можно только ночь в продаже — сначала опубликуй' };
  await sql.query(
    `INSERT INTO broadcasts (id, event_id, total) VALUES ($1, $2, (SELECT count(*) FROM tg_subs WHERE active))
     ON CONFLICT (id) DO NOTHING`,
    [id, eventId]
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
      message: st.done ? 'Анонс уже разослан' : 'Рассылка уже идёт — подожди минуту',
    };
  }
  const subs = rowsOf(await sql.query(
    `SELECT chat_id FROM tg_subs WHERE active AND chat_id > $1 ORDER BY chat_id LIMIT $2`,
    [Number(lock.cursor), limit]
  )).map((r) => Number(r.chat_id));

  const call = callOf(deps);
  const { caption, markup } = announcement(ev, await eventWaves(sql, eventId), originOf(deps));
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

// Состояние рассылки для панели: не начата / идёт / разослано
export async function broadcastStatus(sql, eventId) {
  try {
    const r = rowsOf(await sql.query(`SELECT sent, failed, total, done FROM broadcasts WHERE id = $1`, [`ann-${eventId}`]))[0];
    return r ? { started: true, sent: Number(r.sent), failed: Number(r.failed), total: Number(r.total), done: Boolean(r.done) } : { started: false };
  } catch {
    return { started: false };
  }
}
