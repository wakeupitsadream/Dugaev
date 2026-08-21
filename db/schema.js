// DDL — источник истины по схеме БД (Neon Postgres).
// Применяется идемпотентно через POST /api/seed (ADMIN_KEY).
// Инварианты, на которых держится система:
//  - price_waves.sold списывается атомарным UPDATE ... WHERE sold+qty<=quota;
//  - tickets.checked_in_at ставится ровно один раз атомарным UPDATE;
//  - цена всегда берётся из БД, никогда из тела запроса клиента.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id          text PRIMARY KEY,
    brand       text NOT NULL DEFAULT 'traphouse',
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
];
