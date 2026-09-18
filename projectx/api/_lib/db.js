// Подключение к Neon Postgres (HTTP-драйвер). Все нетривиальные операции —
// одним SQL-стейтментом (CTE): одиночный стейтмент атомарен, интерактивные
// транзакции HTTP-драйверу не нужны.
import { neon } from '@neondatabase/serverless';
import { SCHEMA } from '../../db/schema.js';

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

// Схема применяется кнопкой «Инициализировать БД», но таблицы, добавленные
// релизом после этого нажатия, до боевой базы не доезжают — и функция молча
// падает на «relation does not exist». Поэтому обработчик сам доводит схему
// один раз на инстанс: все стейтменты идемпотентны (IF NOT EXISTS).
const ensured = new WeakMap();
export function ensureSchema(sql) {
  if (!ensured.has(sql)) {
    ensured.set(sql, (async () => {
      for (const stmt of SCHEMA) {
        try {
          await sql.query(stmt);
        } catch (e) {
          console.warn('ensureSchema:', e.message);
        }
      }
    })());
  }
  return ensured.get(sql);
}
