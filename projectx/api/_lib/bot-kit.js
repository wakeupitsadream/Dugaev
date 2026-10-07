// Общие помощники бота: форматирование, отправка, загрузка ночи. Ими
// пользуются вебхук (гость), функции владельца и рассылка анонсов.
import { SITE } from '../../assets/data/config.js';

export const rowsOf = (r) => (r && r.rows) || r || [];
export const fmtWhen = (iso) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: SITE.tz || 'Asia/Yekaterinburg', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
export const fmtTimeOnly = (iso) =>
  new Date(iso).toLocaleTimeString('ru-RU', { timeZone: SITE.tz || 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' });
export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
export const originOf = (deps) => String(deps.origin || process.env.SITE_ORIGIN || 'https://proxject.ru').replace(/\/+$/, '');
// «10 октября» без времени: время дверей пишем отдельно, чтобы не дублировать
export const fmtDay = (iso) => fmtWhen(iso).replace(/ в \d{1,2}:\d{2}$/, '');
export const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// send(text, replyMarkup, html): html=true — разметка <b>/<a> (все данные гостя экранируются)
export const sender = (deps, chatId) => (text, markup, html = false) => deps.tg('sendMessage', {
  chat_id: chatId,
  text,
  disable_web_page_preview: true,
  ...(html ? { parse_mode: 'HTML' } : {}),
  ...(markup ? { reply_markup: markup } : {}),
});
// Вызов Bot API с текстом ошибки: deps.call, а без него — обёртка над deps.tg
export const callOf = (deps) => deps.call || (async (method, payload) => {
  const r = await deps.tg(method, payload);
  return r === null ? { ok: false, error: 'нет ответа' } : { ok: true, result: r };
});
// Абсолютный адрес афиши для sendPhoto: Telegram качает её сам
export const posterUrl = (p, deps) => {
  if (!p) return null;
  if (/^https?:\/\//.test(p)) return p;
  const base = String(deps.assetOrigin || originOf(deps)).replace(/\/+$/, '');
  return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
};
export const isOwnerChat = (chatId) => {
  const owner = String(process.env.TELEGRAM_CHAT_ID || '');
  return Boolean(owner) && String(chatId) === owner;
};

export async function loadEvent(sql, id) {
  return rowsOf(await sql.query(
    `SELECT id, title, venue, address, secret, starts_at, ends_at, status, poster_url FROM events WHERE id = $1`, [id]
  ))[0] || null;
}
// Ближайшая ночь в продаже
export async function nearestEvent(sql, nowMs) {
  return rowsOf(await sql.query(
    `SELECT id, title, venue, address, secret, starts_at, ends_at, status, poster_url FROM events
     WHERE status = 'onsale' AND COALESCE(ends_at, starts_at + interval '8 hours') > $1 ORDER BY starts_at LIMIT 1`,
    [new Date(nowMs).toISOString()]
  ))[0] || null;
}
export async function eventWaves(sql, eventId) {
  return rowsOf(await sql.query(
    `SELECT wave_no, name, price_rub, quota, sold, public, early FROM price_waves WHERE event_id = $1 ORDER BY wave_no`, [eventId]
  )).map((w) => ({
    waveNo: Number(w.wave_no), name: w.name, priceRub: Number(w.price_rub),
    quota: Number(w.quota), sold: Number(w.sold), public: w.public !== false, early: w.early === true,
  }));
}
// Ночь в раннем доступе (ещё не на сайте) — ближайшая
export async function earlyEvent(sql, nowMs) {
  return rowsOf(await sql.query(
    `SELECT id, title, venue, address, secret, starts_at, ends_at, status, poster_url FROM events
     WHERE status = 'early' AND COALESCE(ends_at, starts_at + interval '8 hours') > $1 ORDER BY starts_at LIMIT 1`,
    [new Date(nowMs).toISOString()]
  ))[0] || null;
}

// Шаги мастеров между сообщениями (бронь гостя, вопросы бота владельцу) —
// одна строка tg_sessions на чат. Брошенный мастер живёт полсуток: имена,
// набранные после паузы, не должна встречать афиша
export const SESSION_TTL_MS = 12 * 3600_000;
export async function getSession(sql, chatId) {
  const s = rowsOf(await sql.query(`SELECT state, data, updated_at FROM tg_sessions WHERE chat_id = $1`, [chatId]))[0];
  if (!s || Date.now() - new Date(s.updated_at).getTime() > SESSION_TTL_MS) return null;
  return { state: s.state, data: typeof s.data === 'string' ? JSON.parse(s.data) : (s.data || {}) };
}
export async function setSession(sql, chatId, state, data) {
  await sql.query(
    `INSERT INTO tg_sessions (chat_id, state, data, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (chat_id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()`,
    [chatId, state, JSON.stringify(data)]
  );
}
export const clearSession = (sql, chatId) => sql.query(`DELETE FROM tg_sessions WHERE chat_id = $1`, [chatId]);
