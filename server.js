'use strict';
/**
 * vitals — your own health dashboard on top of the Google Health API.
 *
 * One dependency (mysql2) and vanilla JS: no framework, no build step, no bundler.
 *
 * SHAPE. Google is reached from exactly two modules — lib/oauth.js (tokens) and
 * lib/health.js (data) — and everything else works off the shared database. That
 * split is deliberate: the dashboard must stay fast and answerable when Google is
 * slow, rate-limiting, or the refresh token has expired. Charts never wait on an
 * upstream call.
 *
 * MOUNT PATH. Deployed, this app is published under a path prefix which infra's
 * balancer STRIPS before proxying, so the server sees `/` in both modes. A
 * root-absolute URL in public/ is therefore a deploy-only failure — perfect locally,
 * 404 in the fleet. `npm run check:paths` fails the build on any violation.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env before anything else is required — several lib modules read
// process.env at module load time, so a loader that runs after them silently
// has no effect. (lib/env.js itself reads nothing at load time.)
require('./lib/env').loadEnvFile(path.join(__dirname, '.env'));

const db = require('./lib/db');
const catalog = require('./lib/catalog');
const oauth = require('./lib/oauth');
const health = require('./lib/health');
const sync = require('./lib/sync');
const webhook = require('./lib/webhook');
const demo = require('./lib/demo');
const {
  BUCKETS, seriesPayload, summaryPayload, tablePayload, assistantDigest, TZ_OFFSET_MS,
} = require('./lib/query');
const views = require('./lib/views');
const screens = require('./lib/screens');
const metrics = require('./lib/metrics');

const PORT = Number(process.env.PORT || 4330);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// One-shot CSRF-ish state for the OAuth round trip.
const pendingStates = new Map();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // Never serve outside public/ — a normalised path that escapes the root is the
  // classic traversal, and this app holds health data. The separator matters: a
  // bare prefix check would also admit a sibling like `public-secrets/`.
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * The viewer's UTC offset in ms. Defaults to the configured house timezone rather
 * than to UTC: a server-side default of 0 would silently shift every civil day for a
 * user who is +4, and the failure looks like missing data at midnight.
 */
function tzOf(q) {
  const tz = q.get('tz');
  const n = Number(tz);
  if (tz !== null && tz !== '' && Number.isFinite(n)) return n;
  // One source of truth for the house offset (lib/query.js) — two copies of the
  // "240" default is how the digest and the screens end up on different days.
  return TZ_OFFSET_MS;
}

function rangeOf(q) {
  const to = q.get('to') ? Number(q.get('to')) : Date.now();
  const from = q.get('from') ? Number(q.get('from')) : to - 30 * 86400000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw Object.assign(new Error('bad range'), { status: 400 });
  }
  // Same default civil day as every other endpoint — a 0 default here silently
  // shifted every day boundary for the +4 viewer on the legacy endpoints.
  return { from, to, offsetMs: tzOf(q) };
}


// ---------------------------------------------------------------------------
// SSE — live sync events
// ---------------------------------------------------------------------------

const sseClients = new Set();

function sseHandler(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // The fleet's edge proxy buffers by default, which turns a live stream into a
    // stream that arrives all at once when the connection closes.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  if (ping.unref) ping.unref();
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
}

sync.bus.on('event', (evt) => {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function route(req, res, url) {
  const { pathname } = url;
  const q = url.searchParams;

  // --- auth ---------------------------------------------------------------
  if (pathname === '/auth/start' && req.method === 'GET') {
    if (!oauth.configured()) {
      return json(res, 400, { error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now());
    for (const [k, ts] of pendingStates) if (Date.now() - ts > 600000) pendingStates.delete(k);
    res.writeHead(302, { location: oauth.authUrl(state, await sync.enabledTypes()) });
    return res.end();
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    const err = q.get('error');
    const code = q.get('code');
    const state = q.get('state');
    if (err) return json(res, 400, { error: err });
    if (!state || !pendingStates.has(state)) return json(res, 400, { error: 'bad state' });
    pendingStates.delete(state);
    try {
      await oauth.exchangeCode(code);
      await db.setSetting('auth_error', '');
      // Identity proves the grant works and gives us the ids the webhook payload
      // will carry; a failure here is not fatal to the connection.
      try {
        const id = await health.identity(() => oauth.accessToken());
        await db.putTokens({ health_user_id: id.healthUserId || null, legacy_user_id: id.legacyUserId || null });
      } catch { /* non-fatal */ }
      await db.addEvent('auth', null, 'connected to Google Health');
      // '../', not './'. Relative Location resolves against the DIRECTORY of the
      // current path, so from /auth/callback './' is /auth/ — a route that does not
      // exist, and the user's reward for a successful login is {"error":"not found"}.
      // '../' lands on the app root in BOTH mount modes: / locally, and /<prefix>/
      // in the fleet, where the balancer strips the prefix before proxying and a
      // root-absolute '/' would leave the app entirely.
      res.writeHead(302, { location: '../' });
      return res.end();
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname === '/auth/disconnect' && req.method === 'POST') {
    await oauth.disconnect();
    await db.addEvent('auth', null, 'disconnected');
    return json(res, 200, { ok: true });
  }

  // --- webhook ------------------------------------------------------------
  if (pathname === '/webhooks/health' && req.method === 'POST') {
    const raw = await readBody(req);
    const result = await webhook.handle(req, raw, {
      // Fire-and-forget with a swallow: the event log is a status strip, and an
      // un-awaited addEvent rejection while MySQL blips would kill the replica
      // (Node exits on unhandled rejections).
      log: (kind, type, msg) => db.addEvent(kind, type, msg).catch(() => {}),
      onChange: (typeId, from, to) => sync.syncRange(() => oauth.accessToken(), typeId, from, to),
    });
    if (result.body) json(res, result.status, result.body);
    else { res.writeHead(result.status); res.end(); }
    // Answer first, work after — Google retries a slow endpoint.
    if (result.after) {
      result.after().catch((e) => db.addEvent('error', null, `webhook: ${e.message}`).catch(() => {}));
    }
    return undefined;
  }

  // --- api ----------------------------------------------------------------
  if (pathname === '/api/catalog') {
    return json(res, 200, {
      groups: catalog.groups(),
      types: catalog.all().map((t) => ({
        id: t.id, label: t.label, group: t.group, unit: t.unit, agg: t.agg,
        chart: t.chart, precision: t.precision, primary: Boolean(t.primary),
        goal: t.goal || null, maxDays: t.maxDays, recordType: t.recordType,
        stackOrder: t.stackOrder || null, stackLabels: t.stackLabels || null,
      })),
      enabled: await sync.enabledTypes(),
      buckets: Object.keys(BUCKETS),
    });
  }

  if (pathname === '/api/status') {
    const [tokens, stats, isConnected, authError, isDemo, syncStatus, plats, events] = await Promise.all([
      db.getTokens(), db.typeStats(), oauth.connected(), db.getSetting('auth_error', ''),
      demo.isDemo(), sync.status(), db.platforms(), db.recentEvents(25),
    ]);
    return json(res, 200, {
      configured: oauth.configured(),
      connected: isConnected,
      authError: authError || null,
      demo: isDemo,
      redirectUri: oauth.redirectUri(),
      user: tokens ? { healthUserId: tokens.health_user_id, connectedMs: tokens.connected_ms } : null,
      sync: syncStatus,
      stats,
      platforms: plats,
      events,
      webhook: {
        configured: Boolean(webhook.secret()),
        path: '/webhooks/health',
        supportedTypes: catalog.WEBHOOK_TYPES,
      },
      serverNow: Date.now(),
    });
  }

  if (pathname === '/api/series') {
    const { from, to, offsetMs } = rangeOf(q);
    const bucketMs = BUCKETS[q.get('bucket') || 'day'] ?? 86400000;
    const types = (q.get('type') || '').split(',').filter(Boolean);
    if (!types.length) throw Object.assign(new Error('type required'), { status: 400 });
    return json(res, 200, {
      from, to, bucketMs,
      series: await Promise.all(types.map((t) => seriesPayload(t, from, to, bucketMs, offsetMs))),
    });
  }

  if (pathname === '/api/summary') {
    const { from, to, offsetMs } = rangeOf(q);
    return json(res, 200, { from, to, tiles: await summaryPayload(from, to, offsetMs) });
  }

  if (pathname === '/api/table') {
    const { from, to } = rangeOf(q);
    return json(res, 200, await tablePayload(q.get('type'), from, to, Number(q.get('limit') || 500)));
  }

  /**
   * One-call digest for the personal assistant.
   *
   * Deliberately NOT a thin proxy over the other endpoints: aggregation happens here,
   * next to the data and its units, because the alternative is a language model doing
   * arithmetic over five responses — which is where invented numbers come from. The
   * payload also states its own freshness and coverage, so the assistant can say
   * "I only have data from the 14th" rather than reporting an absence as a zero.
   */
  if (pathname === '/api/assistant') {
    const tz = q.get('tz');
    const offsetMs = tz !== null && tz !== '' && Number.isFinite(Number(tz))
      ? Number(tz) : undefined;
    return json(res, 200, await assistantDigest(Date.now(), offsetMs));
  }

  // --- the three screens ----------------------------------------------------
  // One endpoint per view. The day screen alone needs eight metrics, an hourly
  // breakdown, a zone histogram and an intraday trace — assembling that from generic
  // series calls would be eight round trips and eight chances to disagree about the
  // range that is being described.

  if (pathname === '/api/view/day') {
    const offsetMs = tzOf(q);
    return json(res, 200, await views.dayPayload(q.get('date'), offsetMs));
  }

  if (pathname === '/api/view/overview') {
    const offsetMs = tzOf(q);
    return json(res, 200, await views.overviewPayload(q.get('days') || 7, offsetMs));
  }

  if (pathname === '/api/view/sleep') {
    const offsetMs = tzOf(q);
    return json(res, 200, await views.sleepPayload(q.get('date'), q.get('days') || 7, offsetMs));
  }

  // --- the five screens -----------------------------------------------------
  // Today / Sleep / Train / Trends / You — the P1 "Five Rooms" structure. Same
  // contract as the legacy views above (which remain for compatibility): one
  // purpose-built payload per screen, and these payloads are the API a native
  // client would consume later, so nothing in them assumes this web UI.

  if (pathname === '/api/screen/today') {
    return json(res, 200, await screens.todayPayload(q.get('date'), tzOf(q)));
  }

  if (pathname === '/api/screen/sleep') {
    return json(res, 200, await screens.sleepScreenPayload(q.get('date'), tzOf(q)));
  }

  if (pathname === '/api/screen/train') {
    return json(res, 200, await screens.trainPayload(tzOf(q)));
  }

  if (pathname === '/api/screen/trends') {
    return json(res, 200, await screens.trendsPayload(tzOf(q), {
      a: q.get('a'), b: q.get('b'), metric: q.get('metric'), heatType: q.get('heat'),
    }));
  }

  if (pathname === '/api/screen/you') {
    return json(res, 200, await screens.youPayload(tzOf(q)));
  }

  if (pathname === '/api/screen/calendar') {
    return json(res, 200, await screens.calendarPayload(q.get('month'), tzOf(q)));
  }

  // --- strength log (the one manually-logged signal) ------------------------
  if (pathname === '/api/strength' && req.method === 'GET') {
    const to = Number(q.get('to')) || Date.now();
    const from = Number(q.get('from')) || to - 60 * 86400000;
    return json(res, 200, { entries: await db.strengthList(from, to) });
  }

  if (pathname === '/api/strength' && req.method === 'POST') {
    const body = await readJson(req);
    const entry = await db.strengthAdd({
      tsMs: body.tsMs, exercise: body.exercise, sets: body.sets,
      reps: body.reps, weightKg: body.weightKg, note: body.note,
    });
    return json(res, 200, { ok: true, entry });
  }

  if (pathname === '/api/strength' && req.method === 'DELETE') {
    const ok = await db.strengthDelete(q.get('id'));
    return json(res, ok ? 200 : 404, { ok });
  }

  /**
   * Age comes from the Google account (synced, read-only here) and estimates max HR;
   * a measured override can replace that estimate for every zone.
   */
  if (pathname === '/api/settings' && req.method === 'GET') {
    const profile = await metrics.getProfile();
    return json(res, 200, {
      ...profile,
      zones: metrics.zoneTable(profile.maxHeartRate),
    });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      throw Object.assign(new Error('settings body must be an object'), { status: 400 });
    }
    // Age is read from the Google account, so it is rejected with its own message
    // rather than lumped in with typos — a client sending it is not guessing at a
    // field name, it is using an input this app deliberately stopped accepting.
    if (Object.hasOwn(body, 'age')) {
      throw Object.assign(
        new Error('age is read from the Google account and cannot be set here'),
        { status: 400 },
      );
    }
    const allowed = new Set(['maxHeartRate']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw Object.assign(new Error(`unknown settings: ${unknown.join(', ')}`), { status: 400 });
    }
    const profile = await metrics.setProfile(body);
    return json(res, 200, {
      ok: true,
      ...profile,
      zones: metrics.zoneTable(profile.maxHeartRate),
    });
  }

  if (pathname === '/api/stream') return sseHandler(req, res);

  if (pathname === '/api/sync' && req.method === 'POST') {
    const body = await readJson(req);
    if (!(await oauth.connected())) return json(res, 409, { error: 'not connected' });
    try {
      const fresh = await sync.syncNow(() => oauth.accessToken(), body.type || null);
      return json(res, 200, { ok: true, fresh });
    } catch (e) {
      // "Already running" is not a failure for an idempotent refresh: the state the
      // caller asked for — a sync happening — is already true. Reporting it as an
      // error makes every scheduled fire that overlaps the app's own loop show up red,
      // which trains you to ignore the one signal that should mean something.
      if (e.status === 409) {
        return json(res, 200, { ok: true, skipped: true, reason: e.message, fresh: 0 });
      }
      return json(res, 502, { error: e.message });
    }
  }

  if (pathname === '/api/types' && req.method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.types)) return json(res, 400, { error: 'types[] required' });
    await sync.setEnabledTypes(body.types);
    return json(res, 200, { ok: true, enabled: await sync.enabledTypes() });
  }

  if (pathname === '/api/demo' && req.method === 'POST') {
    // Never mix synthetic points into a live account's store — demo data goes into
    // the same tables, and untangling it afterwards would be a manual purge.
    if ((await oauth.connected()) && !(await demo.isDemo())) {
      return json(res, 409, { error: 'refusing to load demo data into a connected account’s store' });
    }
    const body = await readJson(req);
    const counts = await demo.load(Number(body.days) || 180);
    return json(res, 200, { ok: true, counts });
  }

  if (pathname === '/api/demo' && req.method === 'DELETE') {
    // demo.clear() wipes EVERY table. Outside demo mode that would destroy real
    // history — including data that has since aged out upstream (this store is
    // also the archive), so the guard is not optional.
    if (!(await demo.isDemo())) {
      return json(res, 409, { error: 'not in demo mode — refusing to clear real data' });
    }
    await demo.clear();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/devices') {
    if (!(await oauth.connected())) return json(res, 409, { error: 'not connected' });
    try {
      const devices = await health.pairedDevices(() => oauth.accessToken());
      return json(res, 200, { devices });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  /** Register (or re-register) the webhook subscriber. Needs the project NUMBER. */
  if (pathname === '/api/webhook/subscribe' && req.method === 'POST') {
    const body = await readJson(req);
    const projectNumber = body.projectNumber || process.env.GOOGLE_PROJECT_NUMBER;
    const endpointUri = body.endpointUri || `${oauth.config().baseUrl}/webhooks/health`;
    if (!projectNumber) return json(res, 400, { error: 'projectNumber required' });
    if (!webhook.secret()) return json(res, 400, { error: 'VITALS_WEBHOOK_SECRET is not set' });
    if (!endpointUri.startsWith('https://')) {
      return json(res, 400, { error: 'endpointUri must be public HTTPS — Google will verify it' });
    }
    try {
      const sub = await health.createSubscriber(
        () => oauth.accessToken(), projectNumber, body.subscriberId || 'vitals-main',
        { endpointUri, dataTypes: catalog.WEBHOOK_TYPES, secret: webhook.secret() },
      );
      await db.addEvent('webhook', null, `subscriber registered at ${endpointUri}`);
      return json(res, 200, { ok: true, subscriber: sub });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  /**
   * Liveness for the balancer. NOT `/` — that serves the dashboard HTML and would
   * report healthy even with the database unreachable, so every replica would stay
   * in rotation while answering nothing. This touches MySQL, because a replica that
   * cannot reach the store has nothing useful to serve.
   */
  if (pathname === '/health') {
    try {
      await db.ping();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 503, { ok: false, error: e.message });
    }
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
    return json(res, 404, { error: 'not found' });
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  Promise.resolve(route(req, res, url)).catch((err) => {
    const status = err.status || 500;
    // Swallow the log write's own failure: when the pool is down this handler runs
    // for every request, and an unhandled rejection here turns a 500 into a dead
    // replica — the exact failure /health exists to catch gracefully.
    if (status >= 500) db.addEvent('error', null, `${url.pathname}: ${err.message}`).catch(() => {});
    if (!res.headersSent) json(res, status, { error: err.message });
    else res.end();
  });
});

/**
 * Boot order matters: open the store BEFORE listening. A replica that accepts
 * requests while its pool is still connecting answers 500s that look like app bugs,
 * and the balancer would happily route to it.
 */
async function main() {
  await db.open();

  if (process.env.VITALS_DEMO === '1' && !(await demo.isDemo())) {
    const counts = await demo.load(Number(process.env.VITALS_DEMO_DAYS || 180));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    process.stdout.write(`  demo data loaded (${total} points)\n`);
  }

  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  process.stdout.write(`vitals listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`  store: ${db.config().user}@${db.config().host}:${db.config().port}/${db.config().database}\n`);
  if (!oauth.configured()) {
    process.stdout.write('  no Google credentials set — open the page and connect, or see README\n');
  }

  sync.start(() => oauth.accessToken());
}

main().catch((err) => {
  process.stderr.write(`vitals failed to start: ${err.message}\n`);
  process.exit(1);
});

module.exports = { server };
