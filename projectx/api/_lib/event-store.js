// Запись мероприятия в базу — одна на панель (/api/event-upsert) и бота
// (черновик из присланного поста). Проверку полей делает parseEventForm,
// здесь только SQL: событие, волны, снос/скрытие убранных волн.
import { EVENT_UPSERT_SQL, WAVE_UPSERT_SQL, WAVES_PRUNE_SQL, WAVES_HIDE_SQL } from './queries.js';

const rowsOf = (r) => (r && r.rows) || r || [];

// Текущее состояние события для проверки квот и сноса волн; null — нового нет
export async function loadExisting(sql, id) {
  if (!id) return null;
  const ev = rowsOf(await sql.query(`SELECT id, status FROM events WHERE id = $1`, [id]))[0];
  if (!ev) return null;
  const waves = rowsOf(await sql.query(`SELECT wave_no, sold FROM price_waves WHERE event_id = $1`, [id]));
  return { id, status: ev.status, waves: waves.map((w) => ({ waveNo: Number(w.wave_no), sold: Number(w.sold) })) };
}

// Свободный id для нового события: px-novaya-noch-1010, …-2, …-3
export async function uniqueEventId(sql, baseId) {
  for (let i = 1; i <= 9; i++) {
    const id = i === 1 ? baseId : `${baseId.slice(0, 37)}-${i}`;
    const taken = rowsOf(await sql.query(`SELECT 1 FROM events WHERE id = $1`, [id])).length > 0;
    if (!taken) return id;
  }
  return `${baseId.slice(0, 32)}-${Date.now().toString(36).slice(-6)}`;
}

// parsed — результат parseEventForm (ok: true) → { waves: [{waveNo, quota, sold}], warnings }
export async function saveEvent(sql, parsed) {
  const { event: e, waves, prune } = parsed;
  const warnings = [...(parsed.warnings || [])];
  await sql.query(EVENT_UPSERT_SQL, [
    e.id, e.brand, e.title, e.city, e.venue, e.address, e.startsAt, e.endsAt,
    e.ageRating, e.status, e.posterUrl === undefined ? null : e.posterUrl, e.descr,
    e.lineup === undefined ? null : JSON.stringify(e.lineup), e.secret,
    e.capacity === undefined ? null : e.capacity,
    e.program === undefined ? null : JSON.stringify(e.program),
  ]);
  const saved = [];
  for (const w of waves) {
    const row = rowsOf(await sql.query(WAVE_UPSERT_SQL, [e.id, w.waveNo, w.name, w.priceRub, w.quota, w.public]))[0];
    if (row) saved.push({ waveNo: Number(row.wave_no), quota: Number(row.quota), sold: Number(row.sold) });
  }
  if (prune && prune.length) {
    const keep = waves.map((w) => w.waveNo);
    await sql.query(WAVES_PRUNE_SQL, [e.id, keep]);
    // волна с sold = 0, но с историей заказов не удаляется (FK) — прячем её с сайта
    const hidden = rowsOf(await sql.query(WAVES_HIDE_SQL, [e.id, keep]));
    if (hidden.length) warnings.push(`Волна ${hidden.map((h) => h.wave_no).join(', ')} скрыта, а не удалена: на неё ссылаются старые брони`);
  }
  return { waves: saved, warnings };
}

// Можно ли ставить в продажу: дата впереди и есть публичная волна с местами
export async function publishCheck(sql, id, nowMs = Date.now()) {
  const ev = rowsOf(await sql.query(
    `SELECT e.id, e.title, e.starts_at, e.ends_at, e.status,
            (SELECT count(*) FROM price_waves w WHERE w.event_id = e.id AND w.public AND w.sold < w.quota)::int AS open_waves
     FROM events e WHERE e.id = $1`, [id]
  ))[0];
  if (!ev) return { ok: false, message: 'Мероприятие не найдено' };
  const end = ev.ends_at ? new Date(ev.ends_at).getTime() : new Date(ev.starts_at).getTime() + 8 * 3600_000;
  if (end <= nowMs) return { ok: false, message: 'Дата уже прошла — поправь её в панели' };
  if (!Number(ev.open_waves)) return { ok: false, message: 'Нет цен — добавь волну в панели' };
  return { ok: true, event: ev };
}

// Удалить можно только мероприятие без единой брони (черновик, ошибка разбора).
// onlyDraft — для кнопки в боте: карточка черновика живёт в чате и после
// публикации, и случайный тап не должен снимать ночь с сайта
export async function deleteEvent(sql, id, { onlyDraft = false } = {}) {
  if (onlyDraft) {
    const ev = rowsOf(await sql.query(`SELECT status FROM events WHERE id = $1`, [id]))[0];
    if (!ev) return { ok: false, message: 'Мероприятие не найдено' };
    if (ev.status !== 'draft') return { ok: false, message: 'Ночь уже опубликована — снять её можно только в панели' };
  }
  const has = rowsOf(await sql.query(`SELECT 1 FROM orders WHERE event_id = $1 LIMIT 1`, [id])).length > 0;
  if (has) return { ok: false, message: 'По мероприятию есть брони — удалить нельзя, переведи в «прошло»' };
  await sql.query(`DELETE FROM broadcasts WHERE event_id = $1`, [id]).catch(() => {});
  await sql.query(`DELETE FROM price_waves WHERE event_id = $1`, [id]);
  const rows = rowsOf(await sql.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]));
  return rows.length ? { ok: true } : { ok: false, message: 'Мероприятие не найдено' };
}
