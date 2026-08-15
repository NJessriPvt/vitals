'use strict';
/**
 * One-shot migration: the old node:sqlite store -> the fleet's MySQL.
 *
 * Points are NOT copied column-for-column. They are re-derived from `raw` through
 * the current normalizer, so the migration doubles as a renormalize and the target
 * gets values computed by today's extractors rather than whatever was correct when
 * each row was first written. That matters here: several value field names were
 * wrong on first contact with the live API, and `raw` is the reason that was fixable.
 *
 * Tokens come across too. Losing the refresh token would mean re-running the whole
 * Google consent flow for no reason.
 *
 *   node scripts/migrate-sqlite.js [path/to/vitals.db]
 */

const path = require('path');
const fs = require('fs');

// .env first — db.js reads MYSQL_* at connect time.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

const { DatabaseSync } = require('node:sqlite');
const db = require('../lib/db');
const catalog = require('../lib/catalog');
const normalize = require('../lib/normalize');

const SRC = process.argv[2] || path.join(__dirname, '..', 'state', 'vitals.db');

async function main() {
  if (!fs.existsSync(SRC)) {
    process.stderr.write(`no sqlite store at ${SRC} — nothing to migrate\n`);
    process.exit(0);
  }
  const src = new DatabaseSync(SRC, { readOnly: true });
  await db.open();

  // --- points, re-derived from raw ----------------------------------------
  const types = src.prepare('SELECT DISTINCT data_type FROM points').all().map((r) => r.data_type);
  let total = 0;
  const allNotes = new Set();

  for (const typeId of types) {
    const type = catalog.get(typeId);
    if (!type) {
      process.stdout.write(`  skip ${typeId} (no longer in the catalog)\n`);
      continue;
    }
    const rows = src.prepare('SELECT raw FROM points WHERE data_type = ?').all(typeId);
    // Rollup types (total-calories, floors) have a different point shape entirely:
    // no interval, no dataSource, civil start/end instead. The list-shaped path finds
    // no timestamp in them and drops every row without failing.
    const derive = type.listMethod === 'dailyRollUp'
      ? normalize.normalizeRollupPoint : normalize.normalizePoint;
    let batch = [];
    let written = 0;
    for (const r of rows) {
      const notes = new Set();
      const row = derive(JSON.parse(r.raw), type, notes);
      for (const n of notes) allNotes.add(n);
      if (!row) continue;
      batch.push(row);
      if (batch.length >= 400) { await db.putPoints(batch); written += batch.length; batch = []; }
    }
    if (batch.length) { await db.putPoints(batch); written += batch.length; }
    total += written;
    process.stdout.write(`  ${typeId.padEnd(32)} ${String(written).padStart(7)}\n`);
  }

  // --- cursors, so the backfill does not start over ------------------------
  for (const c of src.prepare('SELECT * FROM cursors').all()) {
    await db.setCursor(c.data_type, {
      from_ms: c.from_ms, to_ms: c.to_ms,
      backfill_done: c.backfill_done, last_sync_ms: c.last_sync_ms, last_error: null,
    });
  }

  // --- tokens: the refresh token is the expensive thing to lose ------------
  const t = src.prepare('SELECT * FROM tokens WHERE id = 1').get();
  if (t) {
    await db.putTokens({
      access_token: t.access_token, refresh_token: t.refresh_token,
      expiry_ms: t.expiry_ms, scope: t.scope,
      health_user_id: t.health_user_id, legacy_user_id: t.legacy_user_id,
      connected_ms: t.connected_ms,
    });
    process.stdout.write(`  tokens migrated (refresh token ${t.refresh_token ? 'present' : 'MISSING'})\n`);
  }

  for (const s of src.prepare('SELECT * FROM settings').all()) {
    await db.setSetting(s.key, s.value);
  }

  src.close();
  process.stdout.write(`\nmigrated ${total} points across ${types.length} types\n`);
  if (allNotes.size) {
    process.stdout.write('normalizer notes:\n');
    for (const n of allNotes) process.stdout.write(`  - ${n}\n`);
  }
  await db.close();
}

main().catch((err) => {
  process.stderr.write(`migration failed: ${err.message}\n`);
  process.exit(1);
});
