// Вебхук Telegram — один бот на две роли.
//  1) Гость: открыл бота по ссылке с экрана брони (/start ord_…) → чат
//     привязан к заказу; бот показывает реквизиты перевода, принимает
//     «Я перевёл», после подтверждения присылает проходки. /tickets —
//     все проходки этого чата.
//  2) Владелец (TELEGRAM_CHAT_ID): уведомления о бронях с кнопками
//     «Подтвердить / Не пришло»; пост в канале → анализ → черновик события
//     → публикация одной кнопкой (конвейер афиши, спящий без канала).
// Настройка: setWebhook с secret_token (см. BRIEF.md).
//
// handleUpdate экспортирован отдельно и принимает зависимости —
// тесты гоняют его на PGlite с фейковым экстрактором и без сети.
import { timingSafeEqual } from 'node:crypto';
import { db, hasDb } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner, tgApi } from './_lib/tg.js';
import { extractPost, extractorAvailable } from './_lib/extract.js';
import { normalizeAnnouncement, previewText } from './_lib/post-normalize.js';
import { isOrderId, transferText, ticketLinks, siteOrigin } from './_lib/booking.js';
import { CONFIRM_SQL } from './_lib/queries.js';
import { SITE } from '../assets/data/config.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;

  const secret = process.env.TG_WEBHOOK_SECRET || '';
  if (!secret) return fail(res, 503, 'not_configured', 'TG_WEBHOOK_SECRET не задан');
  const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail(res, 403, 'forbidden', 'Неверный секрет вебхука');
  }

  // Telegram ретраит не-200: отвечаем 200 всегда, кроме ошибок конфигурации
  try {
    await handleUpdate(req.body || {}, {
      sql: hasDb() ? db() : null,
      extract: extractPost,
      extractAvailable: extractorAvailable(),
      notify: notifyOwner,
      tg: tgApi,
      autoPublish: process.env.AUTO_PUBLISH === '1',
      nowMs: Date.now(),
      origin: siteOrigin(req),
    });
  } catch (e) {
    console.error('tg-webhook failed:', e);
  }
  ok(res);
}

export async function handleUpdate(update, deps) {
  if (update.callback_query) return handleCallback(update.callback_query, deps);
  if (update.message) return handleMessage(update.message, deps);
  const post = update.channel_post;
  if (!post) return { done: 'ignored' };

  // идемпотентность: каждый update_id обрабатываем один раз
  if (deps.sql && Number.isInteger(update.update_id)) {
    const rows = await deps.sql.query(
      `INSERT INTO tg_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id`,
      [update.update_id]
    );
    if (!(rows.rows || rows).length) return { done: 'duplicate' };
  }

  const text = String(post.text || post.caption || '').trim();
  const photoId = Array.isArray(post.photo) && post.photo.length
    ? post.photo[post.photo.length - 1].file_id
    : null;
  if (text.length < 8 && !photoId) return { done: 'empty' };

  // без LLM-ключа — честная деградация: переслать владельцу на ручную правку
  if (!deps.extractAvailable) {
    await deps.notify(
      `Новый пост в канале (анализ выключен — нет ANTHROPIC_API_KEY).\n` +
      `Если это афиша — обнови сайт вручную.\n\n${text.slice(0, 500)}`
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

const rowsOf = (r) => (r && r.rows) || r || [];
const fmtWhen = (iso) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: SITE.tz || 'Asia/Yekaterinburg', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const originOf = (deps) => String(deps.origin || process.env.SITE_ORIGIN || 'https://projectx-party.vercel.app').replace(/\/+$/, '');

// ---------- гость: личные сообщения боту ----------
async function handleMessage(msg, deps) {
  const chatId = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!chatId || (msg.chat.type && msg.chat.type !== 'private')) return { done: 'ignored' };
  const send = (t, markup) => deps.tg('sendMessage', {
    chat_id: chatId, text: t, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}),
  });
  if (!deps.sql) {
    await send('Бот пока не подключён к базе — проходки и адрес смотри на сайте.');
    return { done: 'no_db' };
  }

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/i.exec(text);
  if (start) {
    const payload = start[1] || '';
    if (isOrderId(payload)) {
      const o = await loadOrder(deps.sql, payload);
      if (!o) {
        await send('Не нашли бронь по этой ссылке. Открой бота ещё раз по кнопке «Получить в Telegram» на странице брони.');
        return { done: 'start_unknown' };
      }
      await deps.sql.query(
        `INSERT INTO tg_links (chat_id, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [chatId, o.id]
      );
      await deps.sql.query(`UPDATE orders SET tg_chat_id = $1 WHERE id = $2`, [chatId, o.id]);
      await sendOrderStatus(o, chatId, deps);
      return { done: 'linked', order: o.id };
    }
    await send(
      `Привет! Это бот PROJECT X.\n\nОткрой его по кнопке «Получить в Telegram» на странице брони — ` +
        `и проходки придут сюда, как только оплата подтвердится. Команда /tickets покажет твои проходки.`
    );
    return { done: 'start' };
  }

  if (/^\/tickets|проходк|билет/i.test(text)) {
    const rows = rowsOf(await deps.sql.query(
      `SELECT o.id FROM tg_links l JOIN orders o ON o.id = l.order_id
       WHERE l.chat_id = $1 ORDER BY o.created_at DESC LIMIT 5`,
      [chatId]
    ));
    if (!rows.length) {
      await send('Проходок пока нет. Забронируй на сайте и открой бота по кнопке «Получить в Telegram».');
      return { done: 'tickets_none' };
    }
    for (const r of rows) {
      const o = await loadOrder(deps.sql, r.id);
      if (o) await sendOrderStatus(o, chatId, deps);
    }
    return { done: 'tickets', n: rows.length };
  }

  await send('Я понимаю только /tickets — покажу твои проходки. Вопросы по ночи — в директ @project.x.prty.');
  return { done: 'unknown' };
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
  const send = (t, markup) => deps.tg('sendMessage', {
    chat_id: chatId, text: t, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}),
  });
  const origin = originOf(deps);
  const n = Number(o.qty);
  const what = `${n} ${plural(n, 'проходка', 'проходки', 'проходок')} на ${o.title} · ${fmtWhen(o.starts_at)}`;

  if (o.status === 'pending') {
    const waiting = o.claimed_at
      ? `\n\nТы уже нажал «Я перевёл» — ждём, пока владелец увидит перевод. Подтверждение придёт сюда.`
      : `\n\nБронь действует до ${fmtWhen(o.expires_at)}. Как переведёшь — нажми кнопку.`;
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
    const addr = o.address && !o.secret ? `\n\nАдрес: ${o.venue}, ${o.address}` : '';
    await send(`✅ Оплачено: ${what}\n\n${links.join('\n') || 'Проходки уже использованы или отозваны.'}${addr}`);
    return;
  }
  await send(
    `Бронь ${o.pay_code || o.id} ${o.status === 'cancelled' ? 'отменена' : 'сгорела'}. ` +
      `Забронировать заново: ${origin}/e/${o.event_id}`
  );
}

// ---------- кнопки ----------
async function handleCallback(cb, deps) {
  const answer = (text) => deps.tg('answerCallbackQuery', { callback_query_id: cb.id, text });
  const m = /^(pub|skip|cancel|pay|nopay|claim):([\w-]{1,64})$/.exec(String(cb.data || ''));
  if (!m || !deps.sql) {
    await answer('Не получилось');
    return { done: 'callback_bad' };
  }
  const [, action, arg] = m;

  // «Я перевёл» жмёт гость — из чата, привязанного к этой брони
  if (action === 'claim') {
    const chatId = cb.from?.id;
    const linked = rowsOf(await deps.sql.query(
      `SELECT 1 FROM tg_links WHERE chat_id = $1 AND order_id = $2`, [chatId, arg]
    )).length > 0;
    if (!linked) {
      await answer('Недоступно');
      return { done: 'claim_denied' };
    }
    const o = rowsOf(await deps.sql.query(
      `UPDATE orders SET claimed_at = COALESCE(claimed_at, now())
       WHERE id = $1 AND status = 'pending'
       RETURNING id, pay_code, amount_rub, qty, buyer_name, buyer_phone`,
      [arg]
    ))[0];
    if (!o) {
      await answer('Бронь уже обработана');
      return { done: 'claim_noop' };
    }
    await deps.notify(
      `💸 Гость сообщил о переводе (из бота)\n${o.pay_code} · ${o.amount_rub} ₽ · ${o.qty} шт.\n` +
        `${o.buyer_name}, ${o.buyer_phone}\n\nПроверь поступление в банке и подтверди:`,
      {
        inline_keyboard: [[
          { text: `✅ Подтвердить ${o.pay_code}`, callback_data: `pay:${o.id}` },
          { text: '✖ Не пришло', callback_data: `nopay:${o.id}` },
        ]],
      }
    );
    await answer('Передали владельцу');
    await deps.tg('sendMessage', {
      chat_id: chatId,
      text: 'Спасибо! Как только владелец увидит перевод, проходки придут сюда. Обычно это несколько минут.',
    });
    return { done: 'claimed', order: o.id };
  }

  // остальные кнопки жмёт только владелец (его chat_id из env)
  const ownerChat = String(process.env.TELEGRAM_CHAT_ID || '');
  if (ownerChat && String(cb.from?.id) !== ownerChat && String(cb.message?.chat?.id) !== ownerChat) {
    await answer('Недоступно');
    return { done: 'callback_denied' };
  }
  const slug = arg;

  if (action === 'pay') {
    const o = rowsOf(await deps.sql.query(CONFIRM_SQL, [slug, 'Telegram', 'transfer']))[0];
    if (!o) {
      await answer('Бронь уже обработана');
      return { done: 'pay_noop', order: slug };
    }
    await dropButtons(cb, deps);
    const tickets = (typeof o.tickets === 'string' ? JSON.parse(o.tickets) : o.tickets) || [];
    if (o.tg_chat_id) {
      const links = ticketLinks(tickets, originOf(deps)).map((t) => `• ${t.holder_name}: ${t.url}`);
      await deps.tg('sendMessage', {
        chat_id: o.tg_chat_id,
        disable_web_page_preview: true,
        text: `✅ Оплата подтверждена — проходки у тебя.\n\n${links.join('\n')}\n\n` +
          `Открой каждую, сделай скриншот QR и перешли друзьям их именные. На входе — паспорт, двери в ${SITE.doorsOpen || '22:00'}.`,
      });
    }
    await answer(`Подтверждено: ${o.pay_code || slug}`);
    return { done: 'paid', order: slug, delivered: Boolean(o.tg_chat_id) };
  }
  if (action === 'nopay') {
    const o = rowsOf(await deps.sql.query(
      `UPDATE orders SET claimed_at = NULL WHERE id = $1 AND status = 'pending' RETURNING tg_chat_id, pay_code`,
      [slug]
    ))[0];
    await dropButtons(cb, deps);
    if (o?.tg_chat_id) {
      await deps.tg('sendMessage', {
        chat_id: o.tg_chat_id,
        text: `Перевод по брони ${o.pay_code} пока не нашли. Проверь сумму и код в комментарии — и нажми «Я перевёл» ещё раз, когда деньги уйдут.`,
        reply_markup: { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${slug}` }]] },
      });
    }
    await answer(o ? 'Гостю сообщили' : 'Бронь уже обработана');
    return { done: o ? 'nopay' : 'nopay_noop', order: slug };
  }

  if (action === 'pub') {
    const rows = await deps.sql.query(
      `UPDATE events SET status = 'onsale' WHERE id = $1 AND status = 'draft' RETURNING id`,
      [slug]
    );
    const okRow = (rows.rows || rows).length > 0;
    await answer(okRow ? 'Опубликовано — уже на сайте' : 'Уже обработано');
    return { done: okRow ? 'published' : 'noop', slug };
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

// Кнопки под уведомлением убираем после нажатия — второй тап ничего не сделает
async function dropButtons(cb, deps) {
  if (!cb.message?.chat?.id || !cb.message?.message_id) return;
  try {
    await deps.tg('editMessageReplyMarkup', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
    });
  } catch { /* не критично */ }
}
