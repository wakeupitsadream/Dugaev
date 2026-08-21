// Вебхук Telegram: пост в канале → анализ → черновик события в БД →
// подтверждение владельцем одной кнопкой → событие на сайте (без редеплоя).
// Настройка: бот добавлен админом канала, setWebhook с secret_token
// (см. BRIEF.md, раздел «Автообновление из канала»).
//
// handleUpdate экспортирован отдельно и принимает зависимости —
// тесты гоняют его на PGlite с фейковым экстрактором.
import { timingSafeEqual } from 'node:crypto';
import { db, hasDb } from './_lib/db.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner, tgApi } from './_lib/tg.js';
import { extractPost, extractorAvailable } from './_lib/extract.js';
import { normalizeAnnouncement, previewText } from './_lib/post-normalize.js';

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
    });
  } catch (e) {
    console.error('tg-webhook failed:', e);
  }
  ok(res);
}

export async function handleUpdate(update, deps) {
  if (update.callback_query) return handleCallback(update.callback_query, deps);
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

async function handleCallback(cb, deps) {
  const answer = (text) => deps.tg('answerCallbackQuery', { callback_query_id: cb.id, text });
  // кнопки жмёт только владелец (его chat_id из env)
  const ownerChat = String(process.env.TELEGRAM_CHAT_ID || '');
  if (ownerChat && String(cb.from?.id) !== ownerChat && String(cb.message?.chat?.id) !== ownerChat) {
    await answer('Недоступно');
    return { done: 'callback_denied' };
  }
  const m = /^(pub|skip|cancel):([\w-]{1,64})$/.exec(String(cb.data || ''));
  if (!m || !deps.sql) {
    await answer('Не получилось');
    return { done: 'callback_bad' };
  }
  const [, action, slug] = m;
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
