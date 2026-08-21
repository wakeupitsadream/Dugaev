// Ключевые SQL-стейтменты. Вынесены отдельно, чтобы тесты (test/sql.test.mjs,
// настоящий Postgres через PGlite) проверяли ровно тот SQL, который выполняет
// продакшен.

// Покупка: одним атомарным стейтментом — списание квоты волны → заказ →
// N именных билетов. Волна распродана (или ивент не в продаже) → w пуст,
// каскад не создаёт ничего. Цена берётся только из БД.
// Параметры: $1 qty, $2 event_id, $3 wave_no, $4 order_id, $5 buyer_name,
// $6 phone, $7 tg, $8 utm json, $9 ticket_ids[], $10 names[], $11 age_cats[],
// $12 provider ('stub' — онлайн, 'door' — касса на входе)
export const ORDER_SQL = `
WITH w AS (
  UPDATE price_waves SET sold = sold + $1
  WHERE event_id = $2 AND wave_no = $3 AND sold + $1 <= quota
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.id = $2 AND e.status = 'onsale' AND e.starts_at > now()
    )
  RETURNING id, price_rub
),
o AS (
  INSERT INTO orders (id, event_id, wave_id, qty, amount_rub, buyer_name,
                      buyer_phone, buyer_tg, status, provider, consent, utm, paid_at)
  SELECT $4, $2, w.id, $1, w.price_rub * $1, $5, $6, $7, 'paid', $12, true, $8::jsonb, now()
  FROM w
  RETURNING id
),
t AS (
  INSERT INTO tickets (id, order_id, event_id, holder_name, age_cat)
  SELECT u.tid, o.id, $2, u.nm, u.ag
  FROM o, unnest($9::text[], $10::text[], $11::text[]) AS u(tid, nm, ag)
  RETURNING id
)
SELECT (SELECT price_rub FROM w) AS price_rub,
       (SELECT count(*) FROM t)::int AS created`;

// Чек-ин ровно один раз: строка меняется, только пока checked_in_at IS NULL.
// Параметры: $1 ticket_id, $2 время (null → now()), $3 кто впустил
export const CHECKIN_SQL = `
UPDATE tickets SET checked_in_at = COALESCE($2::timestamptz, now()), checked_by = $3
WHERE id = $1 AND status = 'active' AND checked_in_at IS NULL
RETURNING holder_name, age_cat, checked_in_at`;

// Следующая доступная волна (после 409 wave_sold_out)
export const NEXT_WAVE_SQL = `
SELECT wave_no, name, price_rub, quota - sold AS left
FROM price_waves WHERE event_id = $1 AND sold < quota
ORDER BY wave_no LIMIT 1`;
