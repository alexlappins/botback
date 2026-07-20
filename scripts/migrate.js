#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * SQL migration runner: `npm run migrate`.
 *
 * Applies every migrations/*.sql exactly once, in filename order, recording
 * applied files in the `applied_migrations` table. Connection settings come
 * from .env (same POSTGRES_* vars the app uses).
 *
 * First run on a database where some migrations were already applied by hand:
 *   npm run migrate -- --baseline   # mark ALL current files as applied, run nothing
 * then apply new ones as usual with `npm run migrate`.
 */
const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { Client } = require('pg');

// Minimal .env loader — no dotenv dependency needed.
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env — rely on real env vars */
  }
}

async function main() {
  const root = join(__dirname, '..');
  loadEnv(join(root, '.env'));

  const client = new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB ?? 'postgres',
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = readdirSync(join(root, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const appliedRows = await client.query('SELECT filename FROM applied_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  const baseline = process.argv.includes('--baseline');
  if (baseline) {
    for (const f of files) {
      if (!applied.has(f)) {
        await client.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [f]);
        console.log(`baseline: marked ${f} as applied (not executed)`);
      }
    }
    await client.end();
    console.log('Baseline done.');
    return;
  }

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(root, 'migrations', f), 'utf8');
    console.log(`applying ${f} …`);
    try {
      // Files may contain their own BEGIN/COMMIT — run as a single batch.
      await client.query(sql);
      await client.query('INSERT INTO applied_migrations (filename) VALUES ($1)', [f]);
      ran += 1;
      console.log(`  ✓ ${f}`);
    } catch (e) {
      console.error(`  ✗ ${f} FAILED: ${e.message}`);
      console.error(
        '  Nothing after this file was run. If this migration was already applied by hand,\n' +
          `  mark it manually: INSERT INTO applied_migrations (filename) VALUES ('${f}');`,
      );
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(ran === 0 ? 'Nothing to apply — database is up to date.' : `Done: ${ran} migration(s) applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
