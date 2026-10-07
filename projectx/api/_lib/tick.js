// Фоновые задачи, которые не ждут действий гостя:
//  - напоминание о брони, которая сгорит через полчаса (только тем, у кого
//    есть чат с ботом, — больше писать некуда);
//  - лист ожидания: на распроданной ночи освободились места — пишем ждущим
//    по очереди, кто раньше встал.
// Запускаются внешним планировщиком (GET /api/seed?tick=1 раз в 1–5 минут)
// и попутно любым апдейтом бота. Чаще раза в минуту работа не делается, кто
// бы её ни дёрнул: отметка в px_meta ставится атомарно (TICK_SQL).
import {
  TICK_SQL, EXPIRE_SQL, REMIND_SQL, WAITLIST_DUE_SQL, WAITLIST_SKIP_BOOKED_SQL, WAITLIST_CLAIM_SQL,
} from './queries.js';
import { rowsOf, fmtWhen, fmtTimeOnly, plural, escHtml, originOf, sender } from './bot-kit.js';
import { transferHtml } from './booking.js';

export async function runTick(deps, { force = false } = {}) {
  const { sql } = deps;
  if (!sql) return { ok: false, skipped: 'no_db' };
  if (!force && !rowsOf(await sql.query(TICK_SQL)).length) return { ok: true, skipped: 'recent' };
  // сгоревшие брони — до подсчёта мест: их места и есть «освободились»
  let expired = 0;
  try { expired = rowsOf(await sql.query(EXPIRE_SQL)).length; } catch (e) { console.warn('tick: expire', e.message); }
  const reminded = await sendReminders(deps);
  const waitlist = await notifyWaitlist(deps);
  return { ok: true, expired, reminded, waitlist };
}

export async function sendReminders(deps) {
  const rows = rowsOf(await deps.sql.query(REMIND_SQL));
  let sent = 0;
  for (const o of rows) {
    const left = Math.max(1, Math.round((new Date(o.expires_at).getTime() - deps.nowMs) / 60_000));
    const n = Number(o.qty);
    const r = await sender(deps, o.tg_chat_id)(
      `⏳ Бронь <b>${escHtml(o.pay_code)}</b> сгорит через ${left} ${plural(left, 'минуту', 'минуты', 'минут')} — в ${escHtml(fmtTimeOnly(o.expires_at))}.\n` +
        `${n} ${plural(n, 'проходка', 'проходки', 'проходок')} на ${escHtml(o.title)} · ${escHtml(fmtWhen(o.starts_at))}\n\n` +
        `${transferHtml(Number(o.amount_rub), o.pay_code)}\n\n` +
        'Перевёл — жми «Я перевёл», и бронь не сгорит. Не получится — ничего делать не нужно: места вернутся в продажу сами.',
      { inline_keyboard: [[{ text: '✅ Я перевёл', callback_data: `claim:${o.id}` }]] },
      true
    );
    if (r) sent++;
  }
  return sent;
}

export async function notifyWaitlist(deps) {
  const due = rowsOf(await deps.sql.query(WAITLIST_DUE_SQL)).filter((e) => Number(e.seats) > 0);
  const origin = originOf(deps);
  let sent = 0;
  for (const e of due) {
    await deps.sql.query(WAITLIST_SKIP_BOOKED_SQL, [e.id]);
    // мест мало — пишем немногим больше, чем мест: остальные дождутся
    // следующего освобождения, а не получат «успей» на пустое место
    const batch = Math.min(30, Math.max(5, Number(e.seats) * 3));
    const chats = rowsOf(await deps.sql.query(WAITLIST_CLAIM_SQL, [e.id, batch]));
    for (const c of chats) {
      const r = await sender(deps, c.chat_id)(
        `🎟 Как и обещали: на <b>${escHtml(e.title)}</b> · ${escHtml(fmtWhen(e.starts_at))} освободились места.\n\n` +
          'Успей забронировать — место достаётся тому, кто первым оформит бронь.',
        { inline_keyboard: [[
          { text: '🎟 Забронировать', callback_data: `buy:${e.id}` },
          { text: '🌐 На сайте', url: `${origin}/e/${encodeURIComponent(e.id)}?src=waitlist` },
        ]] },
        true
      );
      if (r) sent++;
    }
  }
  return sent;
}
