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

// Событие: создать или обновить. Один стейтмент на два сценария — сид афиши
// (/api/seed) и правка из админки (/api/event-upsert).
// COALESCE на poster_url/descr/lineup: форма админки этих полей не знает,
// присланный null означает «не менять», а не «стереть».
// Параметры: $1 id, $2 brand, $3 title, $4 city, $5 venue, $6 address,
// $7 starts_at, $8 ends_at, $9 age_rating, $10 status, $11 poster_url,
// $12 descr, $13 lineup json (null → сохранить прежний)
export const EVENT_UPSERT_SQL = `
INSERT INTO events (id, brand, title, city, venue, address, starts_at, ends_at,
                    age_rating, status, poster_url, descr, lineup)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::jsonb,'[]'::jsonb))
ON CONFLICT (id) DO UPDATE SET
  brand=EXCLUDED.brand, title=EXCLUDED.title, city=EXCLUDED.city,
  venue=EXCLUDED.venue, address=EXCLUDED.address, starts_at=EXCLUDED.starts_at,
  ends_at=EXCLUDED.ends_at, age_rating=EXCLUDED.age_rating, status=EXCLUDED.status,
  poster_url=COALESCE(EXCLUDED.poster_url, events.poster_url),
  descr=COALESCE(EXCLUDED.descr, events.descr),
  lineup=COALESCE($13::jsonb, events.lineup)
RETURNING id`;

// Волна: создать или обновить. Квоту нельзя опустить ниже уже проданного —
// CHECK (sold <= quota) иначе роняет весь запрос 500-кой, поэтому квота
// поднимается до sold и вызывающий код сообщает об этом владельцу.
// Параметры: $1 event_id, $2 wave_no, $3 name, $4 price_rub, $5 quota
export const WAVE_UPSERT_SQL = `
INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (event_id, wave_no) DO UPDATE SET
  name=EXCLUDED.name, price_rub=EXCLUDED.price_rub,
  quota=GREATEST(EXCLUDED.quota, price_waves.sold)
RETURNING wave_no, quota, sold`;

// Снос волн, которых больше нет в форме. Проданные не трогаем: на них
// ссылаются заказы (FK orders.wave_id), да и гости уже купили.
// Параметры: $1 event_id, $2 оставляемые wave_no[]
export const WAVES_PRUNE_SQL = `
DELETE FROM price_waves
WHERE event_id = $1 AND sold = 0 AND NOT (wave_no = ANY($2::int[]))
RETURNING wave_no`;

// Афиша для админки: все события, включая черновики (на сайте их не видно).
export const ADMIN_EVENTS_SQL = `
SELECT e.id, e.title, e.city, e.venue, e.address, e.starts_at, e.ends_at,
       e.age_rating, e.status, e.descr,
       COALESCE(json_agg(json_build_object(
         'waveNo', w.wave_no, 'name', w.name, 'priceRub', w.price_rub,
         'quota', w.quota, 'sold', w.sold
       ) ORDER BY w.wave_no) FILTER (WHERE w.id IS NOT NULL), '[]'::json) AS waves
FROM events e LEFT JOIN price_waves w ON w.event_id = e.id
GROUP BY e.id
ORDER BY e.starts_at DESC`;
