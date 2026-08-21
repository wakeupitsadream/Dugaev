// Касса на входе: админ оформляет гостя, который платит на дверях
// (наличные/перевод). Та же атомарная механика квот, provider='door' —
// в статистике касса видна отдельно от онлайна. Опционально сразу чек-ин.
import { db, hasDb } from './_lib/db.js';
import { ticketId, orderId } from './_lib/ids.js';
import { makeToken, primarySecret } from './_lib/sign.js';
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { isAdmin } from './_lib/auth.js';
import { notifyOwner } from './_lib/tg.js';
import { ORDER_SQL, CHECKIN_SQL, NEXT_WAVE_SQL } from './_lib/queries.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;
  if (!isAdmin(req)) return fail(res, 403, 'forbidden', 'Нужен админ-ключ');
  if (!hasDb()) return fail(res, 503, 'db_unavailable', 'БД не настроена');

  const b = req.body || {};
  const eventId = String(b.event_id || '');
  const waveNo = Number(b.wave_no);
  const name = String(b.name || '').trim().slice(0, 80);
  const by = String(b.by || '').trim().slice(0, 64) || 'касса';
  const doCheckin = b.checkin !== false; // на кассе гость обычно сразу заходит

  if (!eventId || !Number.isInteger(waveNo)) return fail(res, 400, 'validation', 'Некорректный запрос');
  if (name.length < 2) return fail(res, 400, 'validation', 'Имя гостя — минимум 2 символа', { fields: { name: 'Как зовут гостя?' } });

  const sql = db();
  let created = 0;
  let priceRub = null;
  let oid = null;
  let tid = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    oid = orderId();
    tid = ticketId();
    try {
      const rows = await sql.query(ORDER_SQL, [
        1, eventId, waveNo, oid, name, 'касса', null,
        JSON.stringify({ src: 'door' }), [tid], [name], ['adult'], 'door',
      ]);
      const r = (rows.rows || rows)[0] || {};
      priceRub = r.price_rub === null ? null : Number(r.price_rub);
      created = Number(r.created || 0);
      break;
    } catch (err) {
      if (/duplicate key/i.test(String(err.message)) && attempt < 2) continue;
      console.error('walkin failed:', err);
      return fail(res, 503, 'db_unavailable', 'БД не ответила — попробуй ещё раз');
    }
  }

  if (priceRub === null || created !== 1) {
    let nextWave = null;
    try {
      const rows = await sql.query(NEXT_WAVE_SQL, [eventId]);
      const nw = (rows.rows || rows)[0];
      if (nw) nextWave = { waveNo: Number(nw.wave_no), name: nw.name, priceRub: Number(nw.price_rub), left: Number(nw.left) };
    } catch { /* не критично */ }
    return fail(res, 409, 'wave_sold_out',
      nextWave ? 'Эта волна распродана — выбери следующую' : 'Билетов больше нет',
      { next_wave: nextWave });
  }

  let checkedInAt = null;
  if (doCheckin) {
    try {
      const rows = await sql.query(CHECKIN_SQL, [tid, null, by]);
      const r = (rows.rows || rows)[0];
      if (r) checkedInAt = new Date(r.checked_in_at).toISOString();
    } catch (e) {
      console.warn('walkin checkin failed:', e.message);
    }
  }

  await notifyOwner(
    `🎟 Касса: ${name} · ${priceRub} ₽${checkedInAt ? ' · впущен' : ''}\nСобытие: ${eventId}\nОформил: ${by}`
  );

  ok(res, {
    order_id: oid,
    price_rub: priceRub,
    checked_in_at: checkedInAt,
    ticket: { id: tid, holder_name: name, url: `/t/${makeToken(tid, primarySecret())}` },
  });
}
