// Ключевые SQL-стейтменты. Вынесены отдельно, чтобы тесты (test/sql.test.mjs,
// настоящий Postgres через PGlite) проверяли ровно тот SQL, который выполняет
// продакшен.

// Покупка: одним атомарным стейтментом — списание квоты волны → заказ →
// N именных билетов. Волна распродана (или ивент не в продаже) → w пуст,
// каскад не создаёт ничего. Цена берётся только из БД.
//
// Режим по провайдеру ($12):
//  'transfer' — бронь с оплатой переводом: заказ 'pending' с pay_code и
//               сроком ($13 минут), билеты 'reserved' (QR не проходит вход,
//               пока владелец не подтвердит оплату, см. CONFIRM_SQL);
//  'door' / 'stub' — касса на входе и демо: сразу 'paid' / 'active'.
// Параметры: $1 qty, $2 event_id, $3 wave_no, $4 order_id, $5 buyer_name,
// $6 phone, $7 tg, $8 utm json, $9 ticket_ids[], $10 names[], $11 age_cats[],
// $12 provider, $13 hold_minutes (int, для transfer), $14 pay_code (text|null),
// $15 allow_hidden (bool: касса может продавать скрытые волны, сайт — нет)
export const ORDER_SQL = `
WITH w AS (
  UPDATE price_waves SET sold = sold + $1
  WHERE event_id = $2 AND wave_no = $3 AND sold + $1 <= quota
    AND ($15::bool OR public)
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.id = $2 AND e.status = 'onsale'
        AND COALESCE(e.ends_at, e.starts_at + interval '8 hours') > now()
    )
  RETURNING id, price_rub
),
o AS (
  INSERT INTO orders (id, event_id, wave_id, qty, amount_rub, buyer_name,
                      buyer_phone, buyer_tg, status, provider, consent, utm,
                      paid_at, expires_at, pay_code)
  SELECT $4, $2, w.id, $1, w.price_rub * $1, $5, $6, $7,
         CASE WHEN $12 = 'transfer' THEN 'pending' ELSE 'paid' END,
         $12, true, $8::jsonb,
         CASE WHEN $12 = 'transfer' THEN NULL ELSE now() END,
         CASE WHEN $12 = 'transfer' THEN now() + ($13::int * interval '1 minute') ELSE NULL END,
         CASE WHEN $12 = 'transfer' THEN $14::text ELSE NULL END
  FROM w
  RETURNING id, expires_at, pay_code
),
t AS (
  INSERT INTO tickets (id, order_id, event_id, holder_name, age_cat, status)
  SELECT u.tid, o.id, $2, u.nm, u.ag,
         CASE WHEN $12 = 'transfer' THEN 'reserved' ELSE 'active' END
  FROM o, unnest($9::text[], $10::text[], $11::text[]) AS u(tid, nm, ag)
  RETURNING id
)
SELECT (SELECT price_rub FROM w) AS price_rub,
       (SELECT count(*) FROM t)::int AS created,
       (SELECT expires_at FROM o) AS expires_at,
       (SELECT pay_code FROM o) AS pay_code`;

// Сгорание брони: неподтверждённые заказы, у которых вышел срок, становятся
// 'expired', их билеты — тоже, квота возвращается в волну. Заказ, где гость
// нажал «Я перевёл» (claimed_at), не сгорает: решает владелец, а не таймер.
// Вызывается лениво перед созданием заказа и при показе списка ожидающих —
// отдельного планировщика не нужно.
export const EXPIRE_SQL = `
WITH exp AS (
  UPDATE orders SET status = 'expired'
  WHERE status = 'pending' AND claimed_at IS NULL
    AND expires_at IS NOT NULL AND expires_at < now()
  RETURNING id, wave_id, qty
),
t AS (
  UPDATE tickets SET status = 'expired'
  WHERE order_id IN (SELECT id FROM exp) AND status = 'reserved'
),
dec AS (
  UPDATE price_waves w SET sold = GREATEST(0, w.sold - d.total)
  FROM (SELECT wave_id, sum(qty)::int AS total FROM exp GROUP BY wave_id) d
  WHERE w.id = d.wave_id
)
SELECT id FROM exp`;

// Подтверждение оплаты владельцем (или приём денег на входе): заказ 'paid',
// билеты 'active'. Возвращает заказ и его билеты — для ответа и для бота.
// Сгоревшая бронь ('expired') тоже подтверждается — гость перевёл, но не
// нажал «Я перевёл», а срок вышел: места забираются обратно в волну тем же
// стейтментом (w), и только если они ещё есть; иначе строк нет и вызывающий
// код объясняет, что делать. Колонка was — 'pending' | 'expired'.
// Параметры: $1 order_id, $2 кто подтвердил, $3 provider ('transfer' — перевод,
// 'door' — наличные на входе; null — оставить как есть)
export const CONFIRM_SQL = `
WITH cand AS (
  SELECT id, wave_id, qty, status FROM orders WHERE id = $1 AND status IN ('pending', 'expired')
),
w AS (
  UPDATE price_waves p SET sold = p.sold + c.qty
  FROM cand c
  WHERE p.id = c.wave_id AND c.status = 'expired' AND p.sold + c.qty <= p.quota
  RETURNING p.id
),
o AS (
  UPDATE orders SET status = 'paid', paid_at = now(), confirmed_by = $2,
                    provider = COALESCE($3::text, orders.provider)
  FROM cand c
  WHERE orders.id = c.id AND (c.status = 'pending' OR EXISTS (SELECT 1 FROM w))
  RETURNING orders.id, orders.event_id, orders.qty, orders.amount_rub, orders.buyer_name,
            orders.buyer_phone, orders.buyer_tg, orders.tg_chat_id, orders.pay_code, c.status AS was
),
t AS (
  UPDATE tickets SET status = 'active'
  WHERE order_id IN (SELECT id FROM o) AND status IN ('reserved', 'expired')
  RETURNING id, holder_name
)
SELECT o.*, (SELECT json_agg(json_build_object('id', t.id, 'holder_name', t.holder_name)) FROM t) AS tickets
FROM o`;

// Отмена неоплаченной брони владельцем: квота возвращается сразу.
// Параметры: $1 order_id
export const CANCEL_SQL = `
WITH o AS (
  UPDATE orders SET status = 'cancelled'
  WHERE id = $1 AND status = 'pending'
  RETURNING id, wave_id, qty, tg_chat_id
),
t AS (
  UPDATE tickets SET status = 'cancelled'
  WHERE order_id IN (SELECT id FROM o) AND status = 'reserved'
),
dec AS (
  UPDATE price_waves w SET sold = GREATEST(0, w.sold - o.qty) FROM o WHERE w.id = o.wave_id
)
SELECT id, tg_chat_id FROM o`;

// Аннулирование одной проходки (возврат или отзыв): только оплаченной и пока
// по ней не прошли вход; место возвращается в волну. Неоплаченную бронь
// снимают целиком через CANCEL_SQL — иначе место вернулось бы дважды
// (здесь и при сгорании/отмене заказа). Параметры: $1 ticket_id,
// $2 новый статус ('revoked' | 'refunded'), $3 причина
export const VOID_SQL = `
WITH t AS (
  UPDATE tickets SET status = $2, note = $3
  WHERE id = $1 AND status = 'active' AND checked_in_at IS NULL
  RETURNING id, order_id, holder_name
),
dec AS (
  UPDATE price_waves w SET sold = GREATEST(0, w.sold - 1)
  FROM orders o, t WHERE o.id = t.order_id AND w.id = o.wave_id
)
SELECT id, holder_name FROM t`;

// Переоформление на другого человека: имя меняется, QR остаётся тем же.
// Параметры: $1 ticket_id, $2 новое имя
export const RENAME_SQL = `
UPDATE tickets SET holder_name = $2
WHERE id = $1 AND status IN ('active', 'reserved') AND checked_in_at IS NULL
RETURNING id, holder_name`;

// Ожидающие подтверждения брони — для админки и двери. Сначала те, где гость
// уже нажал «Я перевёл». Параметры: $1 event_id
export const PENDING_SQL = `
SELECT o.id, o.pay_code, o.buyer_name, o.buyer_phone, o.buyer_tg, o.qty, o.amount_rub,
       o.created_at, o.expires_at, o.claimed_at, (o.tg_chat_id IS NOT NULL) AS tg,
       (SELECT json_agg(json_build_object('id', t.id, 'holder_name', t.holder_name) ORDER BY t.id)
          FROM tickets t WHERE t.order_id = o.id) AS tickets
FROM orders o
WHERE o.event_id = $1 AND o.status = 'pending'
ORDER BY o.claimed_at DESC NULLS LAST, o.created_at DESC`;

// Продажи по источникам (метки ?src= со ссылок, промокодов, QR-постеров).
// Оплаченные и ожидающие считаются отдельно. Параметры: $1 event_id
export const SOURCES_SQL = `
SELECT coalesce(utm->>'src', 'site') AS src,
       coalesce(sum(qty) FILTER (WHERE status = 'paid'), 0)::int AS paid,
       coalesce(sum(qty) FILTER (WHERE status = 'pending'), 0)::int AS pending,
       coalesce(sum(amount_rub) FILTER (WHERE status = 'paid'), 0)::int AS rub
FROM orders
WHERE event_id = $1 AND status IN ('paid', 'pending')
GROUP BY 1
ORDER BY paid DESC, pending DESC, src`;

// Чек-ин ровно один раз: строка меняется, только пока checked_in_at IS NULL.
// Параметры: $1 ticket_id, $2 время (null → now()), $3 кто впустил
export const CHECKIN_SQL = `
UPDATE tickets SET checked_in_at = COALESCE($2::timestamptz, now()), checked_by = $3
WHERE id = $1 AND status = 'active' AND checked_in_at IS NULL
RETURNING holder_name, age_cat, checked_in_at`;

// Следующая доступная волна (после 409 wave_sold_out)
// Только публичные волны: скрытую (гостевой список, касса) гостю не предлагаем.
export const NEXT_WAVE_SQL = `
SELECT wave_no, name, price_rub, quota - sold AS left
FROM price_waves WHERE event_id = $1 AND sold < quota AND public
ORDER BY wave_no LIMIT 1`;

// Первая публичная волна, где хватит мест на всю компанию ($2 = qty), —
// для бота: цена меняется один раз, а не «по одной проходке по разным ценам».
export const NEXT_WAVE_FOR_SQL = `
SELECT wave_no, name, price_rub, quota - sold AS left
FROM price_waves WHERE event_id = $1 AND quota - sold >= $2 AND public
ORDER BY wave_no LIMIT 1`;

// Сколько мест осталось в публичных волнах: всего и максимум в одной волне
// (одна бронь = одна волна, поэтому «до max_one за раз»)
export const SEATS_LEFT_SQL = `
SELECT COALESCE(SUM(quota - sold), 0)::int AS total, COALESCE(MAX(quota - sold), 0)::int AS max_one
FROM price_waves WHERE event_id = $1 AND public`;

// Событие: создать или обновить. Один стейтмент на два сценария — сид афиши
// (/api/seed) и правка из админки (/api/event-upsert).
// null в poster_url/descr/lineup/program/capacity означает «не менять»
// (старые клиенты этих полей не знают), пустая строка в poster_url и 0 в
// capacity — «убрать».
// Параметры: $1 id, $2 brand, $3 title, $4 city, $5 venue, $6 address,
// $7 starts_at, $8 ends_at, $9 age_rating, $10 status, $11 poster_url,
// $12 descr, $13 lineup json, $14 secret (bool: SECRET PLACE — адрес
// публике только за сутки), $15 capacity (int), $16 program json
export const EVENT_UPSERT_SQL = `
INSERT INTO events (id, brand, title, city, venue, address, starts_at, ends_at,
                    age_rating, status, poster_url, descr, lineup, secret, capacity, program)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11::text,''),$12,COALESCE($13::jsonb,'[]'::jsonb),
        COALESCE($14::bool,false), NULLIF($15::int, 0), $16::jsonb)
ON CONFLICT (id) DO UPDATE SET
  brand=EXCLUDED.brand, title=EXCLUDED.title, city=EXCLUDED.city,
  venue=EXCLUDED.venue, address=EXCLUDED.address, starts_at=EXCLUDED.starts_at,
  ends_at=EXCLUDED.ends_at, age_rating=EXCLUDED.age_rating, status=EXCLUDED.status,
  poster_url=CASE WHEN $11::text IS NULL THEN events.poster_url ELSE NULLIF($11::text,'') END,
  descr=COALESCE(EXCLUDED.descr, events.descr),
  lineup=COALESCE($13::jsonb, events.lineup),
  secret=COALESCE($14::bool, events.secret),
  capacity=CASE WHEN $15::int IS NULL THEN events.capacity ELSE NULLIF($15::int, 0) END,
  program=COALESCE($16::jsonb, events.program)
RETURNING id`;

// Волна: создать или обновить. Квоту нельзя опустить ниже уже проданного —
// CHECK (sold <= quota) иначе роняет весь запрос 500-кой, поэтому квота
// поднимается до sold и вызывающий код сообщает об этом владельцу.
// Параметры: $1 event_id, $2 wave_no, $3 name, $4 price_rub, $5 quota,
// $6 public (bool: false — скрытая волна, гостевой список; на сайте её нет)
export const WAVE_UPSERT_SQL = `
INSERT INTO price_waves (event_id, wave_no, name, price_rub, quota, public)
VALUES ($1,$2,$3,$4,$5,COALESCE($6::bool,true))
ON CONFLICT (event_id, wave_no) DO UPDATE SET
  name=EXCLUDED.name, price_rub=EXCLUDED.price_rub,
  quota=GREATEST(EXCLUDED.quota, price_waves.sold),
  public=COALESCE($6::bool, price_waves.public)
RETURNING wave_no, quota, sold`;

// Снос волн, которых больше нет в форме. Проданные не трогаем: на них
// ссылаются заказы (FK orders.wave_id), да и гости уже купили. Волна с
// sold = 0, на которую ссылаются сгоревшие или отменённые заказы, тоже
// не удаляется (FK) — её прячет WAVES_HIDE_SQL.
// Параметры: $1 event_id, $2 оставляемые wave_no[]
export const WAVES_PRUNE_SQL = `
DELETE FROM price_waves
WHERE event_id = $1 AND sold = 0 AND NOT (wave_no = ANY($2::int[]))
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.wave_id = price_waves.id)
RETURNING wave_no`;

// Волны, которых нет в форме, но удалить нельзя (на них ссылаются заказы):
// снимаем с сайта, чтобы владелец не видел «удалённую» волну в продаже.
export const WAVES_HIDE_SQL = `
UPDATE price_waves SET public = false
WHERE event_id = $1 AND NOT (wave_no = ANY($2::int[])) AND public
RETURNING wave_no`;

// Афиша для админки: все события, включая черновики (на сайте их не видно).
export const ADMIN_EVENTS_SQL = `
SELECT e.id, e.title, e.city, e.venue, e.address, e.starts_at, e.ends_at,
       e.age_rating, e.status, e.descr, e.secret, e.capacity, e.poster_url, e.lineup, e.program,
       (SELECT count(*) FROM orders o WHERE o.event_id = e.id AND o.status = 'pending')::int AS pending,
       (SELECT coalesce(sum(o.amount_rub), 0) FROM orders o WHERE o.event_id = e.id AND o.status = 'paid')::int AS revenue,
       COALESCE(json_agg(json_build_object(
         'waveNo', w.wave_no, 'name', w.name, 'priceRub', w.price_rub,
         'quota', w.quota, 'sold', w.sold, 'public', w.public
       ) ORDER BY w.wave_no) FILTER (WHERE w.id IS NOT NULL), '[]'::json) AS waves
FROM events e LEFT JOIN price_waves w ON w.event_id = e.id
GROUP BY e.id
ORDER BY e.starts_at DESC`;
