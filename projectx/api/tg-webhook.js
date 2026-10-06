// Вебхук Telegram — один бот на три роли.
//  1) Гость покупает прямо в боте: /buy (или кнопка в приветствии) → сколько
//     проходок → телефон (кнопкой «отправить номер») → имена → сводка с
//     подтверждением 18+ → бронь тем же ядром, что и сайт (_lib/order-core.js)
//     → реквизиты перевода и кнопка «Я перевёл» → после подтверждения
//     владельцем проходки приходят в этот же чат.
//  2) Гость с сайта: открыл бота по ссылке с экрана брони (/start ord_…) →
//     чат привязан к заказу, дальше как в п.1. /tickets — проходки чата.
//  3) Владелец (TELEGRAM_CHAT_ID): уведомления о бронях с кнопками
//     «Подтвердить / Не пришло»; пост в канале → анализ → черновик события
//     → публикация одной кнопкой (конвейер афиши, спящий без канала).
// Настройка — кнопка «Настроить бота» в панели (POST action=setup с ключом
// администратора): вебхук с секретом, команды, описание. См. setupBot.
//
// handleUpdate экспортирован отдельно и принимает зависимости —
// тесты гоняют его на PGlite с фейковым Telegram и без сети.
import { timingSafeEqual } from 'node:crypto';
import { db, hasDb, ensureSchema } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { isAdmin } from './_lib/auth.js';
import { notifyOwner, tgApi, tgCall, tgBotUsername } from './_lib/tg.js';
import { extractPost, extractorAvailable } from './_lib/extract.js';
import { normalizeAnnouncement, previewText } from './_lib/post-normalize.js';
import { isOrderId, transferText, transferLines, ticketLinks, siteOrigin, paidMessage, subOffer } from './_lib/booking.js';
import { placeOrder, nextWaveOf, nextWaveFor, seatsLeft, ownerNotice, ownerNoticeMarkup, liveUntilMs } from './_lib/order-core.js';
import { CONFIRM_SQL, CANCEL_SQL, EXPIRE_SQL } from './_lib/queries.js';
import { normalizePhone, fmtTime } from '../assets/ticket-format.js';
import { ladderText, fmtRub } from '../assets/waves.js';
import { SITE } from '../assets/data/config.js';
import {
  rowsOf, fmtWhen, fmtTimeOnly, plural, originOf, fmtDay, escHtml, sender, callOf, posterUrl,
  loadEvent, nearestEvent, eventWaves, isOwnerChat,
} from './_lib/bot-kit.js';
import { ownerMessage, ownerCallback, draftFromPost, OWNER_COMMANDS } from './_lib/bot-owner.js';
import { subscribe, unsubscribe, SUB_BUTTON, runBroadcast, broadcastStatus, subsCount } from './_lib/broadcast.js';
import { parsePost } from '../assets/post-parse.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;

  // Панель → «Настроить бота». Сюда ходит владелец с ключом администратора,
  // а не Telegram, поэтому проверка идёт до секрета вебхука.
  if (req.body?.action === 'setup') {
    if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен ключ администратора');
    const guestDeps = {
      sql: hasDb() ? db() : null,
      tg: tgApi,
      call: tgCall,
      nowMs: Date.now(),
      origin: siteOrigin(req),
      assetOrigin: req.headers?.host ? `https://${req.headers.host}` : null,
    };
    if (guestDeps.sql) await ensureSchema(guestDeps.sql);
    const r = await setupBot({
      tg: tgApi,
      call: tgCall,
      origin: siteOrigin(req),
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      secret: process.env.TG_WEBHOOK_SECRET || '',
      username: tgBotUsername(),
      ownerChat: process.env.TELEGRAM_CHAT_ID || '',
      // приветствие владельцу тем же кодом, каким бот отвечает гостям:
      // если гость не получает ответ, ошибка Telegram будет видна здесь
      welcome: guestDeps.sql ? (chatId) => sendWelcome(chatId, guestDeps, { intro: true }) : null,
    });
    return r.ok ? ok(res, r) : fail(res, 400, r.error, r.message, r);
  }

  // Панель → «Разослать анонс»: одна порция рассылки за вызов, панель зовёт
  // повторно, пока не done. Статус — без отправки.
  if (req.body?.action === 'broadcast' || req.body?.action === 'broadcast_status') {
    if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен ключ администратора');
    if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');
    const sql = db();
    await ensureSchema(sql);
    const eventId = String(req.body.event_id || '');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(eventId)) return fail(res, 400, 'validation', 'Некорректный id мероприятия');
    if (req.body.action === 'broadcast_status') {
      return ok(res, { ...(await broadcastStatus(sql, eventId)), subs: await subsCount(sql), bot: Boolean(process.env.TELEGRAM_BOT_TOKEN) });
    }
    if (!process.env.TELEGRAM_BOT_TOKEN) return fail(res, 503, 'not_configured', 'Бот не подключён: нет TELEGRAM_BOT_TOKEN');
    const r = await runBroadcast({
      sql, tg: tgApi, call: tgCall, nowMs: Date.now(), origin: siteOrigin(req),
      assetOrigin: req.headers?.host ? `https://${req.headers.host}` : null,
    }, eventId);
    return r.ok ? ok(res, r) : fail(res, 409, 'broadcast_failed', r.message);
  }

  const secret = process.env.TG_WEBHOOK_SECRET || '';
  if (!secret) return fail(res, 503, 'not_configured', 'TG_WEBHOOK_SECRET не задан');
  const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail(res, 403, 'forbidden', 'Неверный секрет вебхука');
  }

  // Telegram ретраит не-200: отвечаем 200 всегда, кроме ошибок конфигурации
  const update = req.body || {};
  const kind = update.callback_query ? 'callback' : update.message ? 'message' : update.channel_post ? 'post' : 'other';
  const chat = update.message?.chat?.id ?? update.callback_query?.from?.id ?? null;
  // в лог — только команды и данные кнопок; свободный текст (имена, телефоны) не пишем
  const rawText = String(update.message?.text || '');
  const head = update.callback_query
    ? String(update.callback_query.data || '').slice(0, 24)
    : rawText.startsWith('/') ? rawText.slice(0, 24) : update.message?.contact ? '<contact>' : rawText ? '<text>' : '';
  const t0 = Date.now();
  try {
    const sql = hasDb() ? db() : null;
    if (sql) await ensureSchema(sql); // таблицы бота могли появиться после «Инициализировать БД»
    const r = await handleUpdate(update, {
      sql,
      extract: extractPost,
      extractAvailable: extractorAvailable(),
      notify: notifyOwner,
      tg: tgApi,
      call: tgCall,
      autoPublish: process.env.AUTO_PUBLISH === '1',
      nowMs: Date.now(),
      origin: siteOrigin(req),
      // хост, по которому нас реально достал Telegram: с него он точно
      // сможет скачать афишу для приветствия (без редиректов)
      assetOrigin: req.headers?.host ? `https://${req.headers.host}` : null,
    });
    // одна строка на апдейт: что пришло, кому, чем кончилось и сколько заняло
    console.log(`tg-webhook: ${kind} chat=${chat} "${head}" -> ${r?.done} (${Date.now() - t0} ms)`);
  } catch (e) {
    console.error(`tg-webhook failed: ${kind} chat=${chat} "${head}" (${Date.now() - t0} ms):`, e);
    // гость не должен получать тишину в ответ: коротко скажем, что сломалось
    if (chat && kind !== 'post') {
      await tgApi('sendMessage', { chat_id: chat, text: 'Что-то сломалось — попробуй ещё раз через минуту. Если повторится, напиши нам в директ.' }, 2000);
    }
  }
  ok(res);
}

// ---------- настройка бота одной кнопкой ----------
export const BOT_COMMANDS = [
  { command: 'buy', description: 'Забронировать проходки' },
  { command: 'tickets', description: 'Мои проходки' },
  { command: 'notify', description: 'Узнавать о новых ночах первым' },
  { command: 'cancel', description: 'Отменить оформление' },
];

// Telegram не ходит по редиректам: если proxject.ru перебрасывает на www,
// вебхук на голом домене молча не работает («Wrong response: 308»). Поэтому
// адрес проверяем сами и берём тот, что отвечает напрямую: наш обработчик
// на GET отдаёт 405, это и есть признак «дошли до функции».
async function probeUrl(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return { status: r.status, location: r.headers.get('location') };
  } catch {
    return null;
  }
}
export async function resolveWebhookUrl(origin, probe = probeUrl) {
  let url = `${String(origin).replace(/\/+$/, '')}/api/tg-webhook`;
  const hops = [];
  for (let i = 0; i < 4; i++) {
    const p = await probe(url);
    if (!p) return { url, verified: false, status: null, hops };
    if ([301, 302, 307, 308].includes(p.status) && p.location) {
      hops.push(url);
      url = new URL(p.location, url).toString();
      continue;
    }
    return { url, verified: p.status === 405 || p.status === 200, status: p.status, hops };
  }
  return { url, verified: false, status: null, hops };
}

// Регистрирует вебхук (с секретом и нужными типами апдейтов), меню команд
// и описание бота. Идемпотентно: жать можно сколько угодно. Возвращает
// отчёт по шагам — панель показывает его владельцу.
export async function setupBot({ tg, call, origin, token, secret, username, probe, ownerChat, welcome }) {
  if (!token) return { ok: false, error: 'no_token', message: 'TELEGRAM_BOT_TOKEN не задан — добавь в Vercel и сделай Redeploy' };
  if (!secret) return { ok: false, error: 'no_secret', message: 'TG_WEBHOOK_SECRET не задан — придумай длинную случайную строку, добавь в Vercel и сделай Redeploy' };
  // call — вызов с текстом ошибки Telegram; без него — обёртка над tg
  const api = call || (async (m, p) => {
    const r = await tg(m, p);
    return r === null ? { ok: false, error: 'нет ответа' } : { ok: true, result: r };
  });
  const me = await tg('getMe', {});
  if (!me?.username) return { ok: false, error: 'bad_token', message: 'Telegram не принял токен — проверь TELEGRAM_BOT_TOKEN' };

  const steps = [];
  const step = async (name, method, payload) => {
    const r = await api(method, payload);
    steps.push({ name, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    return r.ok ? r.result : null;
  };
  const target = await resolveWebhookUrl(origin, probe);
  // drop_pending_updates: пока вебхук не работал, Telegram копил команды —
  // после починки не надо отвечать на вчерашние /buy и /cancel скопом. Но
  // если адрес не менялся (кнопку нажали во время продаж), очередь — это
  // живые «Я перевёл» гостей, и её не трогаем.
  const before = await tg('getWebhookInfo', {});
  const sameUrl = Boolean(before?.url) && before.url === target.url;
  // посты канала слушаем только если свой канал задан (TELEGRAM_CHANNEL_ID)
  const allowed = ['message', 'callback_query', ...(process.env.TELEGRAM_CHANNEL_ID ? ['channel_post'] : [])];
  await step('вебхук', 'setWebhook', {
    url: target.url,
    secret_token: secret,
    allowed_updates: allowed,
    drop_pending_updates: !sameUrl,
  });
  await step('команды', 'setMyCommands', { commands: BOT_COMMANDS });
  // владельцу — свои команды: сводка, брони, мероприятие из поста
  if (ownerChat) {
    await step('команды владельца', 'setMyCommands', { commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: Number(ownerChat) } });
  }
  await step('кнопка меню', 'setChatMenuButton', { menu_button: { type: 'commands' } });
  await step('описание', 'setMyDescription', {
    description: `Проходки на ночи ${SITE.brandName}: бронь за минуту прямо здесь, оплата переводом по СБП, именной QR приходит в чат.`,
  });
  await step('короткое описание', 'setMyShortDescription', {
    short_description: `Проходки на ${SITE.brandName} — бронь за минуту`,
  });
  const info = await tg('getWebhookInfo', {});
  // Проверка доставки тем же путём, каким бот пишет гостям: владелец получает
  // сообщение, а панель — ответ Telegram (например «chat not found», если
  // TELEGRAM_CHAT_ID чужой или владелец ещё не написал боту /start)
  let delivery = null;
  if (ownerChat) {
    const d = await api('sendMessage', {
      chat_id: ownerChat,
      text: `✅ Бот @${me.username} настроен. Вебхук: ${target.url}\nЭто проверка доставки из панели — значит, писать тебе бот может.`,
      disable_web_page_preview: true,
    });
    delivery = d.ok ? { ok: true } : { ok: false, error: d.error };
  }
  let greeted = null;
  if (ownerChat && welcome) {
    try {
      greeted = await welcome(ownerChat);
    } catch (e) {
      greeted = { via: 'none', error: e.message };
    }
  }
  const allOk = steps.every((s) => s.ok);
  const warning = target.verified
    ? null
    : `адрес ${target.url} не ответил как ожидалось${target.status ? ` (код ${target.status})` : ''} — проверь, что домен ведёт на этот проект`;
  return {
    ok: allOk,
    error: allOk ? undefined : 'partial',
    message: allOk
      ? `Бот @${me.username} настроен${warning ? `, но ${warning}` : ''}`
      : `Telegram не принял: ${steps.filter((s) => !s.ok).map((s) => `${s.name}${s.error ? ` (${s.error})` : ''}`).join(', ')}`,
    delivery,
    welcome: greeted,
    bot: { username: me.username, name: me.first_name || '' },
    username_mismatch: username && username !== me.username ? { env: username, actual: me.username } : null,
    webhook: {
      url: (info && info.url) || target.url,
      redirected_from: target.hops[0] || null,
      verified: target.verified,
      pending: Number(info?.pending_update_count || 0),
      last_error: info?.last_error_message || null,
    },
    steps,
  };
}

export async function handleUpdate(update, deps) {
  // идемпотентность: каждый update_id обрабатываем один раз — Telegram
  // повторяет доставку, если функция не ответила вовремя (холодный старт),
  // и без этого гость получал бы два приветствия, а владелец — два «Я перевёл»
  if (deps.sql && Number.isInteger(update.update_id)) {
    const rows = await deps.sql.query(
      `INSERT INTO tg_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id`,
      [update.update_id]
    );
    if (!(rows.rows || rows).length) return { done: 'duplicate' };
  }
  // сгоревшие брони списываются и от активности в боте, не только от заказов и панели
  if (deps.sql && (update.message || update.callback_query)) {
    try { await deps.sql.query(EXPIRE_SQL); } catch { /* не критично */ }
    // брошенный мастер брони стирается через 12 часов — как обещает политика
    try { await deps.sql.query(`DELETE FROM tg_sessions WHERE updated_at < now() - interval '12 hours'`); } catch { /* не критично */ }
  }
  if (update.callback_query) return handleCallback(update.callback_query, deps);
  if (update.message) return handleMessage(update.message, deps);
  const post = update.channel_post;
  if (!post) return { done: 'ignored' };

  // посты принимаем только из своего канала: бота можно сделать админом в
  // любом канале, и без проверки чужие посты уходили бы владельцу как афиши
  const wantChannel = String(deps.channelId ?? process.env.TELEGRAM_CHANNEL_ID ?? '');
  if (!wantChannel || String(post.chat?.id ?? '') !== wantChannel) return { done: 'ignored_channel' };

  const text = String(post.text || post.caption || '').trim();
  const photoId = Array.isArray(post.photo) && post.photo.length
    ? post.photo[post.photo.length - 1].file_id
    : null;
  if (text.length < 8 && !photoId) return { done: 'empty' };

  // без LLM-ключа пост разбирают правила: есть дата — владельцу приходит
  // черновик с кнопкой «Опубликовать», нет — сам пост на ручную правку
  if (!deps.extractAvailable) {
    const owner = String(process.env.TELEGRAM_CHAT_ID || '');
    if (deps.sql && owner && parsePost(text, { nowMs: deps.nowMs }).draft.date) {
      return draftFromPost(deps, owner, text, photoId);
    }
    await deps.notify(
      `Новый пост в канале — дату ночи в нём не нашёл.\n` +
      `Если это афиша — создай ночь в панели вручную (текст поста можно вставить туда).\n\n${text.slice(0, 500)}`
    );
    return { done: 'forwarded' };
  }

  let known = [];
  if (deps.sql) {
    try {
      const rows = await deps.sql.query(
        `SELECT id, title, starts_at FROM events WHERE status IN ('onsale','draft') ORDER BY starts_at LIMIT 20`
      );
      known = (rows.rows || rows).map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at }));
    } catch { /* не критично */ }
  }

  const extracted = await deps.extract(text, known, new Date(deps.nowMs).toISOString().slice(0, 10));

  if (extracted.kind === 'unavailable' || extracted.kind === 'error') {
    await deps.notify(
      `Новый пост в канале — анализ не сработал, проверь вручную:\n\n${text.slice(0, 500)}`
    );
    return { done: 'forwarded' };
  }
  if (extracted.kind === 'other') return { done: 'other' };

  if (extracted.kind === 'cancellation') {
    const slug = extracted.event?.targetSlug || null;
    await deps.notify(
      `В канале пост про отмену/перенос${slug ? ` (похоже на «${slug}»)` : ''}:\n\n${text.slice(0, 400)}`,
      slug ? { inline_keyboard: [[{ text: 'Снять с продажи', callback_data: `cancel:${slug}` }]] } : undefined
    );
    return { done: 'cancellation' };
  }

  if (extracted.kind === 'update') {
    await deps.notify(
      `В канале пост об изменении условий${extracted.event?.targetSlug ? ` («${extracted.event.targetSlug}»)` : ''} — обнови афишу, если важно:\n\n${text.slice(0, 400)}`
    );
    return { done: 'update' };
  }

  // announcement
  const norm = normalizeAnnouncement(extracted, { nowMs: deps.nowMs });
  if (!norm.ok) {
    await deps.notify(
      `Похоже на анонс, но не удалось собрать событие (${norm.problems.join('; ')}).\nПост:\n\n${text.slice(0, 400)}`
    );
    return { done: 'announcement_invalid' };
  }
  if (!deps.sql) {
    await deps.notify(`Анонс распознан, но БД не настроена — сайт не обновлён:\n\n${previewText(norm, null)}`);
    return { done: 'no_db' };
  }

  const posterUrl = photoId ? `/api/poster?fid=${encodeURIComponent(photoId)}` : null;
  const status = deps.autoPublish ? 'onsale' : 'draft';
  let slug = norm.event.id;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await deps.sql.query(
        `INSERT INTO events (id, brand, title, city, venue, address, starts_at, ends_at, age_rating, status, poster_url, descr)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [slug, norm.event.brand, norm.event.title, norm.event.city, norm.event.venue, norm.event.address,
         norm.event.startsAt, norm.event.endsAt, norm.event.ageRating, status, posterUrl, norm.event.descr]
      );
      break;
    } catch (e) {
      if (/duplicate key/i.test(String(e.message)) && attempt < 2) {
        slug = `${norm.event.id}-${attempt + 2}`;
        continue;
      }
      throw e;
    }
  }
  for (const w of norm.waves) {
    await deps.sql.query(
      `INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id, wave_no) DO NOTHING`,
      [slug, w.waveNo, w.name, w.priceRub, w.quota]
    );
  }

  if (deps.autoPublish) {
    await deps.notify(
      `${previewText(norm, null)}\n\n✅ Опубликовано автоматически (AUTO_PUBLISH=1).`,
      { inline_keyboard: [[{ text: 'Скрыть с сайта', callback_data: `skip:${slug}` }]] }
    );
  } else {
    await deps.notify(previewText(norm, null), {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `pub:${slug}` },
        { text: '✖ Пропустить', callback_data: `skip:${slug}` },
      ]],
    });
  }
  return { done: 'draft_created', slug, status };
}

const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// ---------- гость: личные сообщения боту ----------
async function handleMessage(msg, deps) {
  const chatId = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!chatId || (msg.chat.type && msg.chat.type !== 'private')) return { done: 'ignored' };
  const send = sender(deps, chatId);
  if (!deps.sql) {
    await send(`Бот на паузе — бронь и проходки на сайте: ${originOf(deps)}`);
    return { done: 'no_db' };
  }

  // владелец отвечает гостю: reply на пересланное сообщение с меткой #g<chat>
  const ownerChat = String(process.env.TELEGRAM_CHAT_ID || '');
  if (ownerChat && String(chatId) === ownerChat && msg.reply_to_message && text && !text.startsWith('/')) {
    const m = /#g(\d{3,20})\b/.exec(String(msg.reply_to_message.text || msg.reply_to_message.caption || ''));
    if (m) {
      const r = await callOf(deps)('sendMessage', { chat_id: Number(m[1]), text: `💬 Организатор: ${text}` });
      await send(r.ok ? 'Отправлено гостю.' : `Не доставлено: ${r.error}`);
      return { done: r.ok ? 'owner_reply' : 'owner_reply_failed' };
    }
  }

  // владелец: сводка, брони, мероприятие из присланного поста
  if (isOwnerChat(chatId)) {
    const r = await ownerMessage(msg, deps);
    if (r) return r;
  }

  // подписка на анонсы: только по явному согласию, отписка — /stop
  if (/^\/(?:notify|start\s+notify)(?:@\w+)?$/i.test(text) || /^\/start(?:@\w+)?\s+notify$/i.test(text)) {
    await clearSession(deps.sql, chatId);
    const r = await subscribe(deps.sql, chatId, /start/i.test(text) ? 'site' : 'bot');
    await send(
      r.created
        ? '🔔 Готово — напишем сюда, как только откроем продажи следующей ночи. Ранняя волна всегда дешевле.\n\nНе присылать анонсы — /stop'
        : '🔔 Ты уже в списке — напишем, как откроем продажи. Не присылать анонсы — /stop'
    );
    return { done: 'subscribed', created: r.created };
  }
  if (/^\/stop(?:@\w+)?$/i.test(text)) {
    await clearSession(deps.sql, chatId);
    const was = await unsubscribe(deps.sql, chatId);
    await send(was ? 'Ок, анонсы больше не пришлём. Проходки и брони работают как раньше. Передумаешь — /notify' : 'Анонсы и так не приходят. Захочешь узнавать о ночах первым — /notify');
    return { done: 'unsubscribed', was };
  }

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
  if (start) {
    const payload = start[1] || '';
    await clearSession(deps.sql, chatId);
    if (isOrderId(payload)) {
      const o = await loadOrder(deps.sql, payload);
      if (!o) {
        await send('Бронь по этой ссылке не нашли. Вернись на страницу брони и нажми «Получить проходку в Telegram» ещё раз.');
        return { done: 'start_unknown' };
      }
      await deps.sql.query(
        `INSERT INTO tg_links (chat_id, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [chatId, o.id]
      );
      // проходки уходят в тот чат, который открыл ссылку первым: чужой
      // переход по той же ссылке доставку не перехватывает
      await deps.sql.query(`UPDATE orders SET tg_chat_id = COALESCE(tg_chat_id, $1) WHERE id = $2`, [chatId, o.id]);
      await sendOrderStatus(o, chatId, deps);
      return { done: 'linked', order: o.id };
    }
    if (/^buy/i.test(payload)) return startWizard(chatId, deps, null);
    const welcome = await sendWelcome(chatId, deps, { intro: true });
    return { done: 'start', welcome };
  }

  if (/^\/buy(?:@\w+)?$/i.test(text)) return startWizard(chatId, deps, null);

  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    const had = await getSession(deps.sql, chatId);
    await clearSession(deps.sql, chatId);
    await send(
      had ? 'Ок, ничего не бронируем. Передумаешь — /buy.' : 'Сейчас ничего не оформляем. Забронировать — /buy.',
      { remove_keyboard: true }
    );
    return { done: 'wizard_cancelled' };
  }

  // любая команда сбрасывает мастер: после /tickets следующий текст — не имена
  if (text.startsWith('/')) await clearSession(deps.sql, chatId);

  // Ответы мастера: всё, что не команда, пока идёт оформление
  const session = text.startsWith('/') ? null : await getSession(deps.sql, chatId);
  if (session) return wizardInput(chatId, deps, session, msg);

  if (/^\/tickets|проходк|билет/i.test(text)) return sendTickets(chatId, deps);

  // свободный текст, скрин перевода или вопрос от гостя с бронью — организатору,
  // а не афиша в ответ; владелец отвечает reply'ем на пересланное сообщение
  if (!text.startsWith('/') && ownerChat && (text || msg.photo || msg.document)) {
    const linked = rowsOf(await deps.sql.query(
      `SELECT o.pay_code, o.buyer_name, o.buyer_phone FROM tg_links l JOIN orders o ON o.id = l.order_id
       WHERE l.chat_id = $1 ORDER BY o.created_at DESC LIMIT 1`, [chatId]
    ))[0];
    if (linked) {
      await deps.notify(
        `✉️ Пишет гость · ${linked.pay_code || 'без кода'} · ${linked.buyer_name} · ${linked.buyer_phone} · #g${chatId}\n` +
          'Ответить ему — reply на это сообщение.' + (msg.message_id ? '' : `\n\n${text.slice(0, 1000)}`)
      );
      if (msg.message_id) {
        const fw = await callOf(deps)('forwardMessage', { chat_id: ownerChat, from_chat_id: chatId, message_id: msg.message_id });
        if (!fw.ok && text) await deps.notify(text.slice(0, 1000));
      }
      await send('Передали организатору — ответ придёт сюда.');
      return { done: 'relayed' };
    }
  }

  const welcome = await sendWelcome(chatId, deps, { intro: false });
  return { done: 'unknown', welcome };
}

// Все проходки этого чата (последние 5 заказов), каждая — по своему статусу
async function sendTickets(chatId, deps) {
  const rows = rowsOf(await deps.sql.query(
    `SELECT o.id FROM tg_links l JOIN orders o ON o.id = l.order_id
     WHERE l.chat_id = $1 ORDER BY o.created_at DESC LIMIT 5`,
    [chatId]
  ));
  if (!rows.length) {
    await sender(deps, chatId)('Проходок пока нет. Бронь занимает минуту 👇', {
      inline_keyboard: [[{ text: '🎟 Забронировать проходки', callback_data: 'menu:buy' }]],
    });
    return { done: 'tickets_none' };
  }
  for (const r of rows) {
    const o = await loadOrder(deps.sql, r.id);
    if (o) await sendOrderStatus(o, chatId, deps);
  }
  return { done: 'tickets', n: rows.length };
}

async function loadOrder(sql, oid) {
  const rows = rowsOf(await sql.query(
    `SELECT o.id, o.status, o.pay_code, o.amount_rub, o.qty, o.expires_at, o.claimed_at, o.tg_chat_id,
            e.id AS event_id, e.title, e.starts_at, e.venue, e.address, e.secret
     FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
    [oid]
  ));
  return rows[0] || null;
}

// Что сейчас с бронью — одно сообщение под текущий статус
async function sendOrderStatus(o, chatId, deps) {
  const send = sender(deps, chatId);
  const origin = originOf(deps);
  const n = Number(o.qty);
  const what = `${n} ${plural(n, 'проходка', 'проходки', 'проходок')} на ${o.title} · ${fmtWhen(o.starts_at)}`;

  if (o.status === 'pending') {
    const waiting = o.claimed_at
      ? `\n\n«Я перевёл» уже нажато — проверяем перевод, подтверждение придёт сюда.`
      : `\n\nБронь держим до ${fmtWhen(o.expires_at)}. Перевёл — жми кнопку.`;
    await send(
      `🕒 Бронь ${o.pay_code}: ${what}\n\n${transferText(Number(o.amount_rub), o.pay_code)}${waiting}`,
      o.claimed_at ? undefined : { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${o.id}` }]] }
    );
    return;
  }
  if (o.status === 'paid') {
    const tickets = rowsOf(await deps.sql.query(
      `SELECT id, holder_name FROM tickets WHERE order_id = $1 AND status = 'active' ORDER BY id`, [o.id]
    ));
    const links = ticketLinks(tickets, origin).map((t) => `• ${t.holder_name}: ${t.url}`);
    // оплатившим адрес показываем всегда — и на SECRET PLACE тоже
    const where = [o.venue, o.address].filter(Boolean).join(', ');
    const addr = where ? `\n\n📍 ${fmtDay(o.starts_at)} · двери ${fmtTimeOnly(o.starts_at)} · ${where}` : '';
    await send(`✅ Оплачено: ${what}\n\n${links.join('\n') || 'Проходки уже использованы или отозваны.'}${addr}`);
    return;
  }
  if (o.status === 'expired') {
    await send(
      `Бронь ${o.pay_code} сгорела — время на перевод вышло, места вернулись в продажу. ` +
        'Уже перевёл? Нажми «Я перевёл» — проверим и восстановим бронь, если места остались. Взять заново — /buy',
      { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${o.id}` }, { text: '🎟 Забронировать', callback_data: 'menu:buy' }]] }
    );
    return;
  }
  await send(`Бронь ${o.pay_code || o.id} отменена. Если это ошибка — напиши сюда.`);
}

// ---------- покупка в боте: мастер брони ----------
// Состояние между сообщениями — строка в tg_sessions (одна на чат):
// qty → phone → names → confirm → (booking). Любая команда сбрасывает мастер,
// сессия старше 12 часов считается брошенной и стирается.
const SESSION_TTL_MS = 12 * 3600_000; // брошенный мастер живёт полсуток — чтобы имена, набранные после паузы, не встречала афиша

async function getSession(sql, chatId) {
  const s = rowsOf(await sql.query(`SELECT state, data, updated_at FROM tg_sessions WHERE chat_id = $1`, [chatId]))[0];
  if (!s || Date.now() - new Date(s.updated_at).getTime() > SESSION_TTL_MS) return null;
  return { state: s.state, data: typeof s.data === 'string' ? JSON.parse(s.data) : (s.data || {}) };
}
async function setSession(sql, chatId, state, data) {
  await sql.query(
    `INSERT INTO tg_sessions (chat_id, state, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (chat_id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()`,
    [chatId, state, JSON.stringify(data)]
  );
}
const clearSession = (sql, chatId) => sql.query(`DELETE FROM tg_sessions WHERE chat_id = $1`, [chatId]);

// Приветствие — карточка ночи: афиша, дата, место, цена и меню кнопок.
// Без афиши (или если Telegram её не принял) — тот же текст сообщением.
// Возвращает, чем кончилось: { via: 'photo'|'text'|'none', error?, photo_error? }
async function sendWelcome(chatId, deps, { intro }) {
  const call = callOf(deps);
  const origin = originOf(deps);
  const hello = intro ? `👋 Это бот ${SITE.brandName} — здесь берут проходки.\n\n` : '';
  const ev = await nearestEvent(deps.sql, deps.nowMs);
  if (!ev) {
    const r = await call('sendMessage', {
      chat_id: chatId,
      text: `${hello}Пока ничего не продаём — следующую ночь объявим на сайте и в соцсетях.`,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [SUB_BUTTON],
          [{ text: '🎫 Мои проходки', callback_data: 'menu:tickets' }, { text: '🌐 Сайт', url: `${origin}/?src=tgbot` }],
        ],
      },
    });
    return r.ok ? { via: 'text' } : { via: 'none', error: r.error };
  }
  const ladder = ladderText(await eventWaves(deps.sql, ev.id));
  const where = ev.secret
    ? 'локация — секрет, адрес придёт в проходке'
    : [ev.venue, ev.address].filter(Boolean).join(', ');
  const text =
    `${hello}<b>${escHtml(ev.title)}</b>\n${escHtml(fmtWhen(ev.starts_at))} · ${escHtml(where)}` +
    `${ladder ? `\n${escHtml(ladder)}.` : ''}\n\n` +
    `Строго 18+, FC/DC. Бронь за минуту, оплата переводом по СБП, QR приходит сюда в чат.`;
  const menu = {
    inline_keyboard: [
      [{ text: '🎟 Забронировать проходки', callback_data: `buy:${ev.id}` }],
      [
        { text: '🎫 Мои проходки', callback_data: 'menu:tickets' },
        { text: '📋 Правила и FAQ', url: `${origin}/faq` },
      ],
      [{ text: '🌐 О ночи на сайте', url: `${origin}/e/${ev.id}?src=tgbot` }],
    ],
  };
  let photoError = null;
  const poster = posterUrl(ev.poster_url, deps);
  if (poster) {
    const r = await call('sendPhoto', {
      chat_id: chatId, photo: poster, caption: text, parse_mode: 'HTML', reply_markup: menu,
    });
    if (r.ok) return { via: 'photo' };
    photoError = r.error;
  }
  const t = await call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: menu,
  });
  return t.ok ? { via: 'text', ...(photoError ? { photo_error: photoError } : {}) } : { via: 'none', error: t.error, ...(photoError ? { photo_error: photoError } : {}) };
}

// Шаг 1: сколько проходок. eventId=null — ближайшая ночь.
async function startWizard(chatId, deps, eventId, { force = false } = {}) {
  const send = sender(deps, chatId);
  let ev = eventId ? await loadEvent(deps.sql, eventId) : null;
  // кнопка со старой афиши (ночь прошла или снята) — предлагаем ближайшую живую
  if (!ev || ev.status !== 'onsale' || liveUntilMs(ev) <= deps.nowMs) ev = await nearestEvent(deps.sql, deps.nowMs);
  if (!ev) {
    await clearSession(deps.sql, chatId);
    await send('Сейчас продаж нет — следующую ночь объявим на сайте и в соцсетях.');
    return { done: 'wizard_closed' };
  }
  // уже есть неоплаченная бронь: напоминаем о ней, а не плодим вторую
  if (!force) {
    const pend = rowsOf(await deps.sql.query(
      `SELECT o.pay_code, o.qty, o.expires_at FROM tg_links l JOIN orders o ON o.id = l.order_id
       WHERE l.chat_id = $1 AND o.status = 'pending' ORDER BY o.created_at DESC LIMIT 1`, [chatId]
    ))[0];
    if (pend) {
      await clearSession(deps.sql, chatId);
      await send(
        `У тебя уже есть бронь ${pend.pay_code} на ${pend.qty} ${plural(Number(pend.qty), 'проходку', 'проходки', 'проходок')} — держим до ${fmtWhen(pend.expires_at)}. ` +
          'Оплати её или оформи ещё одну.',
        { inline_keyboard: [[{ text: '🎫 Показать бронь', callback_data: 'menu:tickets' }, { text: '➕ Ещё одну', callback_data: `more:${ev.id}` }]] }
      );
      return { done: 'wizard_pending_exists', order: pend.pay_code };
    }
  }
  const wave = await nextWaveOf(deps.sql, ev.id);
  if (!wave) {
    await clearSession(deps.sql, chatId);
    await send('Всё продано 😔 Если места освободятся — расскажем на сайте и в соцсетях.');
    return { done: 'wizard_sold_out' };
  }
  await setSession(deps.sql, chatId, 'qty', {
    eventId: ev.id, title: ev.title, startsAt: new Date(ev.starts_at).toISOString(),
    waveNo: wave.waveNo, priceRub: wave.priceRub,
  });
  const scarce = wave.left <= 10
    ? `, по этой цене ${plural(wave.left, 'осталась', 'остались', 'осталось')} ${wave.left}`
    : '';
  const nextWave = (await eventWaves(deps.sql, ev.id)).find((w) => w.public && w.waveNo > wave.waveNo && w.sold < w.quota);
  const further = nextWave && nextWave.priceRub !== wave.priceRub ? `, дальше ${fmtRub(nextWave.priceRub)} ₽` : '';
  await send(
    `<b>${escHtml(ev.title)}</b> · ${escHtml(fmtWhen(ev.starts_at))}\n` +
      `Сейчас проходка — <b>${fmtRub(wave.priceRub)} ₽</b>${scarce}${further}.\n\n` +
      `Сколько берёшь? Жми цифру или напиши число до 10.`,
    { inline_keyboard: [[1, 2, 3, 4].map((n) => ({ text: String(n), callback_data: `qty:${n}` }))] },
    true
  );
  return { done: 'wizard_qty', event: ev.id };
}

async function wizardInput(chatId, deps, s, msg) {
  const text = String(msg.text || '').trim();
  if (s.state === 'qty') return wizardQty(chatId, deps, s, parseInt(text.replace(/\D+/g, ' ').trim(), 10));
  if (s.state === 'phone') return wizardPhone(chatId, deps, s, msg.contact?.phone_number || text, Boolean(msg.contact));
  if (s.state === 'names') return wizardNames(chatId, deps, s, text);
  // confirm/booking: ждём кнопку — повторим сводку
  await sendSummary(chatId, deps, s.data);
  return { done: 'wizard_confirm_repeat' };
}

const namesPrompt = (qty) => (qty === 1
  ? 'Как тебя зовут? Имя и фамилию как в паспорте — проходка именная, на входе сверят.'
  : `Напиши ${qty} ${plural(qty, 'имя', 'имени', 'имён')} с фамилиями — каждого гостя с новой строки, первым себя. Проходки именные, на входе сверят с паспортом.`);

// Шаг 2: телефон — кнопкой «отправить номер» или текстом. Если телефон уже
// известен (гость меняет количество после «столько уже нет») — сразу имена.
async function wizardQty(chatId, deps, s, n) {
  const send = sender(deps, chatId);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    await send('Нужно число от 1 до 10 — сколько проходок берёшь?');
    return { done: 'wizard_qty_bad' };
  }
  if (s.data.cap && n > s.data.cap) {
    await send(`Одной бронью сейчас можно до ${s.data.cap}. Сколько берёшь?`);
    return { done: 'wizard_qty_bad' };
  }
  const { cap, ...rest } = s.data;
  let d = { ...rest, qty: n };
  // цена сразу под всю компанию: если в текущей волне столько нет, бронь
  // целиком идёт по следующей — гость видит это здесь, а не на подтверждении
  let note = '';
  const nw = await nextWaveFor(deps.sql, d.eventId, n);
  if (nw && nw.waveNo !== d.waveNo) {
    note = nw.priceRub > d.priceRub
      ? `\nПо ${fmtRub(d.priceRub)} ₽ столько уже нет, поэтому вся бронь — по ${fmtRub(nw.priceRub)} ₽.`
      : `\nЕсть место по ${fmtRub(nw.priceRub)} ₽ — бронь по этой цене.`;
    d = { ...d, waveNo: nw.waveNo, priceRub: nw.priceRub };
  } else if (!nw) {
    const left = await seatsLeft(deps.sql, d.eventId);
    if (left.maxOne > 0) {
      await setSession(deps.sql, chatId, 'qty', { ...rest, cap: left.maxOne });
      const more = left.total > left.maxOne ? ` (всего осталось ${left.total} — остальное можно взять второй бронью)` : '';
      await send(`Столько одной бронью уже нет — можно до ${left.maxOne}${more}. Сколько берёшь?`, {
        inline_keyboard: [Array.from({ length: Math.min(left.maxOne, 4) }, (_, i) => ({ text: String(i + 1), callback_data: `qty:${i + 1}` }))],
      });
      return { done: 'wizard_qty_cap', maxOne: left.maxOne };
    }
    await clearSession(deps.sql, chatId);
    await send(`Все проходки проданы 😔 Если что-то освободится — расскажем в ${SITE.instagramName}.`);
    return { done: 'wizard_sold_out' };
  }
  const sum = `${n} ${plural(n, 'проходка', 'проходки', 'проходок')} × ${fmtRub(d.priceRub)} ₽ = <b>${fmtRub(n * d.priceRub)} ₽</b>.${escHtml(note)}`;
  if (d.phone) {
    await setSession(deps.sql, chatId, 'names', d);
    await send(`${sum}\n\n${escHtml(namesPrompt(n))}`, { remove_keyboard: true }, true);
    return { done: 'wizard_names', qty: n };
  }
  await setSession(deps.sql, chatId, 'phone', d);
  await send(
    `${sum}\n\nТеперь телефон — по нему найдём твою бронь и перевод. Жми «Отправить мой номер» внизу или напиши: +7 9…`,
    CONTACT_KEYBOARD,
    true
  );
  return { done: 'wizard_phone', qty: n };
}

// Шаг 3: имена гостей (проходки именные)
async function wizardPhone(chatId, deps, s, raw, fromContact = false) {
  const send = sender(deps, chatId);
  // контакт из Telegram принимаем и не российский (иностранные студенты):
  // 7–15 цифр по E.164; набранный руками номер — только российский мобильный
  const digits = String(raw || '').replace(/\D/g, '');
  const phone = normalizePhone(String(raw || '')) || (fromContact && /^\d{7,15}$/.test(digits) ? `+${digits}` : null);
  if (!phone) {
    await send('Не похоже на номер. Напиши в формате +7 912 345-67-89 или нажми «Отправить мой номер».', CONTACT_KEYBOARD);
    return { done: 'wizard_phone_bad' };
  }
  const d = { ...s.data, phone };
  await setSession(deps.sql, chatId, 'names', d);
  await send(namesPrompt(d.qty), { remove_keyboard: true });
  return { done: 'wizard_names' };
}

// «1. Иван Петров\n2) Мария» / «Иван, Мария» → ['Иван Петров', 'Мария']
function parseNames(text, qty) {
  // обрезаем по символам, а не по code units: эмодзи на границе ломало jsonb
  const clean = (x) => Array.from(x.replace(/^\s*\d+[.)-]?\s*/, '').replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
  let parts = String(text).split(/\n+/).map(clean).filter(Boolean);
  if (parts.length < qty) parts = String(text).split(/\n+|\s*[,;]\s*/).map(clean).filter(Boolean);
  if (parts.length < qty) parts = String(text).split(/\n+|\s*[,;]\s*|\s+и\s+/).map(clean).filter(Boolean);
  return parts;
}

// Шаг 4: сводка и подтверждение
async function wizardNames(chatId, deps, s, text) {
  const send = sender(deps, chatId);
  const qty = Number(s.data.qty);
  const names = parseNames(text, qty);
  if (names.length !== qty) {
    await send(
      `Насчитали ${names.length}, а нужно ${qty}. ` +
        (qty > 1 ? 'Напиши ещё раз — каждого с новой строки или через запятую.' : 'Напиши имя и фамилию.')
    );
    return { done: 'wizard_names_bad' };
  }
  if (names.some((x) => x.length < 2)) {
    await send('Слишком коротко — напиши имя и фамилию каждого гостя.');
    return { done: 'wizard_names_bad' };
  }
  const d = { ...s.data, names };
  await setSession(deps.sql, chatId, 'confirm', d);
  await sendSummary(chatId, deps, d);
  return { done: 'wizard_confirm' };
}

async function sendSummary(chatId, deps, d, repricedFrom = null) {
  const origin = originOf(deps);
  const amount = d.qty * d.priceRub;
  const head = repricedFrom
    ? `⚠️ Пока шло оформление, проходки по ${fmtRub(repricedFrom)} ₽ разобрали. Сейчас — <b>${fmtRub(d.priceRub)} ₽</b>.\n\n`
    : '';
  await sender(deps, chatId)(
    `${head}<b>Проверь бронь</b>\n${escHtml(d.title)} · ${escHtml(fmtWhen(d.startsAt))}\n` +
      `${d.qty} × ${fmtRub(d.priceRub)} ₽ = <b>${fmtRub(amount)} ₽</b>\n` +
      `${d.qty === 1 ? 'Гость' : 'Гости'}: ${d.names.map(escHtml).join(', ')}\nТелефон: ${escHtml(d.phone)}\n\n` +
      `Жмёшь «Забронировать» — значит, всем гостям есть 18 (на входе паспорт), ты принимаешь ` +
      `<a href="${origin}/offer">условия покупки</a> и <a href="${origin}/rules">правила ночи</a> и даёшь согласие на <a href="${origin}/privacy#consent">обработку данных</a>.`,
    {
      inline_keyboard: [
        [{ text: `✅ Забронировать за ${fmtRub(amount)} ₽`, callback_data: 'book:go' }],
        [{ text: '✖ Отмена', callback_data: 'book:no' }],
      ],
    },
    true
  );
}

// Шаг 5: бронь. Сессия атомарно переводится confirm → booking, чтобы
// двойной тап по кнопке не создал две брони.
async function wizardBook(chatId, deps, cb) {
  const send = sender(deps, chatId);
  const row = rowsOf(await deps.sql.query(
    `UPDATE tg_sessions SET state = 'booking', updated_at = now()
     WHERE chat_id = $1 AND state = 'confirm' RETURNING data`, [chatId]
  ))[0];
  if (!row) return { done: 'wizard_stale' };
  const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  await dropButtons(cb, deps);

  // не больше двух неоплаченных броней на чат: квота не должна висеть за одним человеком
  const pendingN = Number(rowsOf(await deps.sql.query(
    `SELECT count(*)::int AS n FROM tg_links l JOIN orders o ON o.id = l.order_id WHERE l.chat_id = $1 AND o.status = 'pending'`, [chatId]
  ))[0]?.n || 0);
  if (pendingN >= 2) {
    await clearSession(deps.sql, chatId);
    await send('У тебя уже две неоплаченные брони — оплати их или дождись, пока сгорят. Посмотреть: /tickets');
    return { done: 'wizard_too_many' };
  }

  const r = await placeOrder(deps.sql, {
    eventId: d.eventId, waveNo: d.waveNo, buyerName: d.names[0], phone: d.phone,
    buyerTg: cb.from?.username ? String(cb.from.username).slice(0, 64) : null,
    utm: { src: 'tgbot' },
    attendees: d.names.map((name) => ({ name })),
  }, { nowMs: deps.nowMs });

  if (!r.ok) {
    if (r.error === 'wave_sold_out') {
      // волна ушла, пока гость заполнял: та же компания по следующей цене
      const nw = await nextWaveFor(deps.sql, d.eventId, d.qty);
      if (nw) {
        const nd = { ...d, waveNo: nw.waveNo, priceRub: nw.priceRub };
        await setSession(deps.sql, chatId, 'confirm', nd);
        await sendSummary(chatId, deps, nd, nw.priceRub !== d.priceRub ? d.priceRub : null);
        return { done: 'wizard_repriced', priceRub: nw.priceRub };
      }
      // ни в одной волне нет мест на всю компанию — предлагаем меньше
      const left = await seatsLeft(deps.sql, d.eventId);
      if (left.maxOne > 0) {
        await setSession(deps.sql, chatId, 'qty', { ...d, cap: left.maxOne });
        const more = left.total > left.maxOne ? ` (всего осталось ${left.total} — остальное можно взять второй бронью)` : '';
        if (left.maxOne === 1) {
          await send(`Столько уже нет — осталась одна проходка${more}. Берёшь?`, {
            inline_keyboard: [[
              { text: '✅ Да, одну', callback_data: 'qty:1' },
              { text: '✖ Нет', callback_data: 'book:no' },
            ]],
          });
        } else {
          await send(`Столько уже нет — одной бронью можно до ${left.maxOne}${more}. Сколько берёшь?`, {
            inline_keyboard: [Array.from({ length: Math.min(left.maxOne, 4) }, (_, i) => ({ text: String(i + 1), callback_data: `qty:${i + 1}` }))],
          });
        }
        return { done: 'wizard_fewer', maxOne: left.maxOne, total: left.total };
      }
    }
    await clearSession(deps.sql, chatId);
    await send(
      r.error === 'wave_sold_out' ? 'Все проходки проданы 😔'
        : r.error === 'sales_closed' ? 'Продажи на эту ночь закрыты.'
          : r.error === 'too_many' ? `${r.message}.`
            : r.error === 'validation' ? `${r.message}. Начни заново: /buy`
              : 'Не получилось оформить — попробуй через минуту: /buy'
    );
    return { done: 'wizard_failed', error: r.error };
  }

  const { event, order } = r;
  await deps.sql.query(`INSERT INTO tg_links (chat_id, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chatId, order.id]);
  await deps.sql.query(`UPDATE orders SET tg_chat_id = $1 WHERE id = $2`, [chatId, order.id]);
  await clearSession(deps.sql, chatId);
  await deps.notify(ownerNotice(event, order, 'бот'), ownerNoticeMarkup(order));

  const origin = originOf(deps);
  const what = `${order.qty} ${plural(order.qty, 'проходка', 'проходки', 'проходок')} на ${escHtml(event.title)} · ${escHtml(fmtWhen(event.starts_at))}`;
  if (!order.transfer) {
    // демо-режим (PAYMENT_MODE=demo): проходки сразу
    const lines = order.tickets.map((t) => `• ${escHtml(t.holder_name)}: ${origin}${t.url}`);
    await send(
      `✅ Проходки у тебя: ${what}\n\n${lines.join('\n')}\n\n` +
        `Открой каждую, сделай скриншот QR и перешли друзьям их именные. На входе — паспорт, двери в ${fmtTimeOnly(event.starts_at)}.`,
      null, true
    );
    return { done: 'booked', order: order.id, paid: true };
  }
  const T = SITE.transfer || {};
  // номер и код — в <code>: тап по ним в Telegram копирует
  const lines = [
    `Сумма: <b>${fmtRub(order.amount)} ₽</b>`,
    T.phone ? `СБП по номеру: <code>${escHtml(T.phone)}</code>${T.bank ? ` (${escHtml(T.bank)})` : ''}` : null,
    T.recipient ? `Получатель: <b>${escHtml(T.recipient)}</b>` : null,
    `Код брони в комментарии: <code>${escHtml(order.code)}</code>`,
  ].filter(Boolean);
  await send(
    `🎟 Бронь <b>${escHtml(order.code)}</b> оформлена\n${what}\n` +
      `${order.qty === 1 ? 'Гость' : 'Гости'}: ${order.names.map(escHtml).join(', ')}\n\n` +
      `${lines.join('\n')}\n\n` +
      `Как перевести: приложение банка → «По номеру телефона» → номер выше${T.bank ? ` → банк ${escHtml(T.bank)}` : ''} → сумма → в комментарии код брони.\n\n` +
      `Бронь держим до <b>${escHtml(fmtWhen(order.expiresAt))}</b>. Перевёл — жми кнопку, QR придут сюда, как только увидим перевод.`,
    { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${order.id}` }]] },
    true
  );
  return { done: 'booked', order: order.id };
}

// ---------- кнопки ----------
async function handleCallback(cb, deps) {
  const answer = (text) => deps.tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) });
  const m = /^(pub|skip|cancel|pay|nopay|drop|del|bc|own|sub|claim|buy|more|qty|book|menu):([\w-]{1,64})$/.exec(String(cb.data || ''));
  if (!m || !deps.sql) {
    await answer('Кнопка устарела — /start');
    return { done: 'callback_bad' };
  }
  const [, action, arg] = m;
  const guestChat = cb.from?.id;

  // ---- кнопки гостя: меню и мастер брони ----
  if (action === 'menu') {
    await answer();
    if (arg === 'tickets') return sendTickets(guestChat, deps);
    return startWizard(guestChat, deps, null);
  }
  if (action === 'buy') {
    await answer();
    return startWizard(guestChat, deps, arg);
  }
  if (action === 'more') {
    await answer();
    return startWizard(guestChat, deps, arg, { force: true });
  }
  if (action === 'sub') {
    if (arg === 'off') {
      await unsubscribe(deps.sql, guestChat);
      await answer('Анонсы больше не придут');
      return { done: 'unsubscribed' };
    }
    const r = await subscribe(deps.sql, guestChat, 'button');
    await answer(r.created ? 'Готово — напишем о следующей ночи первым' : 'Ты уже подписан');
    if (r.created) await sender(deps, guestChat)('🔔 Подписка на анонсы включена. Не присылать — /stop');
    return { done: 'subscribed', created: r.created };
  }
  if (action === 'qty') {
    const s = await getSession(deps.sql, guestChat);
    if (!s || s.state !== 'qty') {
      await answer('Количество уже выбрано — поменять: /buy');
      return { done: 'wizard_stale' };
    }
    await answer();
    await dropButtons(cb, deps);
    return wizardQty(guestChat, deps, s, Number(arg));
  }
  if (action === 'book') {
    if (arg === 'no') {
      const had = await getSession(deps.sql, guestChat);
      await clearSession(deps.sql, guestChat);
      await dropButtons(cb, deps);
      await answer(had ? 'Отменили' : undefined);
      if (had) await sender(deps, guestChat)('Ок, ничего не бронируем. Передумаешь — /buy.');
      return { done: 'wizard_cancelled' };
    }
    const r = await wizardBook(guestChat, deps, cb);
    await answer(r.done === 'wizard_stale' ? 'Начни заново: /buy' : r.done === 'booked' ? 'Бронь оформлена' : undefined);
    return r;
  }

  // «Я перевёл» жмёт гость — из чата, привязанного к этой брони
  if (action === 'claim') {
    const chatId = guestChat;
    const linked = rowsOf(await deps.sql.query(
      `SELECT 1 FROM tg_links WHERE chat_id = $1 AND order_id = $2`, [chatId, arg]
    )).length > 0;
    if (!linked) {
      await answer('Недоступно');
      return { done: 'claim_denied' };
    }
    // повторное нажатие в ближайшие минуты не дёргает владельца ещё раз
    // сгоревшую бронь тоже можно заявить: «Подтвердить» у владельца вернёт места, если они есть
    const cur = rowsOf(await deps.sql.query(
      `SELECT status, (claimed_at IS NOT NULL AND claimed_at > now() - interval '10 minutes') AS recent
       FROM orders WHERE id = $1`, [arg]
    ))[0];
    if (!cur || !['pending', 'expired'].includes(cur.status)) {
      await answer('Бронь уже обработана');
      return { done: 'claim_noop' };
    }
    if (cur.recent) {
      await answer('Уже передали — как увидим перевод, QR придут сюда');
      return { done: 'claim_repeat' };
    }
    const o = rowsOf(await deps.sql.query(
      `UPDATE orders SET claimed_at = now()
       WHERE id = $1 AND status IN ('pending', 'expired')
       RETURNING id, pay_code, amount_rub, qty, buyer_name, buyer_phone, status`,
      [arg]
    ))[0];
    if (!o) {
      await answer('Бронь уже обработана');
      return { done: 'claim_noop' };
    }
    await deps.notify(
      `💸 ${o.pay_code} · ${fmtRub(o.amount_rub)} ₽ · ${o.qty} шт. — нажал «Я перевёл» в ${fmtTime(new Date(deps.nowMs).toISOString())} (бот)` +
        (o.status === 'expired' ? '\n⚠️ Бронь уже сгорела: «Подтвердить» вернёт места, если они ещё есть' : '') +
        `\n${o.buyer_name} · ${o.buyer_phone}\nВ банке ищи: ${fmtRub(o.amount_rub)} ₽ с комментарием ${o.pay_code}`,
      {
        inline_keyboard: [[
          { text: `✅ Подтвердить ${o.pay_code}`, callback_data: `pay:${o.id}` },
          { text: '✖ Не пришло', callback_data: `nopay:${o.id}` },
        ]],
      }
    );
    await answer('Передали организатору');
    await dropButtons(cb, deps);
    await deps.tg('sendMessage', {
      chat_id: chatId,
      text: 'Принято! Проверим перевод и пришлём QR сюда — обычно это несколько минут. Если тишина больше часа — напиши сюда, передадим организатору.',
    });
    return { done: 'claimed', order: o.id };
  }

  // остальные кнопки жмёт только владелец (его chat_id из env); чат
  // владельца не настроен — кнопки закрыты для всех, а не открыты для всех
  const ownerChat = String(process.env.TELEGRAM_CHAT_ID || '');
  if (!ownerChat || (String(cb.from?.id) !== ownerChat && String(cb.message?.chat?.id) !== ownerChat)) {
    await answer('Недоступно');
    return { done: 'callback_denied' };
  }
  const slug = arg;

  // итог остаётся в сообщении владельца: через час видно, что уже обработано
  const stamp = async (line) => {
    if (!cb.message?.message_id || !cb.message?.chat?.id) return;
    await deps.tg('editMessageText', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id,
      text: `${cb.message.text || ''}\n\n${line}`.trim(), disable_web_page_preview: true,
    });
  };
  const at = fmtTime(new Date(deps.nowMs).toISOString());

  if (action === 'pay') {
    const o = rowsOf(await deps.sql.query(CONFIRM_SQL, [slug, 'Telegram', 'transfer']))[0];
    if (!o) {
      await answer('Бронь уже обработана');
      return { done: 'pay_noop', order: slug };
    }
    await dropButtons(cb, deps);
    const tickets = (typeof o.tickets === 'string' ? JSON.parse(o.tickets) : o.tickets) || [];
    let delivered = false;
    let deliveryError = null;
    if (o.tg_chat_id) {
      const ev = await loadEvent(deps.sql, o.event_id);
      let markup = null;
      try { markup = await subOffer(deps.sql, o.tg_chat_id); } catch { /* без кнопки */ }
      const r = await callOf(deps)('sendMessage', {
        chat_id: o.tg_chat_id,
        disable_web_page_preview: true,
        text: paidMessage(tickets, originOf(deps), ev),
        ...(markup ? { reply_markup: markup } : {}),
      });
      delivered = r.ok;
      deliveryError = r.ok ? null : r.error;
    }
    await stamp(`✅ Подтверждено в ${at}${o.was === 'expired' ? ' (бронь была сгоревшей, места списаны снова)' : ''} · ` +
      (o.tg_chat_id ? (delivered ? 'QR гостю отправлены' : `гостю НЕ доставлено (${deliveryError}) — отправь ссылки из панели`) : 'гость без Telegram — ссылки в панели'));
    await answer(`Подтверждено: ${o.pay_code || slug}`);
    return { done: 'paid', order: slug, delivered };
  }
  if (action === 'nopay') {
    const o = rowsOf(await deps.sql.query(
      `UPDATE orders SET claimed_at = NULL WHERE id = $1 AND status IN ('pending', 'expired') RETURNING tg_chat_id, pay_code, amount_rub`,
      [slug]
    ))[0];
    await dropButtons(cb, deps);
    if (o?.tg_chat_id) {
      const T = SITE.transfer || {};
      await deps.tg('sendMessage', {
        chat_id: o.tg_chat_id,
        text: `Перевод по брони ${o.pay_code} пока не видим. Проверь: ${fmtRub(o.amount_rub)} ₽${T.recipient ? `, получатель ${T.recipient}` : ''}${T.bank ? ` (${T.bank})` : ''}, комментарий ${o.pay_code}. ` +
          'Если деньги ушли — пришли сюда скрин перевода и нажми «Я перевёл» ещё раз.',
        reply_markup: { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${slug}` }]] },
      });
    }
    if (o) await stamp(`✖ Не пришло — гостю сообщили в ${at}`);
    await answer(o ? 'Гостю сообщили' : 'Бронь уже обработана');
    return { done: o ? 'nopay' : 'nopay_noop', order: slug };
  }
  // drop: владелец снимает неоплаченную бронь прямо из уведомления
  if (action === 'drop') {
    const o = rowsOf(await deps.sql.query(CANCEL_SQL, [slug]))[0];
    await dropButtons(cb, deps);
    if (o?.tg_chat_id) {
      await deps.tg('sendMessage', {
        chat_id: o.tg_chat_id,
        text: 'Бронь отменена организатором, места вернулись в продажу. Если это ошибка — напиши сюда.',
      });
    }
    if (o) await stamp(`✖ Бронь отменена в ${at}, места возвращены`);
    await answer(o ? 'Бронь отменена' : 'Отменить можно только неоплаченную бронь');
    return { done: o ? 'dropped' : 'drop_noop', order: slug };
  }

  if (['pub', 'del', 'bc', 'own'].includes(action)) {
    const r = await ownerCallback(action, slug, cb, deps, answer);
    if (r) return r;
  }
  if (action === 'skip') {
    await deps.sql.query(`DELETE FROM price_waves WHERE event_id = $1 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.event_id = $1)`, [slug]);
    const rows = await deps.sql.query(
      `DELETE FROM events e WHERE e.id = $1 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.event_id = $1) RETURNING id`,
      [slug]
    );
    const removed = (rows.rows || rows).length > 0;
    if (!removed) {
      // уже есть продажи — не удаляем, а снимаем с витрины
      await deps.sql.query(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [slug]);
    }
    await answer('Убрано с сайта');
    return { done: 'skipped', slug };
  }
  // cancel: снять с продажи (продажи закрыты, купившим — возврат вручную)
  await deps.sql.query(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [slug]);
  await answer('Снято с продажи');
  return { done: 'cancelled', slug };
}

// Кнопки под сообщением убираем после нажатия — второй тап ничего не сделает
async function dropButtons(cb, deps) {
  if (!cb.message?.chat?.id || !cb.message?.message_id) return;
  try {
    await deps.tg('editMessageReplyMarkup', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
    });
  } catch { /* не критично */ }
}
