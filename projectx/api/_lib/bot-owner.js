// Бот для владельца (чат TELEGRAM_CHAT_ID): мероприятие из поста, сводка,
// брони на подтверждение, публикация и рассылка анонса подписчикам.
//
// Мероприятие из поста: владелец пересылает боту пост (или шлёт афишу с
// подписью, или длинный текст с датой) → разбор правилами (+ ИИ, если есть
// ключ) → черновик в базе с афишей → карточка с кнопками «Опубликовать»,
// «Править в панели», «Удалить». Черновик на сайте не виден, пока не нажата
// «Опубликовать» — разбор может ошибиться, последнее слово за человеком.
import { parseEventForm } from './event-form.js';
import { saveEvent, uniqueEventId, publishCheck, deleteEvent, openEarly } from './event-store.js';
import { analyzePost } from './analyze.js';
import { parsePost } from '../../assets/post-parse.js';
import { storeMedia, fetchTelegramFile } from './media.js';
import {
  runBroadcast, subsCount, broadcastStatus, publishedNotice, sendPreview, scheduleBroadcast, cancelScheduled,
  parseWhen, kindOf, kindCode, bcId,
} from './broadcast.js';
import {
  rowsOf, fmtDay, fmtTimeOnly, fmtWhen, plural, originOf, escHtml, sender, callOf, posterUrl,
  loadEvent, nearestEvent, earlyEvent, eventWaves, getSession, setSession, clearSession,
} from './bot-kit.js';
import { fmtRub } from '../../assets/waves.js';
import { EXPIRE_SQL, revenueSql } from './queries.js';

export const OWNER_COMMANDS = [
  { command: 'stats', description: 'Сводка по ближайшей ночи' },
  { command: 'pending', description: 'Брони, которые ждут подтверждения' },
  { command: 'new', description: 'Новое мероприятие из поста' },
  { command: 'pay', description: 'Подтвердить оплату по коду: /pay PX-7F3K' },
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

  // бот задал вопрос и ждёт ответ: параметры раннего доступа или время рассылки
  if (raw && !msg.photo && !msg.document && raw.length < 60) {
    const st = await getSession(deps.sql, chatId);
    if (st && st.state === 'owner_early') return earlyFromText(deps, chatId, st.data.eventId, raw);
    if (st && st.state === 'owner_bctime') return scheduleFromText(deps, chatId, st.data, raw);
  }

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
  // пост-альбом приходит пачкой: подпись — у одной картинки, остальные без
  // неё. Их не цепляем афишей к черновику и не отвечаем на каждую подсказкой
  if (fileId && !text && msg.media_group_id) return { done: 'album_part' };
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
      `SELECT id, title, starts_at FROM events WHERE status IN ('onsale','early','draft') ORDER BY starts_at LIMIT 20`
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
      [{ text: '🔑 Ранний доступ', callback_data: `early:${id}` }, { text: '✏️ Править в панели', url: panelUrl(deps, `events/${id}`) }],
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
       ${revenueSql('$1')} AS revenue,
       (SELECT count(*) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending')::int AS pend,
       (SELECT coalesce(sum(amount_rub), 0) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending')::int AS pend_rub,
       (SELECT count(*) FROM orders o WHERE o.event_id = $1 AND o.status = 'pending' AND o.claimed_at IS NOT NULL)::int AS claimed,
       (SELECT count(*) FROM waitlist l WHERE l.event_id = $1 AND l.notified_at IS NULL)::int AS waiting`,
    [ev.id]
  ))[0] || {};
  const all = await eventWaves(sql, ev.id);
  const waves = all.filter((w) => w.public);
  const earlyW = all.filter((w) => w.early);
  const quota = waves.reduce((x, w) => x + w.quota, 0);
  const subs = await subsCount(sql);
  const text =
    `📊 <b>${escHtml(ev.title)}</b>\n${escHtml(fmtDay(ev.starts_at))} · ${ev.status === 'onsale' ? 'в продаже' : ev.status === 'early' ? 'ранний доступ для подписчиков' : ev.status === 'past' ? 'прошла' : escHtml(ev.status)}\n\n` +
    `🎟 Продано: <b>${s.sold || 0}</b>${quota ? ` из ${quota}` : ''}\n` +
    `💰 Выручка: <b>${fmtRub(s.revenue || 0)} ₽</b>\n` +
    `🕒 Ждут оплаты: ${s.pend || 0} ${plural(Number(s.pend || 0), 'бронь', 'брони', 'броней')}${s.pend ? ` · ${fmtRub(s.pend_rub)} ₽` : ''}${s.claimed ? ` · ${s.claimed} нажали «Я перевёл»` : ''}\n` +
    `🚪 Вошло: ${s.inside || 0}\n` +
    (s.waiting ? `⏳ В листе ожидания: ${s.waiting}\n` : '') +
    (earlyW.length ? `\n${earlyW.map((w) => `🔑 ${escHtml(w.name)}: ${w.sold}/${w.quota} · ${fmtRub(w.priceRub)} ₽`).join('\n')}` : '') +
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
  // просроченные — сначала сжечь: иначе в списке висят брони, которые уже не держат места
  try { await deps.sql.query(EXPIRE_SQL); } catch { /* не критично */ }
  const rows = rowsOf(await deps.sql.query(
    `SELECT o.id, o.status, o.pay_code, o.amount_rub, o.qty, o.buyer_name, o.buyer_phone, o.claimed_at, o.expires_at, e.title
     FROM orders o JOIN events e ON e.id = o.event_id
     WHERE o.status = 'pending'
        -- сгоревшая, но гость нажал «Я перевёл»: деньги могли прийти позже срока
        OR (o.status = 'expired' AND o.claimed_at IS NOT NULL AND o.claimed_at > now() - interval '48 hours')
     ORDER BY o.claimed_at DESC NULLS LAST, o.created_at DESC LIMIT 8`
  ));
  const send = sender(deps, chatId);
  if (!rows.length) {
    await send('Никто не ждёт подтверждения ✨');
    return { done: 'owner_pending_none' };
  }
  for (const o of rows) {
    const when = o.status === 'expired'
      ? `⚠️ бронь сгорела, но гость нажал «Я перевёл» в ${fmtTimeOnly(o.claimed_at)} — «Пришло» вернёт места, если они есть`
      : o.claimed_at
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
    // из черновика или из раннего доступа: ранние волны после этого не продаются
    const rows = rowsOf(await sql.query(`UPDATE events SET status = 'onsale' WHERE id = $1 AND status IN ('draft', 'early') RETURNING id`, [arg]));
    if (!rows.length) {
      await answer('Уже обработано');
      return { done: 'noop', slug: arg };
    }
    await answer('Опубликовано — уже на сайте');
    await stamp('✅ Опубликовано — уже на сайте');
    const notice = publishedNotice(originOf(deps), arg, check.event.title, await subsCount(sql));
    await sender(deps, chatId)(notice.text, notice.markup);
    return { done: 'published', slug: arg };
  }

  if (action === 'del') {
    const r = await deleteEvent(sql, arg, { onlyDraft: true });
    await answer(r.ok ? 'Удалено' : r.message);
    if (r.ok) {
      await stamp('🗑 Черновик удалён');
      await deps.tg('editMessageReplyMarkup', { chat_id: cb.message?.chat?.id, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } });
    }
    return { done: r.ok ? 'deleted' : 'delete_blocked', slug: arg };
  }

  // «📣 Разослать» — сначала превью владельцу: ровно то, что получат
  // подписчики, и пульт «сейчас / по времени». Старая кнопка «Продолжить
  // рассылку» (bc:) на начатой рассылке — продолжает её
  if (action === 'bc') {
    const st = await broadcastStatus(sql, arg, 'ann');
    if (st.started && !st.done) return sendNow(deps, chatId, 'ann', arg, answer);
    await answer();
    const p = await sendPreview(deps, chatId, arg, 'ann');
    if (!p.ok) await sender(deps, chatId)(p.message);
    return { done: p.ok ? 'bc_preview' : 'bc_preview_failed', slug: arg };
  }
  if (['bcgo', 'bct', 'bcw', 'bcx'].includes(action)) {
    const m = /^([ae])([0-9a-z]{0,8})-([a-z0-9][a-z0-9-]{0,39})$/.exec(arg);
    if (!m) {
      await answer('Кнопка устарела — /stats');
      return { done: 'bc_bad_arg' };
    }
    const kind = kindOf(m[1]);
    const id = m[3];
    if (action === 'bcgo') {
      await clearButtons(cb, deps);
      return sendNow(deps, chatId, kind, id, answer);
    }
    if (action === 'bct') {
      const at = parseInt(m[2] || '0', 36) * 60_000;
      if (!at || at < deps.nowMs + 60_000) {
        await answer('Это время уже прошло — выбери другое');
        return { done: 'bc_time_past' };
      }
      return confirmSchedule(deps, chatId, kind, id, at, answer, cb);
    }
    if (action === 'bcw') {
      await setSession(sql, chatId, 'owner_bctime', { kind, eventId: id });
      await answer();
      await sender(deps, chatId)('Во сколько отправить? Напиши время по Оренбургу: «20:30», «завтра 18:00» или «18.10 19:00».');
      return { done: 'bc_time_ask' };
    }
    const off = await cancelScheduled(sql, id, kind);
    await answer(off ? 'Отправка по времени отменена' : 'Нечего отменять — рассылка уже идёт или не запланирована');
    if (off) {
      await clearButtons(cb, deps);
      await sender(deps, chatId)(`Не отправляю по времени. Разослать — снова «📣 Разослать» или кнопки ниже.`, {
        inline_keyboard: [[{ text: '👁 Превью и отправка', callback_data: `${kind === 'early' ? 'eb' : 'bc'}:${id}` }]],
      });
    }
    return { done: off ? 'bc_unscheduled' : 'bc_unschedule_noop' };
  }
  if (action === 'eb') {
    await answer();
    const p = await sendPreview(deps, chatId, arg, 'early');
    if (!p.ok) await sender(deps, chatId)(p.message);
    return { done: p.ok ? 'early_preview' : 'early_preview_failed', slug: arg };
  }

  // ---- ранний доступ: сколько и почём → закрытая волна, ночь в 'early' ----
  if (action === 'early') {
    await answer();
    return askEarly(deps, chatId, arg);
  }
  if (action === 'eset') {
    const m = /^(\d{1,4})x(\d{1,5})-([a-z0-9][a-z0-9-]{0,39})$/.exec(arg);
    if (!m) {
      await answer('Кнопка устарела');
      return { done: 'early_bad_arg' };
    }
    await answer();
    await clearButtons(cb, deps);
    return applyEarly(deps, chatId, m[3], Number(m[1]), Number(m[2]));
  }

  if (action === 'own') {
    await answer();
    if (arg === 'pending') return ownerPending(deps, chatId);
    return ownerStats(deps, chatId);
  }
  return null;
}

// ---------- рассылка: сейчас или по времени ----------

async function clearButtons(cb, deps) {
  if (!cb?.message?.chat?.id || !cb.message.message_id) return;
  try {
    await deps.tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  } catch { /* не критично */ }
}

// Одна порция прямо сейчас; не успели всех — продолжат фоновые задачи
// (scheduled_at = сейчас) или кнопка «Продолжить»
async function sendNow(deps, chatId, kind, id, answer) {
  await answer('Рассылаю…');
  const r = await runBroadcast(deps, id, { kind, sleep: deps.sleep });
  if (r.ok && !r.done && !r.busy) {
    await deps.sql.query(`UPDATE broadcasts SET scheduled_at = COALESCE(scheduled_at, now()) WHERE id = $1`, [bcId(kind, id)]);
  }
  if (r.ok && r.done) await deps.sql.query(`UPDATE broadcasts SET reported = true WHERE id = $1`, [bcId(kind, id)]);
  const what = kind === 'early' ? 'Ранний доступ' : 'Анонс';
  const status = !r.ok
    ? `Не разослано: ${r.message}`
    : r.message
      ? r.message
      : r.done
        ? `📣 ${what} разослан: доставлено ${r.sent}${r.failed ? `, не дошло ${r.failed} (бот заблокирован или аккаунт удалён — больше не пишем)` : ''}.`
        : `📣 Разослано ${r.sent} из ${r.total}… Остальным уйдёт в ближайшие минуты.`;
  await sender(deps, chatId)(status, r.ok && !r.done && !r.busy
    ? { inline_keyboard: [[{ text: '▶️ Продолжить сейчас', callback_data: `bcgo:${kindCode(kind)}-${id}` }]] }
    : undefined);
  return { ...r, finished: Boolean(r.done), done: r.ok ? (r.done ? 'broadcast_done' : 'broadcast_part') : 'broadcast_failed' };
}

async function confirmSchedule(deps, chatId, kind, id, atMs, answer, cb) {
  const when = await scheduleBroadcast(deps.sql, id, kind, atMs);
  if (!when) {
    await answer?.('Рассылка уже идёт или разослана');
    return { done: 'bc_schedule_noop' };
  }
  await answer?.(`Отправлю ${fmtWhen(when)}`);
  await clearButtons(cb, deps);
  const subs = await subsCount(deps.sql);
  const what = kind === 'early' ? 'Ранний доступ' : 'Анонс';
  await sender(deps, chatId)(
    `🕒 ${what} уйдёт ${fmtWhen(when)} — ${subs} ${plural(subs, 'подписчику', 'подписчикам', 'подписчикам')}. Как разошлю — напишу сюда.`,
    { inline_keyboard: [[
      { text: '✅ Отправить сейчас', callback_data: `bcgo:${kindCode(kind)}-${id}` },
      { text: '✖ Не отправлять', callback_data: `bcx:${kindCode(kind)}-${id}` },
    ]] }
  );
  return { done: 'bc_scheduled', at: when };
}

async function scheduleFromText(deps, chatId, data, text) {
  const at = parseWhen(text, deps.nowMs);
  if (!at) {
    await sender(deps, chatId)('Не понял время. Напиши, например: «20:30», «завтра 18:00» или «18.10 19:00» — не дальше двух недель. Передумал — /cancel');
    return { done: 'bc_time_bad' };
  }
  await clearSession(deps.sql, chatId);
  return confirmSchedule(deps, chatId, data.kind === 'early' ? 'early' : 'ann', data.eventId, at, null, null);
}

// ---------- ранний доступ ----------
// Ночь ещё не на сайте: подписчики бота бронируют раньше всех по своей цене
// (закрытая волна early). Открытая продажа — «Опубликовать», как обычно.
export const EARLY_PRESETS = [[50, 690], [50, 590], [30, 590]];

async function askEarly(deps, chatId, eventId) {
  const sql = deps.sql;
  const ev = await loadEvent(sql, eventId);
  const send = sender(deps, chatId);
  if (!ev) {
    await send('Мероприятие не найдено');
    return { done: 'early_missing' };
  }
  if (!['draft', 'early'].includes(ev.status)) {
    await send('Ранний доступ открывают до публикации, а эта ночь уже в продаже.');
    return { done: 'early_too_late', slug: eventId };
  }
  const subs = await subsCount(sql);
  const pubWaves = (await eventWaves(sql, eventId)).filter((w) => w.public);
  const from = pubWaves.length ? Math.min(...pubWaves.map((w) => w.priceRub)) : null;
  await setSession(sql, chatId, 'owner_early', { eventId });
  await send(
    `🔑 <b>Ранний доступ</b> — «${escHtml(ev.title)}»\n\n` +
      `Ночи ещё нет на сайте: подписчики бота (${subs}) бронируют раньше всех по своей цене. ` +
      'Открытую продажу запустишь как обычно — «✅ Опубликовать».\n\n' +
      'Сколько проходок и почём? Жми вариант или напиши, например: «40 по 650».' +
      (from !== null ? `\nОткрытая продажа — от ${fmtRub(from)} ₽: ранняя цена должна быть ниже.` : ''),
    { inline_keyboard: [EARLY_PRESETS.map(([n, p]) => ({ text: `${n} × ${fmtRub(p)} ₽`, callback_data: `eset:${n}x${p}-${eventId}` }))] },
    true
  );
  return { done: 'early_ask', slug: eventId };
}

async function earlyFromText(deps, chatId, eventId, text) {
  const m = /(\d{1,4})\D+?(\d{2,5})/.exec(String(text).replace(/\s+/g, ' '));
  if (!m) {
    await sender(deps, chatId)('Не понял. Напиши два числа: сколько проходок и цену — например, «50 по 690». Передумал — /cancel');
    return { done: 'early_bad_input' };
  }
  return applyEarly(deps, chatId, eventId, Number(m[1]), Number(m[2]));
}

export async function applyEarly(deps, chatId, eventId, qty, price) {
  const sql = deps.sql;
  const send = sender(deps, chatId);
  const r = await openEarly(sql, eventId, qty, price, deps.nowMs);
  if (!r.ok) {
    if (!/от 1 до 1000/.test(r.message)) await clearSession(sql, chatId);
    await send(/от 1 до 1000/.test(r.message) ? `${r.message}. Напиши ещё раз, например «50 по 690».` : r.message);
    return { done: 'early_failed', slug: eventId, message: r.message };
  }
  await clearSession(sql, chatId);
  await send(
    `🔑 Ранний доступ: ${qty} × ${fmtRub(price)} ₽. Ночи на сайте нет — бронируют только подписчики, здесь, в боте. ` +
      'Открыть продажу для всех — «✅ Опубликовать» на карточке ночи или в панели.\n\nНиже — что получат подписчики:'
  );
  await sendPreview(deps, chatId, eventId, 'early');
  return { done: 'early_open', slug: eventId, qty, price };
}

export { broadcastStatus, earlyEvent };
