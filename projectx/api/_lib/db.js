// Подключение к Neon Postgres (HTTP-драйвер). Все нетривиальные операции —
// одним SQL-стейтментом (CTE): одиночный стейтмент атомарен, интерактивные
// транзакции HTTP-драйверу не нужны.
import { createHash } from 'node:crypto';
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
    // имя модуля собираем из частей: трассировщик Vercel не тянет 26 МБ WASM
    // в бандл каждой функции ради dev-зависимости
    const { PGlite } = await import(['@electric-sql', 'pglite'].join('/'));
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
//
// Версия схемы — хеш самих стейтментов: релиз, поменявший схему, доводит её
// один раз, а дальше холодный старт функции читает одну строку и не гоняет
// ALTER TABLE (даже с IF NOT EXISTS он берёт эксклюзивную блокировку
// таблицы — в пик продаж после анонса заказы вставали бы в очередь).
export const SCHEMA_VERSION = createHash('sha1').update(SCHEMA.join('\n')).digest('hex').slice(0, 12);
const ensured = new WeakMap();
export function ensureSchema(sql) {
  if (!ensured.has(sql)) {
    ensured.set(sql, (async () => {
      try {
        const r = await sql.query(`SELECT v FROM px_meta WHERE k = 'schema'`);
        if (((r && r.rows) || r || [])[0]?.v === SCHEMA_VERSION) return;
      } catch { /* таблицы версий ещё нет — первая доводка */ }
      let failed = 0;
      for (const stmt of SCHEMA) {
        try {
          await sql.query(stmt);
        } catch (e) {
          failed++;
          console.warn('ensureSchema:', e.message);
        }
      }
      // версию пишем, только если всё прошло: иначе следующий старт повторит
      if (failed) return;
      try {
        await sql.query(`CREATE TABLE IF NOT EXISTS px_meta (k text PRIMARY KEY, v text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        await sql.query(
          `INSERT INTO px_meta (k, v) VALUES ('schema', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
          [SCHEMA_VERSION]
        );
      } catch (e) {
        console.warn('ensureSchema(версия):', e.message);
      }
    })());
  }
  return ensured.get(sql);
}

// Колонка или таблица ещё не доехала до базы — первые секунды после
// выкладки, а путь заказа миграции сам не гоняет (см. выше): доводим схему и
// повторяем запрос один раз. Иначе бронь с сайта падала бы, пока схему не
// доведёт бот, панель или планировщик
const MISSING_RE = /(?:column|relation) .{1,80} does not exist/i;
export async function healSchema(sql, run) {
  try {
    return await run();
  } catch (err) {
    if (!MISSING_RE.test(String(err?.message || ''))) throw err;
    console.warn('healSchema:', err.message);
    ensured.delete(sql);
    await ensureSchema(sql);
    return run();
  }
}
