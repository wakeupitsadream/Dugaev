// Ядро оформления брони — одно на HTTP-заказ с сайта (api/order.js) и на
// покупку в боте (api/tg-webhook.js). Здесь всё, что не зависит от канала:
// проверка события и гостей, атомарное списание квоты, генерация кодов,
// текст уведомления владельцу. Ответ — простой объект, без req/res.
import { validateAttendees } from '../../assets/ticket-format.js';
import { ticketId, orderId, payCode } from './ids.js';
import { makeToken, primarySecret } from './sign.js';
import { paymentMode, holdMinutes } from './booking.js';
import { ORDER_SQL, NEXT_WAVE_SQL, NEXT_WAVE_FOR_SQL, SEATS_LEFT_SQL, EXPIRE_SQL } from './queries.js';

const rowsOf = (r) => (r && r.rows) || r || [];

// input: { eventId, waveNo, buyerName, phone, buyerTg, utm, attendees:[{name, minor?}] }
// → { ok:true, event, order } | { ok:false, status, error, message, extra }
export async function placeOrder(sql, input, { nowMs = Date.now() } = {}) {
  const { eventId, waveNo, buyerName, phone, buyerTg = null, utm = null } = input;
  const attendees = Array.isArray(input.attendees) ? input.attendees : [];

  let event;
  try {
    // сгоревшие брони освобождают места до того, как мы попробуем занять свои
    await sql.query(EXPIRE_SQL);
    event = rowsOf(await sql.query(
      `SELECT id, title, city, venue, address, secret, starts_at, age_rating, status FROM events WHERE id = $1`,
      [eventId]
    ))[0];
  } catch (err) {
    console.warn('order: БД недоступна:', err.message);
    return { ok: false, status: 503, error: 'db_unavailable', message: 'Онлайн-оформление сейчас недоступно' };
  }
  if (!event) return { ok: false, status: 404, error: 'not_found', message: 'Такой тусовки нет' };
  if (event.status !== 'onsale' || new Date(event.starts_at).getTime() <= nowMs) {
    return { ok: false, status: 410, error: 'sales_closed', message: 'Продажи на эту тусовку закрыты' };
  }

  const av = validateAttendees(attendees, Number(event.age_rating));
  if (!av.ok) {
    const minor = av.errors.some((e) => e.code === 'minor_forbidden');
    return {
      ok: false, status: 400, error: 'validation',
      message: minor ? 'Вечеринка 18+ — проходки несовершеннолетним не продаются' : 'Заполни имена всех гостей',
      extra: { attendees: av.errors },
    };
  }

  const qty = attendees.length;
  const names = attendees.map((a) => String(a.name).trim().slice(0, 80));
  const ages = attendees.map((a) => (a.minor && Number(event.age_rating) < 18 ? 'minor' : 'adult'));
  const transfer = paymentMode() === 'transfer';
  const provider = transfer ? 'transfer' : 'stub';
  const hold = transfer ? holdMinutes(event.starts_at, nowMs) : 0;

  // Коллизия id билета (48 бит) или кода брони почти невероятна, но UNIQUE + повтор — обязаны
  let created = 0;
  let priceRub = null;
  let oid = null;
  let tids = [];
  let code = null;
  let expiresAt = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    oid = orderId();
    tids = names.map(() => ticketId());
    code = transfer ? payCode() : null;
    try {
      const r = rowsOf(await sql.query(ORDER_SQL, [
        qty, eventId, waveNo, oid, buyerName, phone, buyerTg,
        utm ? JSON.stringify(utm) : null, tids, names, ages, provider, hold, code, false,
      ]))[0] || {};
      priceRub = r.price_rub === null || r.price_rub === undefined ? null : Number(r.price_rub);
      created = Number(r.created || 0);
      expiresAt = r.expires_at ? new Date(r.expires_at).toISOString() : null;
      break;
    } catch (err) {
      if (/duplicate key/i.test(String(err.message)) && attempt < 2) continue;
      console.error('order failed:', err);
      return { ok: false, status: 503, error: 'db_unavailable', message: 'Онлайн-оформление сейчас недоступно' };
    }
  }

  if (priceRub === null || created !== qty) {
    // волна распродана (или мест меньше, чем просят) — предлагаем следующую цену
    const nextWave = await nextWaveOf(sql, eventId);
    return {
      ok: false, status: 409, error: 'wave_sold_out',
      message: nextWave ? 'Эта волна закончилась — есть следующая' : 'Все проходки проданы',
      extra: { next_wave: nextWave },
    };
  }

  const secret = primarySecret();
  const tickets = tids.map((id, i) => ({ id, holder_name: names[i], url: `/t/${makeToken(id, secret)}` }));
  return {
    ok: true,
    event,
    order: {
      id: oid, code, expiresAt, hold, provider, transfer, priceRub, qty, amount: priceRub * qty,
      buyerName, phone, buyerTg, names, tickets,
    },
  };
}

// Первая волна, где ещё есть места (публичная), или null
export async function nextWaveOf(sql, eventId) {
  try {
    const nw = rowsOf(await sql.query(NEXT_WAVE_SQL, [eventId]))[0];
    return nw ? { waveNo: Number(nw.wave_no), name: nw.name, priceRub: Number(nw.price_rub), left: Number(nw.left) } : null;
  } catch {
    return null;
  }
}

// Первая публичная волна, где хватит мест на qty проходок, или null
export async function nextWaveFor(sql, eventId, qty) {
  try {
    const nw = rowsOf(await sql.query(NEXT_WAVE_FOR_SQL, [eventId, qty]))[0];
    return nw ? { waveNo: Number(nw.wave_no), name: nw.name, priceRub: Number(nw.price_rub), left: Number(nw.left) } : null;
  } catch {
    return null;
  }
}

// Сколько мест осталось: { total } по всем публичным волнам и { maxOne } —
// самое большое, что можно взять одной бронью (в одной волне)
export async function seatsLeft(sql, eventId) {
  try {
    const r = rowsOf(await sql.query(SEATS_LEFT_SQL, [eventId]))[0] || {};
    return { total: Number(r.total || 0), maxOne: Number(r.max_one || 0) };
  } catch {
    return { total: 0, maxOne: 0 };
  }
}

// Текст уведомления владельцу о новой брони/продаже. via — откуда пришла
// («сайт», «бот»), чтобы в чате было видно канал.
export function ownerNotice(event, order, via = 'сайт') {
  const who = `${order.buyerName}, ${order.phone}${order.buyerTg ? ', @' + order.buyerTg : ''}`;
  return order.transfer
    ? `🕒 Бронь ${order.code}: ${order.qty} × ${order.priceRub} ₽ = ${order.amount} ₽ · ждём перевод (${via})\n` +
      `${event.title}\nГость: ${who}\nИмена: ${order.names.join(', ')}\nСрок брони: ${order.hold} мин · заказ ${order.id}`
    : `💸 Продажа: ${order.qty} × ${order.priceRub} ₽ = ${order.amount} ₽ (${via})\n` +
      `${event.title} · ${event.venue}\nПокупатель: ${who}\nГости: ${order.names.join(', ')}\nЗаказ ${order.id}`;
}
