// DDL — источник истины по схеме БД (Neon Postgres).
// Применяется идемпотентно через POST /api/seed (ADMIN_KEY).
// Инварианты, на которых держится система:
//  - price_waves.sold списывается атомарным UPDATE ... WHERE sold+qty<=quota;
//  - tickets.checked_in_at ставится ровно один раз атомарным UPDATE;
//  - цена всегда берётся из БД, никогда из тела запроса клиента;
//  - бронь переводом: orders 'pending' + tickets 'reserved' → подтверждение
//    владельцем делает их 'paid'/'active', сгорание возвращает квоту.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id          text PRIMARY KEY,
    brand       text NOT NULL DEFAULT 'projectx',
    title       text NOT NULL,
    city        text NOT NULL,
    venue       text NOT NULL,
    address     text,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz,
    age_rating  smallint NOT NULL DEFAULT 18,
    status      text NOT NULL DEFAULT 'onsale',
    capacity    integer,
    poster_url  text,
    descr       text,
    lineup      jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS price_waves (
    id        bigserial PRIMARY KEY,
    event_id  text NOT NULL REFERENCES events(id),
    wave_no   smallint NOT NULL,
    name      text NOT NULL,
    price_rub integer NOT NULL,
    quota     integer NOT NULL,
    sold      integer NOT NULL DEFAULT 0,
    UNIQUE (event_id, wave_no),
    CHECK (sold >= 0 AND sold <= quota)
  )`,

  `CREATE TABLE IF NOT EXISTS orders (
    id          text PRIMARY KEY,
    event_id    text NOT NULL REFERENCES events(id),
    wave_id     bigint NOT NULL REFERENCES price_waves(id),
    qty         smallint NOT NULL CHECK (qty BETWEEN 1 AND 10),
    amount_rub  integer NOT NULL,
    buyer_name  text NOT NULL,
    buyer_phone text NOT NULL,
    buyer_tg    text,
    status      text NOT NULL DEFAULT 'pending',
    provider    text NOT NULL DEFAULT 'stub',
    provider_id text,
    expires_at  timestamptz,
    utm         jsonb,
    consent     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    paid_at     timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS orders_event_idx ON orders (event_id, status)`,

  `CREATE TABLE IF NOT EXISTS tickets (
    id            text PRIMARY KEY,
    order_id      text NOT NULL REFERENCES orders(id),
    event_id      text NOT NULL REFERENCES events(id),
    holder_name   text NOT NULL,
    age_cat       text NOT NULL DEFAULT 'adult',
    status        text NOT NULL DEFAULT 'active',
    checked_in_at timestamptz,
    checked_by    text,
    created_at    timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS tickets_event_idx ON tickets (event_id)`,
  `CREATE INDEX IF NOT EXISTS tickets_order_idx ON tickets (order_id)`,

  `CREATE TABLE IF NOT EXISTS scan_log (
    id         bigserial PRIMARY KEY,
    ticket_id  text,
    result     text NOT NULL,
    scanned_by text,
    at         timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS tg_updates (
    update_id  bigint PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now()
  )`,

  // ---- v6: бронь с оплатой переводом (без платёжного шлюза) ----
  // Заказ живёт как 'pending' до подтверждения владельцем, его билеты —
  // 'reserved' (QR есть, но вход не пройдёт). Не подтверждён в срок —
  // 'expired', квота возвращается. Все ALTER идемпотентны: /api/seed можно
  // гонять сколько угодно.
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS secret boolean NOT NULL DEFAULT false`,
  `ALTER TABLE price_waves ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT true`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_code text`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS claimed_at timestamptz`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by text`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS tg_chat_id bigint`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS note text`,
  `CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders (status, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS orders_pay_code_idx ON orders (pay_code) WHERE pay_code IS NOT NULL`,

  // Связка «чат Telegram ↔ заказ»: бот присылает проходки и адрес тому,
  // кто открыл его по ссылке с экрана брони.
  `CREATE TABLE IF NOT EXISTS tg_links (
    chat_id    bigint NOT NULL,
    order_id   text NOT NULL REFERENCES orders(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, order_id)
  )`,
];
