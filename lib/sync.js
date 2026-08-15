'use strict';
/**
 * The sync engine — keeps the local store close to Google.
 *
 * It runs TWO cursors per data type, in opposite directions, and the distinction is
 * the whole design:
 *
 *   TAIL      forward, frequent, small. Re-reads a trailing overlap window every few
 *             minutes. The overlap is not paranoia: Google restates data (a watch
 *             that syncs at 22:00 rewrites the whole day, and sleep is revised the
 *             next morning), so a cursor that only ever asks for "since last time"
 *             permanently keeps the first, wrong version.
 *
 *   BACKFILL  backward, one chunk at a time, newest-first. Runs only in the gaps
 *             between tails so history never starves live data, and stops at
 *             VITALS_BACKFILL_DAYS.
 *
 * Both are idempotent because points upsert on (data_type, point_id). Re-running a
 * window costs quota, never correctness.
 */

const { EventEmitter } = require('events');
const os = require('os');
const catalog = require('./catalog');
const db = require('./db');
const health = require('./health');
const normalize = require('./normalize');

const TAIL_OVERLAP_MS = Number(process.env.VITALS_TAIL_OVERLAP_HOURS || 36) * 3600000;
const TAIL_INTERVAL_MS = Number(process.env.VITALS_TAIL_INTERVAL_SEC || 300) * 1000;
const BACKFILL_DAYS = Number(process.env.VITALS_BACKFILL_DAYS || 365);
const IDLE_TICK_MS = 5000;
// How long a claimed lease stays held if the holder dies mid-pass. Long enough for a
// full tail over every type; short enough that a crashed replica doesn't wedge sync.
const LEASE_TTL_MS = Number(process.env.VITALS_LEASE_TTL_SEC || 600) * 1000;
// Backfill is one chunk at a time, so it can run often — but still only on one replica.
const BACKFILL_MIN_GAP_MS = 8000;

/**
 * Who this replica is, for the lease. Host + pid, so the audit trail in `leases`
 * says which container is doing the work rather than just "someone".
 */
const OWNER = `${os.hostname()}:${process.pid}`;

const bus = new EventEmitter();
// Many SSE clients can attach; the default cap of 10 makes an open dashboard in a
// few tabs print a spurious leak warning.
bus.setMaxListeners(50);

const state = {
  running: false,
  phase: 'idle',
  current: null,
  startedMs: null,
  lastTailMs: null,
  lastError: null,
  // Types that answered 403 this process: the scope was not granted, so retrying
  // every 5 minutes just burns quota to be told the same thing.
  denied: new Set(),
};

function emit(kind, payload) {
  bus.emit('event', { kind, ts: Date.now(), ...payload });
}

function log(kind, dataType, message, count) {
  // Fire-and-forget: an event row is a status strip, not a correctness record, and
  // awaiting it at ~30 call sites would thread async through the whole engine for
  // something that must never be able to fail a sync.
  db.addEvent(kind, dataType, message, count).catch(() => {});
  emit(kind, { dataType, message, count });
}

async function enabledTypes() {
  const raw = await db.getSetting('enabled_types', '');
  if (!raw) return catalog.all().map((t) => t.id);
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) && ids.length ? ids.filter((id) => catalog.get(id)) : [];
  } catch {
    return catalog.all().map((t) => t.id);
  }
}

async function setEnabledTypes(ids) {
  await db.setSetting('enabled_types', JSON.stringify(ids.filter((id) => catalog.get(id))));
}

/**
 * Fetch one window of one type and store it. Returns {points, fresh}.
 * Chunking to the type's max window happens here so no caller has to remember it.
 */
async function syncWindow(getToken, typeId, fromMs, toMs) {
  const type = catalog.get(typeId);
  let points = 0;
  let fresh = 0;

  for (const [start, end] of health.chunks(type, fromMs, toMs)) {
    state.current = { type: typeId, from: start, to: end };
    // Some types refuse `list` and are only readable as daily rollups; fetchWindow
    // picks the method and says which shape came back.
    const { rollup, points: raw } = await health.fetchWindow(getToken, typeId, start, end);
    if (!raw.length) continue;

    const { rows, notes } = rollup
      ? normalize.normalizeRollupBatch(raw, type)
      : normalize.normalizeBatch(raw, type);
    // Surface shape surprises once per window rather than per point.
    for (const n of notes) log('warn', typeId, n);
    const res = await db.putPoints(rows);
    points += res.written;
    fresh += res.fresh;
  }

  state.current = null;
  return { points, fresh };
}

/** Forward sync for one type: the trailing overlap window through now. */
async function tailType(getToken, typeId) {
  const type = catalog.get(typeId);
  const cur = await db.getCursor(typeId);
  const now = Date.now();
  // A type that has never synced starts one max-window back, so the first render is
  // populated immediately; the backfill then walks further back behind it.
  const from = cur && cur.to_ms
    ? Math.max(cur.to_ms - TAIL_OVERLAP_MS, now - (type.maxDays * 86400000))
    : now - (type.maxDays * 86400000);

  const { points, fresh } = await syncWindow(getToken, typeId, from, now);
  await db.setCursor(typeId, {
    to_ms: now,
    from_ms: cur && cur.from_ms ? Math.min(cur.from_ms, from) : from,
    last_sync_ms: now,
    last_error: null,
  });
  if (fresh) log('sync', typeId, `${fresh} new`, fresh);
  return { points, fresh };
}

/** One backward chunk for the type that is furthest from its backfill target. */
async function backfillStep(getToken) {
  const target = Date.now() - (BACKFILL_DAYS * 86400000);
  const ids = (await enabledTypes()).filter((id) => !state.denied.has(id));
  const candidates = [];
  for (const id of ids) {
    const cur = await db.getCursor(id);
    if (cur && cur.from_ms && !cur.backfill_done && cur.from_ms > target) candidates.push({ id, cur });
  }

  if (!candidates.length) return false;
  // Oldest gap first — whichever type has the least history gets the next chunk.
  candidates.sort((a, b) => b.cur.from_ms - a.cur.from_ms);
  const { id, cur } = candidates[0];
  const type = catalog.get(id);

  const end = cur.from_ms;
  const start = Math.max(target, end - (type.maxDays * 86400000));
  state.phase = 'backfill';

  try {
    const { fresh } = await syncWindow(getToken, id, start, end);
    const done = start <= target;
    await db.setCursor(id, { from_ms: start, backfill_done: done ? 1 : 0, last_error: null });
    if (fresh) log('backfill', id, `${fresh} historic points`, fresh);
    if (done) log('backfill', id, 'history complete');
  } catch (err) {
    handleTypeError(id, err);
    // Don't re-attempt the same failing window on the next tick.
    await db.setCursor(id, { from_ms: start, last_error: err.message });
  }
  return true;
}

function handleTypeError(typeId, err) {
  if (err.status === 403) {
    state.denied.add(typeId);
    log('error', typeId, 'access denied (403) — scope not granted for this type');
  } else if (err.status === 400) {
    log('error', typeId, `rejected (400): ${err.message}`);
  } else if (err.code === 'not_connected') {
    throw err;
  } else {
    log('error', typeId, err.message);
  }
}

/** One full pass over every enabled type. */
async function tailAll(getToken) {
  state.phase = 'tail';
  const ids = (await enabledTypes()).filter((id) => !state.denied.has(id));
  let fresh = 0;
  for (const id of ids) {
    try {
      const r = await tailType(getToken, id);
      fresh += r.fresh;
    } catch (err) {
      if (err.code === 'not_connected') throw err;
      handleTypeError(id, err);
      await db.setCursor(id, { last_error: err.message, last_sync_ms: Date.now() });
    }
    emit('progress', { phase: 'tail', dataType: id });
  }
  state.lastTailMs = Date.now();
  state.phase = 'idle';
  return fresh;
}

/**
 * Sync one type right now over a specific window — what a webhook calls. Real-time
 * delivery tells us WHAT changed and WHEN, but carries no values, so the payload is
 * a targeted fetch instruction, not data.
 */
async function syncRange(getToken, typeId, fromMs, toMs) {
  if (!catalog.get(typeId)) return { points: 0, fresh: 0 };
  try {
    const r = await syncWindow(getToken, typeId, fromMs, toMs);
    if (r.fresh) log('realtime', typeId, `${r.fresh} pushed`, r.fresh);
    else emit('progress', { phase: 'realtime', dataType: typeId });
    return r;
  } catch (err) {
    handleTypeError(typeId, err);
    return { points: 0, fresh: 0 };
  }
}

let loopTimer = null;
let loopRunning = false;

function start(getToken) {
  if (loopTimer) return;
  state.running = true;
  state.startedMs = Date.now();

  const tick = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      // Every replica runs this loop; the LEASE decides which one actually works.
      // The claim is conditional on completion time, not just on the lock being free
      // — otherwise two replicas simply take turns and the upstream sees double the
      // traffic, which is the exact failure the lock was meant to prevent.
      if (await db.acquireLease('tail', OWNER, LEASE_TTL_MS, TAIL_INTERVAL_MS)) {
        try { await tailAll(getToken); } finally { await db.releaseLease('tail', OWNER, true); }
      } else if (await db.acquireLease('backfill', OWNER, LEASE_TTL_MS, BACKFILL_MIN_GAP_MS)) {
        try { await backfillStep(getToken); } finally { await db.releaseLease('backfill', OWNER, true); }
      }
      state.lastError = null;
    } catch (err) {
      state.lastError = err.message;
      if (err.code !== 'not_connected') log('error', null, err.message);
      // Not connected is a normal resting state, not an error worth logging on loop.
    } finally {
      loopRunning = false;
      state.phase = 'idle';
      // Clear the in-flight marker even when the pass threw, or the status endpoint
      // keeps reporting a chunk that stopped being fetched minutes ago.
      state.current = null;
    }
  };

  loopTimer = setInterval(tick, IDLE_TICK_MS);
  if (loopTimer.unref) loopTimer.unref();
  setTimeout(tick, 1000);
}

function stop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  state.running = false;
}

/** Force a full re-read of the last window for every type — the "Sync now" button. */
/**
 * Manual sync — the "Sync now" button and the assistant's refresh tool.
 *
 * Deliberately passes minIntervalMs = 0: the whole point of asking for a sync by hand
 * is to override the 5-minute cadence. The lease is still taken, so a manual sync and
 * the scheduled one can never run against Google at the same time, and a second
 * manual request while one is in flight is told to wait rather than doubling up.
 */
async function syncNow(getToken, typeId = null) {
  const got = await db.acquireLease('tail', OWNER, LEASE_TTL_MS, 0);
  if (!got) {
    const e = new Error('a sync is already running');
    e.status = 409;
    throw e;
  }
  try {
    const ids = typeId ? [typeId] : await enabledTypes();
    state.denied.clear();
    let fresh = 0;
    for (const id of ids) {
      try {
        const r = await tailType(getToken, id);
        fresh += r.fresh;
      } catch (err) {
        if (err.code === 'not_connected') throw err;
        handleTypeError(id, err);
      }
    }
    state.lastTailMs = Date.now();
    return fresh;
  } finally {
    await db.releaseLease('tail', OWNER, true);
  }
}

async function status() {
  const [cursors, tailLease] = await Promise.all([db.allCursors(), db.leaseState('tail')]);
  return {
    running: state.running,
    owner: OWNER,
    lease: tailLease,
    phase: state.phase,
    current: state.current,
    lastTailMs: state.lastTailMs,
    lastError: state.lastError,
    denied: [...state.denied],
    tailIntervalMs: TAIL_INTERVAL_MS,
    backfillDays: BACKFILL_DAYS,
    cursors,
  };
}

module.exports = {
  bus, start, stop, syncNow, syncRange, tailAll, backfillStep,
  status, enabledTypes, setEnabledTypes, state,
};
