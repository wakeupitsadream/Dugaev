// Подключение к Neon Postgres (HTTP-драйвер). Все нетривиальные операции —
// одним SQL-стейтментом (CTE): одиночный стейтмент атомарен, интерактивные
// транзакции HTTP-драйверу не нужны.
import { neon } from '@neondatabase/serverless';

let cached = null;

export function hasDb() {
  return Boolean(process.env.DATABASE_URL) || process.env.DEV_PGLITE === '1';
}

export function db() {
  if (!cached) {
    cached = process.env.DEV_PGLITE === '1' ? pgliteAdapter() : neon(process.env.DATABASE_URL);
  }
  return cached;
}

// Локальная разработка/тесты без Neon: настоящий Postgres в WASM
// (devDependency @electric-sql/pglite, in-memory). На Vercel не включается.
function pgliteAdapter() {
  let ready = null;
  const init = async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    return new PGlite();
  };
  return {
    async query(text, params) {
      ready = ready || init();
      const pg = await ready;
      const r = await pg.query(text, params);
      return r.rows;
    },
  };
}

// Таймаут на случай «Neon лёг/просыпается»: verify должен успеть
// деградировать в янтарный режим, а не висеть.
export function withTimeout(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), ms)),
  ]);
}
