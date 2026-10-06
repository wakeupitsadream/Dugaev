// Бот для владельца (чат TELEGRAM_CHAT_ID): мероприятие из поста, сводка,
// брони на подтверждение, публикация и рассылка анонса подписчикам.
//
// Мероприятие из поста: владелец пересылает боту пост (или шлёт афишу с
// подписью, или длинный текст с датой) → разбор правилами (+ ИИ, если есть
// ключ) → черновик в базе с афишей → карточка с кнопками «Опубликовать»,
// «Править в панели», «Удалить». Черновик на сайте не виден, пока не нажата
// «Опубликовать» — разбор может ошибиться, последнее слово за человеком.
import { parseEventForm } from './event-form.js';
import { saveEvent, uniqueEventId, publishCheck, deleteEvent } from './event-store.js';
import { analyzePost } from './analyze.js';
import { parsePost } from '../../assets/post-parse.js';
import { storeMedia, fetchTelegramFile } from './media.js';
import { runBroadcast, subsCount, broadcastStatus } from './broadcast.js';
import {
  rowsOf, fmtDay, fmtTimeOnly, plural, originOf, escHtml, sender, callOf, posterUrl,
  loadEvent, nearestEvent, eventWaves,
} from './bot-kit.js';
import { fmtRub } from '../../assets/waves.js';

export const OWNER_COMMANDS = [
  { command: 'stats', description: 'Сводка по ближайшей ночи' },
  { command: 'pending', description: 'Брони, которые ждут подтверждения' },
  { command: 'new', description: 'Новое мероприятие из поста' },
  { command: 'buy', description: 'Забронировать проходки' },
  { command: 'tickets', description: 'Мои проходки' },
];

const panelUrl = (deps, hash = '') => `${originOf(deps)}/admin${hash ? `#${hash}` : ''}`;
const fmtPhone = (p) => (/^\+7\d{10}$/.test(String(p)) ? `+7 ${String(p).slice(2, 5)} ${String(p).slice(5, 8)}-${String(p).slice(8, 10)}-${String(p).slice(10)}` : String(p || ''));

// Сообщение владельца → результат или null (не наше — дальше обычный путь гостя)
export async function ownerMessage(msg, deps) {
  const chatId = msg.chat.id;
  const raw = String(msg.text || '').trim();
  const cmd = /^\/(stats|pending|new|admin|panel)(?:@\w+)?$/i.exec(raw);
  if (cmd) {
    const c = cmd[1].toLowerCase();
    if (c === 'stats') return ownerStats(deps, chatId);
    if (c === 'pending') return ownerPending(deps, chatId);
    if (c === 'new') {
      await sender(deps, chatId)(
        '📝 Пришли пост о ночи: афишу с текстом в подписи или просто перешли пост из канала.\n\n' +
          'Соберу черновик страницы — дату, время, площадку, адрес, цены, лайн-ап и программу. ' +
          'Проверишь и опубликуешь одной кнопкой; поправить можно в панели.',
        { inline_keyboard: [[{ text: '✏️ Создать в панели', url: panelUrl(deps, 'events/new') }]] }
      );
      return { done: 'owner_new_hint' };
    }
    await sender(deps, chatId)('Панель организатора:', { inline_keyboard: [[{ text: '🌐 Открыть панель', url: panelUrl(deps) }]] });
    return { done: 'owner_panel' };
  }
  if (raw.startsWith('/')) return null;

  const text = String(msg.text || msg.caption || '').trim();
  const sizes = Array.isArray(msg.photo) ? msg.photo : [];
  const photoId = sizes.length ? sizes[sizes.length - 1].file_id : null;
  const docId = msg.document && /^image\/(jpe?g|png|webp)$/i.test(msg.document.mime_type || '') ? msg.document.file_id : null;
  const fileId = photoId || docId;
  const forwarded = Boolean(msg.forward_origin || msg.forward_from_chat || msg.forward_from || msg.forward_sender_name || msg.forward_date);
  const datey = text.length >= 60 && parsePost(text, { nowMs: deps.nowMs }).found.date;
  if ((forwarded && text.length >= 20) || (fileId && text.length >= 20) || datey) {
    return draftFromPost(deps, chatId, text, fileId);
  }
  if (fileId && !text) return attachPoster(deps, chatId, fileId);
  return null;
}

// Пост → черновик → карточка владельцу
export async function draftFromPost(deps, chatId, text, fileId) {
  const sql = deps.sql;
  const call = callOf(deps);
  await call('sendChatAction', { chat_id: chatId, action: fileId ? 'upload_photo' : 'typing' });
  let known = [];
  try {
    known = rowsOf(await sql.query(
      `SELECT id, title, starts_at FROM events WHERE status IN ('onsale','draft') ORDER BY starts_at LIMIT 20`
    )).map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at }));
  } catch { /* не критично */ }
  const a = await (deps.analyze || analyzePost)(text, {
    nowMs: deps.nowMs, known, extract: deps.extract, ai: Boolean(deps.extractAvailable),
  });
  const d = a.draft;
  if (!d.date) {
    const got = [d.title && `название «${d.title}»`, d.venue && `площадка ${d.venue}`, d.waves.length && `${d.waves.length} ${plural(d.waves.length, 'цена', 'цены', 'цен')}`].filter(Boolean);
    await sender(deps, chatId)(
      `Не нашёл в посте дату ночи — без неё черновик не собрать. Допиши дату (например, 10.10 или 10 октября) и пришли ещё раз.` +
        (got.length ? `\n\nЧто нашёл: ${got.join(', ')}.` : ''),
      { inline_keyboard: [[{ text: '✏️ Создать в панели', url: panelUrl(deps, 'events/new') }]] }
    );
    return { done: 'post_no_date' };
  }

  // афиша: качаем из Telegram и кладём в базу — ссылка не протухнет
  let poster;
  if (fileId) {
    try {
      const buf = await (deps.fetchFile || fetchTelegramFile)(fileId);
      const stored = buf ? await storeMedia(sql, buf) : null;
      poster = stored && stored.ok ? stored.url : `/api/poster?fid=${fileId}`;
    } catch {
      poster = `/api/poster?fid=${fileId}`;
    }
  }
  const parsed = parseEventForm({ ...d, title: d.title || 'PROJECT X', status: 'draft', posterUrl: poster }, { nowMs: deps.nowMs, existing: null });
  if (!parsed.ok) {
    await sender(deps, chatId)(`Черновик не собрался: ${parsed.errors[0].message}. Создай мероприятие в панели — текст поста можно вставить туда.`,
      { inline_keyboard: [[{ text: '✏️ Открыть панель', url: panelUrl(deps, 'events/new') }]] });
    return { done: 'post_invalid', errors: parsed.errors };
  }
  parsed.event.id = await uniqueEventId(sql, parsed.event.id);
  await saveEvent(sql, parsed);
  await sendDraftCard(deps, chatId, parsed.event.id, { notes: a.notes, engine: a.engine });
  return { done: 'draft_from_post', slug: parsed.event.id, engine: a.engine };
}

// Карточка черновика: что разобрано + кнопки
export async function sendDraftCard(deps, chatId, id, { notes = [], engine = 'rules' } = {}) {
  const sql = deps.sql;
  const ev = rowsOf(await sql.query(
    `SELECT id, title, venue, address, secret, starts_at, ends_at, status, poster_url, lineup, to_jsonb(e) -> 'program' AS program
     FROM events e WHERE id = $1`, [id]
  ))[0];
  if (!ev) return null;
  const waves = await eventWaves(sql, id);
  const pub = waves.filter((w) => w.public);
  const lineup = typeof ev.lineup === 'string' ? JSON.parse(ev.lineup) : (ev.lineup || []);
  const program = typeof ev.program === 'string' ? JSON.parse(ev.program) : (ev.program || []);
  const lines = [
    `📝 <b>Черновик готов</b> — проверь и опубликуй\n`,
    `<b>${escHtml(ev.title)}</b>`,
    `📅 ${escHtml(fmtDay(ev.starts_at))} · двери ${escHtml(fmtTimeOnly(ev.starts_at))}${ev.ends_at ? ` · до ${escHtml(fmtTimeOnly(ev.ends_at))}` : ''}`,
    `📍 ${ev.secret ? 'SECRET PLACE — адрес только в проходке' : escHtml([ev.venue, ev.address].filter(Boolean).join(', ') || 'площадка не указана')}`,
    pub.length ? `🎟 ${pub.map((w) => `${escHtml(w.name)} — ${fmtRub(w.priceRub)} ₽`).join(' · ')}` : '🎟 <b>Цен нет</b> — добавь в панели',
    lineup.length ? `🎧 ${escHtml(lineup.slice(0, 4).join(', '))}` : null,
    program.length ? `✨ В программе ${program.length} ${plural(program.length, 'пункт', 'пункта', 'пунктов')}` : null,
    ev.poster_url ? null : '🖼 Афиши нет — пришли картинку следующим сообщением',
  ].filter(Boolean);
  const tips = notes.filter((n) => !/по 100/.test(n) || pub.length).slice(0, 3);
  if (tips.length) lines.push('', `⚠️ Проверь:\n${tips.map((n) => `• ${escHtml(n)}`).join('\n')}`);
  lines.push('', `<i>${engine === 'rules+ai' ? 'Разобрано правилами и ИИ' : 'Разобрано автоматически'} · на сайте не видно, пока не опубликуешь</i>`);
  const markup = {
    inline_keyboard: [
      pub.length
        ? [{ text: '✅ Опубликовать', callback_data: `pub:${id}` }, { text: '🗑 Удалить', callback_data: `del:${id}` }]
        : [{ text: '🗑 Удалить', callback_data: `del:${id}` }],
      [{ text: '✏️ Править в панели', url: panelUrl(deps, `events/${id}`) }],
    ],
  };
  const caption = lines.join('\n');
  const call = callOf(deps);
  const photo = posterUrl(ev.poster_url, deps);
  if (photo && caption.length <= 1024) {
    const r = await call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: markup });
    if (r.ok) return r;
  }
  return call('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true });
}

// Картинка без подписи — афиша к последнему черновику без афиши
async function attachPoster(deps, chatId, fileId) {
  const sql = deps.sql;
  const draft = rowsOf(await sql.query(
    `SELECT id, title FROM events WHERE status = 'draft' AND poster_url IS NULL AND created_at > now() - interval '30 minutes'
     ORDER BY created_at DESC LIMIT 1`
  ))[0];
  if (!draft) {
    await sender(deps, chatId)('Это афиша? Пришли её вместе с текстом поста в подписи (или перешли пост целиком) — соберу черновик мероприятия.');
    return { done: 'owner_photo_hint' };
  }
  let url = `/api/poster?fid=${fileId}`;
  try {
    const buf = await (deps.fetchFile || fetchTelegramFile)(fileId);
    const stored = buf ? await storeMedia(sql, buf) : null;
    if (stored && stored.ok) url = stored.url;
  } catch { /* останется ссылка через Telegram */ }
  await sql.query(`UPDATE events SET poster_url = $2 WHERE id = $1`, [draft.id, url]);
  await sendDraftCard(deps, chatId, draft.id, {});
  return { done: 'poster_attached', slug: draft.id };
}

// Сводка: ближайшая ночь в продаже, иначе последняя
export async function ownerStats(deps, chatId) {
  const sql = deps.sql;
  const ev = (await nearestEvent(sql, deps.nowMs)) || rowsOf(await sql.query(
    `SELECT id, title, venue, address, secret, starts_at, ends_at, status, poster_url FROM events
     WHERE status <> 'draft' ORDER BY starts_at DESC LIMIT 1`
  ))[0];
  if (!ev) {
    await sender(deps, chatId)('Мероприятий пока нет. Пришли пост с афишей — соберу черновик.');
    return { done: 'owner_stats_empty' };
  }
  const s = rowsOf(await sql.query(
    `SELECT
       (SELECT count(*) FROM tickets t WHERE t.event_id = $1 AND t.status = 'active')::int AS sold,
       (SELECT count(*) FROM tickets t WHERE t.event_id = $1 AND t.checked_in_at IS NOT NULL)::int AS inside,
       (SELECT coalesce(sum(amount_rub), 0) FROM orders o WHERE o.event_id = $1 AND o.status = 'paid')::int AS revenue,
       (SELECT count(*) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending')::int AS pend,
       (SELECT coalesce(sum(amount_rub), 0) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending')::int AS pend_rub,
       (SELECT count(*) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending' AND o.claimed_at IS NOT NULL)::int AS claimed`,
    [ev.id]
  ))[0] || {};
  const waves = (await eventWaves(sql, ev.id)).filter((w) => w.public);
  const quota = waves.reduce((x, w) => x + w.quota, 0);
  const subs = await subsCount(sql);
  const text =
    `📊 <b>${escHtml(ev.title)}</b>\n${escHtml(fmtDay(ev.starts_at))} · ${ev.status === 'onsale' ? 'в продаже' : ev.status === 'past' ? 'прошла' : escHtml(ev.status)}\n\n` +
    `🎟 Продано: <b>${s.sold || 0}</b>${quota ? ` из ${quota}` : ''}\n` +
    `💰 Выручка: <b>${fmtRub(s.revenue || 0)} ₽</b>\n` +
    `🕒 Ждут оплаты: ${s.pend || 0} ${plural(Number(s.pend || 0), 'бронь', 'брони', 'броней')}${s.pend ? ` · ${fmtRub(s.pend_rub)} ₽` : ''}${s.claimed ? ` · ${s.claimed} нажали «Я перевёл»` : ''}\n` +
    `🚪 Вошло: ${s.inside || 0}\n` +
    (waves.length ? `\n${waves.map((w) => `${escHtml(w.name)}: ${w.sold}/${w.quota} · ${fmtRub(w.priceRub)} ₽`).join('\n')}\n` : '') +
    `\n🔔 Подписчиков анонсов: ${subs}`;
  await sender(deps, chatId)(text, {
    inline_keyboard: [
      ...(s.pend ? [[{ text: `🕒 Ждут подтверждения (${s.pend})`, callback_data: 'own:pending' }]] : []),
      [{ text: '🌐 Панель', url: panelUrl(deps) }, { text: '🔗 Страница ночи', url: `${originOf(deps)}/e/${ev.id}` }],
    ],
  }, true);
  return { done: 'owner_stats', event: ev.id };
}

// Брони на подтверждение: каждая — сообщением с кнопками «Пришло / Отменить»
export async function ownerPending(deps, chatId) {
  const rows = rowsOf(await deps.sql.query(
    `SELECT o.id, o.pay_code, o.amount_rub, o.qty, o.buyer_name, o.buyer_phone, o.claimed_at, o.expires_at, e.title
     FROM orders o JOIN events e ON e.id = o.event_id
     WHERE o.status = 'pending'
     ORDER BY o.claimed_at DESC NULLS LAST, o.created_at DESC LIMIT 8`
  ));
  const send = sender(deps, chatId);
  if (!rows.length) {
    await send('Никто не ждёт подтверждения ✨');
    return { done: 'owner_pending_none' };
  }
  for (const o of rows) {
    const when = o.claimed_at
      ? `нажал «Я перевёл» в ${fmtTimeOnly(o.claimed_at)}`
      : o.expires_at ? `перевода пока нет · бронь до ${fmtTimeOnly(o.expires_at)}` : 'перевода пока нет';
    await send(
      `${o.claimed_at ? '💸' : '🕒'} ${o.pay_code} · ${fmtRub(o.amount_rub)} ₽ · ${o.qty} шт.\n${o.buyer_name} · ${fmtPhone(o.buyer_phone)}\n${when}\n${o.title}`,
      { inline_keyboard: [[
        { text: `✅ Пришло ${o.pay_code}`, callback_data: `pay:${o.id}` },
        { text: '✖ Отменить бронь', callback_data: `drop:${o.id}` },
      ]] }
    );
  }
  return { done: 'owner_pending', n: rows.length };
}

// Кнопки владельца, которых нет в гостевом потоке: pub/del/bc/own
export async function ownerCallback(action, arg, cb, deps, answer) {
  const sql = deps.sql;
  const chatId = cb.message?.chat?.id || cb.from?.id;
  const stamp = async (line) => {
    if (!cb.message?.message_id || !cb.message?.chat?.id) return;
    const base = cb.message.caption ?? cb.message.text ?? '';
    const method = cb.message.caption !== undefined || cb.message.photo ? 'editMessageCaption' : 'editMessageText';
    await deps.tg(method, {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      ...(method === 'editMessageCaption' ? { caption: `${base}\n\n${line}`.trim() } : { text: `${base}\n\n${line}`.trim(), disable_web_page_preview: true }),
    });
  };

  if (action === 'pub') {
    const check = await publishCheck(sql, arg, deps.nowMs);
    if (!check.ok) {
      await deps.tg('answerCallbackQuery', { callback_query_id: cb.id, text: check.message, show_alert: true });
      return { done: 'publish_blocked', slug: arg };
    }
    const rows = rowsOf(await sql.query(`UPDATE events SET status = 'onsale' WHERE id = $1 AND status = 'draft' RETURNING id`, [arg]));
    if (!rows.length) {
      await answer('Уже обработано');
      return { done: 'noop', slug: arg };
    }
    await answer('Опубликовано — уже на сайте');
    await stamp('✅ Опубликовано — уже на сайте');
    const subs = await subsCount(sql);
    await sender(deps, chatId)(
      `✅ «${check.event.title}» в продаже: ${originOf(deps)}/e/${arg}` +
        (subs ? `\n\nРазослать анонс подписчикам бота (${subs})? Каждый получит афишу и кнопку брони.` : ''),
      { inline_keyboard: [[
        ...(subs ? [{ text: `📣 Разослать (${subs})`, callback_data: `bc:${arg}` }] : []),
        { text: '🌐 Открыть страницу', url: `${originOf(deps)}/e/${arg}` },
      ]] }
    );
    return { done: 'published', slug: arg };
  }

  if (action === 'del') {
    const r = await deleteEvent(sql, arg);
    await answer(r.ok ? 'Удалено' : r.message);
    if (r.ok) {
      await stamp('🗑 Черновик удалён');
      await deps.tg('editMessageReplyMarkup', { chat_id: cb.message?.chat?.id, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } });
    }
    return { done: r.ok ? 'deleted' : 'delete_blocked', slug: arg };
  }

  if (action === 'bc') {
    await answer('Рассылаю…');
    const r = await runBroadcast(deps, arg, { sleep: deps.sleep });
    const status = !r.ok
      ? `Не разослано: ${r.message}`
      : r.message
        ? r.message
        : r.done
          ? `📣 Анонс разослан: доставлено ${r.sent}${r.failed ? `, не дошло ${r.failed} (бот заблокирован или аккаунт удалён — больше не пишем)` : ''}.`
          : `📣 Разослано ${r.sent} из ${r.total}…`;
    await sender(deps, chatId)(status, r.ok && !r.done && !r.busy
      ? { inline_keyboard: [[{ text: '▶️ Продолжить рассылку', callback_data: `bc:${arg}` }]] }
      : undefined);
    return { ...r, finished: Boolean(r.done), done: r.ok ? (r.done ? 'broadcast_done' : 'broadcast_part') : 'broadcast_failed' };
  }

  if (action === 'own') {
    await answer();
    if (arg === 'pending') return ownerPending(deps, chatId);
    return ownerStats(deps, chatId);
  }
  return null;
}

export { broadcastStatus };
