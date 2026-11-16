// Database access for Place: Neon Postgres in production (env DATABASE_URL), PGlite in tests.
// Both adapters expose the same small interface:
//   query(text, params) → rows        one statement
//   tx(async (q) => …)                 a transaction; q(text, params) → rows
//   exec(sql)                          several statements, no params (migrations)
//   end()
import { MIGRATIONS } from './migrations.js';

let shared = null;
let localDb = null;

/** The shared Neon pool for serverless functions (one per warm instance). */
export async function getDb() {
  if (shared) return shared;
  const url = process.env.DATABASE_URL;
  // Local development without Neon: PLACE_PGLITE_DIR=.launch-live keeps a PGlite database in that folder
  // (the one scripts/launchLive.mjs fills), migrated on first use. Never set on Vercel.
  if (!url && process.env.PLACE_PGLITE_DIR) {
    localDb ||= (async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const db = pgliteAdapter(new PGlite(process.env.PLACE_PGLITE_DIR));
      await migrate(db);
      return db;
    })();
    shared = await localDb;
    return shared;
  }
  if (!url) throw new Error('DATABASE_URL is not set');
  const { Pool } = await import('@neondatabase/serverless');
  shared = poolAdapter(new Pool({ connectionString: url, max: 3 }));
  return shared;
}

export function poolAdapter(pool) {
  const run = (client) => async (text, params = []) => (await client.query(text, params)).rows;
  return {
    query: run(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(run(client));
        await client.query('commit');
        return result;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    end: () => pool.end(),
  };
}

export function pgliteAdapter(db) {
  const run = (c) => async (text, params = []) => (await c.query(text, params)).rows;
  return {
    query: run(db),
    tx: (fn) => db.transaction((t) => fn(run(t))),
    exec: async (sql) => {
      await db.exec(sql);
    },
    end: () => db.close(),
  };
}

/** Applies every migration not applied yet, each in its own transaction. Returns the names applied. */
export async function migrate(db) {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await db.query('select name from schema_migrations')).map((r) => r.name));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.tx(async (q) => {
      for (const statement of splitStatements(m.sql)) await q(statement);
      await q('insert into schema_migrations (name) values ($1)', [m.name]);
    });
    applied.push(m.name);
  }
  return applied;
}

// Migrations are plain DDL without functions or quoted semicolons, so splitting on ";" is safe.
function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}
