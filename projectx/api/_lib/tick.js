// Фоновые задачи, которые не ждут действий гостя:
//  - напоминание о брони, которая сгорит через полчаса (только тем, у кого
//    есть чат с ботом, — больше писать некуда);
//  - лист ожидания: на распроданной ночи освободились места — пишем ждущим
//    по очереди, кто раньше встал;
//  - рассылки по времени (анонс, ранний доступ) и дослать начатые.
// Запускаются внешним планировщиком (GET /api/seed?tick=1 раз в 1–5 минут)
// и попутно любым апдейтом бота. Чаще раза в минуту работа не делается, кто
// бы её ни дёрнул: отметка в px_meta ставится атомарно (TICK_SQL).
import {
  TICK_SQL, EXPIRE_SQL, REMIND_SQL, WAITLIST_DUE_SQL, WAITLIST_SKIP_BOOKED_SQL, WAITLIST_CLAIM_SQL, DUE_BROADCASTS_SQL,
} from './queries.js';
import { rowsOf, fmtWhen, fmtTimeOnly, plural, escHtml, originOf, sender, loadEvent } from './bot-kit.js';
import { transferHtml } from './booking.js';
import { runBroadcast, reportText } from './broadcast.js';
import { notifyOwner } from './tg.js';

// budgetMs — сколько можно потратить на рассылки: вебхук бота не держим долго
export async function runTick(deps, { force = false, budgetMs = 18_000 } = {}) {
  const { sql } = deps;
  if (!sql) return { ok: false, skipped: 'no_db' };
  if (!force && !rowsOf(await sql.query(TICK_SQL)).length) return { ok: true, skipped: 'recent' };
  // сгоревшие брони — до подсчёта мест: их места и есть «освободились»
  let expired = 0;
  try { expired = rowsOf(await sql.query(EXPIRE_SQL)).length; } catch (e) { console.warn('tick: expire', e.message); }
  const reminded = await sendReminders(deps);
  const waitlist = await notifyWaitlist(deps);
  const broadcasts = await runScheduled(deps, { budgetMs });
  return { ok: true, expired, reminded, waitlist, broadcasts };
}

// Рассылки, которым пора (по времени или начатые и не дошедшие до конца):
// гоним порциями, пока хватает времени; закончили — владельцу итог
export async function runScheduled(deps, { budgetMs = 18_000 } = {}) {
  const due = rowsOf(await deps.sql.query(DUE_BROADCASTS_SQL));
  const notify = deps.notify || notifyOwner;
  const t0 = Date.now();
  let finished = 0;
  for (const b of due) {
    if (Date.now() - t0 > budgetMs) break;
    let r;
    // порция — в пределах оставшегося времени: функцию не оборвут посреди пачки
    do {
      r = await runBroadcast(deps, b.event_id, { kind: b.kind, sleep: deps.sleep, budgetMs: Math.max(0, budgetMs - (Date.now() - t0)) });
    } while (r.ok && !r.done && !r.busy && Date.now() - t0 < budgetMs);
    const what = b.kind === 'early' ? 'Ранний доступ' : 'Анонс';
    if (!r.ok) {
      // ночь сменила статус к назначенному времени — план снимаем, владельцу сообщаем
      await deps.sql.query(`UPDATE broadcasts SET scheduled_at = NULL, updated_at = now() WHERE id = $1`, [b.id]);
      await notify(`⚠️ ${what} по расписанию не разослан: ${r.message}`);
    } else if (r.done) {
      finished++;
      const first = rowsOf(await deps.sql.query(`UPDATE broadcasts SET reported = true WHERE id = $1 AND NOT reported RETURNING id`, [b.id]));
      if (first.length) {
        const ev = await loadEvent(deps.sql, b.event_id);
        await notify(reportText(b.kind, ev ? ev.title : b.event_id, r));
      }
    }
  }
  return finished;
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
