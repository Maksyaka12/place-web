// Applies pending Place database migrations to DATABASE_URL (from frontend/.env).
//   npm run db:migrate
import { readFileSync, existsSync } from 'node:fs';
import { getDb, migrate } from '../api/_lib/place/db.js';

if (existsSync('.env') && !process.env.DATABASE_URL) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim();
}

const db = await getDb();
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
  const tables = await db.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
  );
  console.log(`tables: ${tables.map((t) => t.table_name).join(', ')}`);
} finally {
  await db.end();
}
