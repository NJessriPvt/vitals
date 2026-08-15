'use strict';
/**
 * Tests for the parts that fail silently in production.
 *
 * The bias here is deliberate: these cover the things whose failure mode is a chart
 * that looks fine and is wrong (filter syntax, window chunking, restatement,
 * timezone bucketing) plus the webhook's auth ordering, which fails registration
 * rather than at runtime. Rendering is checked by looking at the page.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// .env so a developer's tunnel settings are picked up without exporting anything.
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

/**
 * Storage tests need a real MySQL, which a Docker build does not have — and the
 * Dockerfile runs this suite as a build gate. So they are SKIPPED, loudly, when no
 * database is reachable, and the pure tests (naming, filters, chunking, normalizing,
 * webhook auth) still gate every build. They never touch the live `vitals` schema:
 * VITALS_TEST_DATABASE is a separate database that gets truncated on entry.
 */
const TEST_DATABASE = process.env.VITALS_TEST_DATABASE || 'vitals_test';
let dbReady = false;

const catalog = require('../lib/catalog');
const health = require('../lib/health');
const normalize = require('../lib/normalize');
const db = require('../lib/db');
const query = require('../lib/query');
const webhook = require('../lib/webhook');
const demo = require('../lib/demo');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use testAsync for async tests');
    passed++;
  } catch (err) {
    failures.push([name, err]);
  }
}

const asyncTests = [];
function testAsync(name, fn) { asyncTests.push([name, fn]); }

// Async tests that need a live database; skipped when none is reachable.
const DB_BACKED = new Set(["restated points upsert instead of doubling the total", "day buckets follow the viewer offset, not UTC", "stacked parts are replaced wholesale on restatement", "avg never sums: a bucketed heart rate stays a rate", "last takes the newest reading in the bucket", "a partial token write never nulls the fields it did not pass", "two bedtimes either side of midnight land on different days", "sparse metrics keep their real spacing on the time axis", "denseBuckets never invents a bucket outside the range", "out-of-range zone time is stored but kept out of the stack", "the delta compares against the previous equal-length period"]);

// ---------------------------------------------------------------------------
// catalog — the filter field is per record type and a wrong one is a 400
// ---------------------------------------------------------------------------

test('filter field follows the record type', () => {
  const from = Date.UTC(2026, 4, 14);
  const to = Date.UTC(2026, 4, 15);

  assert.strictEqual(
    catalog.timeRangeFilter(catalog.get('steps'), from, to),
    'steps.interval.start_time >= "2026-05-14T00:00:00Z" AND steps.interval.start_time < "2026-05-15T00:00:00Z"',
  );
  assert.match(catalog.timeRangeFilter(catalog.get('heart-rate'), from, to),
    /^heart_rate\.sample_time\.physical_time >=/);
  assert.match(catalog.timeRangeFilter(catalog.get('sleep'), from, to),
    /^sleep\.interval\.end_time >=/);
});

test('daily types filter on a civil date, never a timestamp', () => {
  const f = catalog.timeRangeFilter(catalog.get('daily-resting-heart-rate'),
    Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15));
  assert.strictEqual(f,
    'daily_resting_heart_rate.date >= "2026-05-14" AND daily_resting_heart_rate.date < "2026-05-15"');
  assert.ok(!f.includes('T00:00:00Z'), 'daily filter must not carry a time');
});

test('multi-word types use snake_case in the filter and kebab-case as the id', () => {
  const t = catalog.get('active-zone-minutes');
  assert.strictEqual(t.id, 'active-zone-minutes');
  assert.strictEqual(t.snake, 'active_zone_minutes');
  assert.ok(catalog.timeRangeFilter(t, 0, 1).startsWith('active_zone_minutes.'));
});

test('scopes are deduplicated and always include profile', () => {
  const s = catalog.scopesFor(['steps', 'distance', 'sleep']);
  assert.strictEqual(new Set(s).size, s.length);
  assert.ok(s.some((x) => x.endsWith('.profile.readonly')));
  assert.ok(s.some((x) => x.endsWith('.activity_and_fitness.readonly')));
  assert.ok(s.some((x) => x.endsWith('.sleep.readonly')));
});

// ---------------------------------------------------------------------------
// health — window chunking against the documented max query range
// ---------------------------------------------------------------------------

test('chunks never exceed the type max window and cover the range', () => {
  const to = Date.UTC(2026, 7, 1);
  const from = to - 365 * 86400000;

  for (const id of ['steps', 'heart-rate']) {
    const type = catalog.get(id);
    const cs = health.chunks(type, from, to);
    const maxMs = type.maxDays * 86400000;
    for (const [a, b] of cs) assert.ok(b - a <= maxMs, `${id}: chunk longer than ${type.maxDays}d`);
    assert.strictEqual(cs[0][1], to, 'newest chunk first');
    assert.strictEqual(cs[cs.length - 1][0], from, 'oldest chunk reaches the start');
    // Contiguous, no gaps — a gap is silently missing data.
    for (let i = 1; i < cs.length; i++) assert.strictEqual(cs[i][1], cs[i - 1][0]);
  }
  assert.ok(health.chunks(catalog.get('heart-rate'), from, to).length > 25,
    'a year of heart rate must chunk at 14 days');
});

test('rollup types chunk to the rollup cap, not their list window', () => {
  // floors lists at 90 days but rolls up at 14 civil days, and the request rounds
  // its exclusive end up a day — so chunks must stay at 13 or every call 400s.
  const to = Date.UTC(2026, 7, 1);
  const from = to - 90 * 86400000;
  const type = catalog.get('floors');
  assert.strictEqual(type.listMethod, 'dailyRollUp');
  for (const [a, b] of health.chunks(type, from, to)) {
    assert.ok((b - a) <= 13 * 86400000, 'rollup chunk longer than the 13-day cap');
  }
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

test('interval point: value, times and source', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'users/1/dataTypes/steps/dataPoints/9',
    dataSource: { recordingMethod: 'AUTO_DETECTED', platform: 'FITBIT' },
    steps: {
      interval: { startTime: '2026-05-14T08:00:00Z', endTime: '2026-05-14T09:00:00Z' },
      count: '2038',
    },
  }, catalog.get('steps'), notes);

  assert.strictEqual(row.value, 2038, 'int64-as-string must parse');
  assert.strictEqual(row.startMs, Date.parse('2026-05-14T08:00:00Z'));
  assert.strictEqual(row.endMs, Date.parse('2026-05-14T09:00:00Z'));
  assert.strictEqual(row.platform, 'FITBIT');
  assert.strictEqual(notes.size, 0, 'a documented shape must produce no warnings');
});

test('sample point: sampleTime.physicalTime is the instant', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/1',
    heartRate: { sampleTime: { physicalTime: '2026-05-14T08:30:00Z' }, beatsPerMinute: 72 },
  }, catalog.get('heart-rate'), notes);
  assert.strictEqual(row.value, 72);
  assert.strictEqual(row.startMs, row.endMs);
});

test('daily point: a bare date anchors to local midnight', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/2',
    dailyRestingHeartRate: { date: '2026-05-14', beatsPerMinute: 54 },
  }, catalog.get('daily-resting-heart-rate'), notes);
  assert.strictEqual(row.value, 54);
  assert.strictEqual(new Date(row.startMs).getDate(), 14, 'must land on the 14th locally');
  assert.strictEqual(new Date(row.startMs).getHours(), 0);
});

test('sleep: value is time ASLEEP, stages become parts, awake is excluded', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'sleeps/12345',
    sleep: {
      startTime: '2026-04-20T22:30:00Z',
      endTime: '2026-04-21T06:30:00Z',
      sleepType: 'STAGES',
      sleepStages: [
        { startTime: '2026-04-20T22:30:00Z', endTime: '2026-04-20T23:30:00Z', type: 'LIGHT' },
        { startTime: '2026-04-20T23:30:00Z', endTime: '2026-04-21T01:00:00Z', type: 'DEEP' },
        { startTime: '2026-04-21T01:00:00Z', endTime: '2026-04-21T01:15:00Z', type: 'AWAKE' },
      ],
    },
  }, catalog.get('sleep'), notes);

  assert.strictEqual(row.parts.LIGHT, 3600000);
  assert.strictEqual(row.parts.DEEP, 5400000);
  assert.strictEqual(row.parts.AWAKE, 900000);
  assert.strictEqual(row.value, 9000000, 'asleep = light + deep, awake excluded');
  assert.strictEqual(row.fields.inBedMs, 8 * 3600000);
});

test('sleep without stages still plots (CLASSIC records have none)', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'sleeps/2',
    sleep: { startTime: '2026-04-20T23:00:00Z', endTime: '2026-04-21T06:00:00Z', sleepType: 'CLASSIC' },
  }, catalog.get('sleep'), notes);
  assert.strictEqual(row.value, 7 * 3600000);
  assert.ok(row.parts.LIGHT > 0, 'must still produce a drawable segment');
});

test('sleep anchors on wake time, everything else on start', () => {
  const notes = new Set();
  const sleep = normalize.normalizePoint({
    name: 'sleeps/3',
    sleep: { startTime: '2026-04-20T23:40:00Z', endTime: '2026-04-21T07:10:00Z' },
  }, catalog.get('sleep'), notes);
  assert.strictEqual(sleep.anchorMs, Date.parse('2026-04-21T07:10:00Z'),
    'a night belongs to the morning you woke up');

  const steps = normalize.normalizePoint({
    name: 's/1',
    steps: { interval: { startTime: '2026-04-20T08:00:00Z', endTime: '2026-04-20T09:00:00Z' }, count: 10 },
  }, catalog.get('steps'), notes);
  assert.strictEqual(steps.anchorMs, steps.startMs);
});

test('exercise: "900s" duration parses to milliseconds', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'e/1',
    exercise: {
      interval: { startTime: '2026-02-23T13:10:00Z', endTime: '2026-02-23T13:25:00Z' },
      exerciseType: 'WALKING', activeDuration: '900s',
      metricsSummary: { caloriesKcal: 16, steps: '2038' },
    },
  }, catalog.get('exercise'), notes);
  assert.strictEqual(row.value, 900000);
  assert.strictEqual(row.fields.calories, 16);
  assert.strictEqual(row.fields.steps, 2038);
});

test('heart-rate zones split into ordered parts', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'z/1',
    timeInHeartRateZone: {
      interval: { startTime: '2026-05-14T00:00:00Z', endTime: '2026-05-15T00:00:00Z' },
      zones: [{ zone: 'FAT_BURN', minutes: 30 }, { zone: 'CARDIO', minutes: 12 }],
    },
  }, catalog.get('time-in-heart-rate-zone'), notes);
  assert.strictEqual(row.parts.FAT_BURN, 30);
  assert.strictEqual(row.value, 42);
});

test('an unknown value field is used but reported, never silently dropped', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({
    name: 'p/9',
    floors: { interval: { startTime: '2026-05-14T00:00:00Z', endTime: '2026-05-15T00:00:00Z' }, flightsClimbed: 12 },
  }, catalog.get('floors'), notes);
  assert.strictEqual(row.value, 12);
  assert.ok([...notes].some((n) => n.includes('unlisted field')), 'must warn about the guess');
});

test('a point with no usable timestamp is dropped, not stored at epoch 0', () => {
  const notes = new Set();
  const row = normalize.normalizePoint({ name: 'p/x', steps: { count: 5 } }, catalog.get('steps'), notes);
  assert.strictEqual(row, null);
  assert.ok(notes.size > 0);
});

// ---------------------------------------------------------------------------
// db
// ---------------------------------------------------------------------------


testAsync('restated points upsert instead of doubling the total', async () => {
  const base = {
    dataType: 'steps', pointId: 'users/1/steps/1',
    startMs: Date.UTC(2026, 4, 14, 8), endMs: Date.UTC(2026, 4, 14, 9),
    value: 1000, platform: 'FITBIT', parts: {}, raw: { v: 1 },
  };
  let r = await db.putPoints([base]);
  assert.strictEqual(r.fresh, 1);

  // Same point, corrected upward — exactly what a late watch sync does.
  r = await db.putPoints([{ ...base, value: 1800, raw: { v: 2 } }]);
  assert.strictEqual(r.fresh, 0, 'a restatement is not a new point');

  const total = await db.aggregate('steps', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 'sum');
  assert.strictEqual(total, 1800, 'the corrected value replaces the original');
});

testAsync('day buckets follow the viewer offset, not UTC', async () => {
  // 21:30 UTC on the 14th is 01:30 on the 15th at UTC+4.
  await db.putPoints([{
    dataType: 'floors', pointId: 'f/1',
    startMs: Date.UTC(2026, 4, 14, 21, 30), endMs: Date.UTC(2026, 4, 14, 22),
    value: 7, parts: {}, raw: {},
  }]);
  const from = Date.UTC(2026, 4, 10);
  const to = Date.UTC(2026, 4, 20);

  const utc = await db.series('floors', from, to, 86400000, 'sum', 0);
  const gulf = await db.series('floors', from, to, 86400000, 'sum', 4 * 3600000);
  assert.strictEqual(new Date(utc[0].t).getUTCDate(), 14);
  assert.strictEqual(new Date(gulf[0].t + 4 * 3600000).getUTCDate(), 15,
    'at UTC+4 the point belongs to the 15th');
});

testAsync('stacked parts are replaced wholesale on restatement', async () => {
  const row = {
    dataType: 'sleep', pointId: 'sleeps/1', startMs: Date.UTC(2026, 4, 14, 22),
    endMs: Date.UTC(2026, 4, 15, 6), value: 100, raw: {},
    parts: { DEEP: 60, LIGHT: 40, AWAKE: 10 },
  };
  await db.putPoints([row]);
  // The revision drops AWAKE entirely; a merge would leave a ghost segment behind.
  await db.putPoints([{ ...row, parts: { DEEP: 70, LIGHT: 30 } }]);
  const rows = await db.stackedSeries('sleep', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 16), 86400000, 0);
  const keys = rows.map((r) => r.key);
  assert.ok(!keys.includes('AWAKE'), 'a stage removed upstream must not survive locally');
  assert.strictEqual(rows.find((r) => r.key === 'DEEP').v, 70);
});

testAsync('avg never sums: a bucketed heart rate stays a rate', async () => {
  await db.putPoints([60, 80, 100].map((v, i) => ({
    dataType: 'heart-rate', pointId: `hr/${i}`,
    startMs: Date.UTC(2026, 4, 14, 8, i * 10), endMs: Date.UTC(2026, 4, 14, 8, i * 10),
    value: v, parts: {}, raw: {},
  })));
  const [bucket] = await db.series('heart-rate', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 86400000, 'avg', 0);
  assert.strictEqual(bucket.v, 80);
  assert.strictEqual(bucket.lo, 60);
  assert.strictEqual(bucket.hi, 100, 'the band keeps the range the average hides');
});

testAsync('last takes the newest reading in the bucket', async () => {
  await db.putPoints([
    { dataType: 'weight', pointId: 'w/1', startMs: Date.UTC(2026, 4, 14, 7), endMs: Date.UTC(2026, 4, 14, 7), value: 78.4, parts: {}, raw: {} },
    { dataType: 'weight', pointId: 'w/2', startMs: Date.UTC(2026, 4, 14, 19), endMs: Date.UTC(2026, 4, 14, 19), value: 79.1, parts: {}, raw: {} },
  ]);
  const [b] = await db.series('weight', Date.UTC(2026, 4, 14), Date.UTC(2026, 4, 15), 86400000, 'last', 0);
  assert.strictEqual(b.v, 79.1);
});

testAsync('a partial token write never nulls the fields it did not pass', async () => {
  // Regression: the OAuth callback stores the user id immediately after the token
  // exchange. A plain-assignment upsert wiped access_token/expiry, so a successful
  // login reported "not connected" from the next request onward.
  await db.putTokens({
    access_token: 'ya29.initial', refresh_token: '1//refresh',
    expiry_ms: 4102444800000, scope: 'a b',
  });
  await db.putTokens({ health_user_id: '5680734231359142911' });

  const t = await db.getTokens();
  assert.strictEqual(t.access_token, 'ya29.initial', 'access token must survive');
  assert.strictEqual(t.refresh_token, '1//refresh');
  assert.strictEqual(t.expiry_ms, 4102444800000, 'expiry must survive');
  assert.strictEqual(t.scope, 'a b');
  assert.strictEqual(t.health_user_id, '5680734231359142911');

  // A refresh grant returns no refresh_token; the stored one must be kept.
  await db.putTokens({ access_token: 'ya29.second', expiry_ms: 4102444900000 });
  assert.strictEqual((await db.getTokens()).refresh_token, '1//refresh');
  await db.clearTokens();
});

testAsync('two bedtimes either side of midnight land on different days', async () => {
  // The bug this guards: bucketing sleep by START puts a 23:40 and a 00:20 bedtime
  // on different calendar days, so one day shows a 15-hour double night and the
  // next shows none.
  const nights = [
    { start: '2026-06-01T23:40:00Z', end: '2026-06-02T07:00:00Z' },
    { start: '2026-06-03T00:20:00Z', end: '2026-06-03T08:00:00Z' },
  ];
  const notes = new Set();
  const rows = nights.map((n, i) => normalize.normalizePoint({
    name: `sleeps/anchor-${i}`,
    sleep: { startTime: n.start, endTime: n.end },
  }, catalog.get('sleep'), notes));
  await db.putPoints(rows);

  const series = await db.series('sleep', Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 5), 86400000, 'sum', 0);
  assert.strictEqual(series.length, 2, 'one bar per night, never two nights in one bar');
  assert.deepStrictEqual(
    series.map((s) => new Date(s.t).getUTCDate()), [2, 3],
    'each night lands on its wake day',
  );
});

// ---------------------------------------------------------------------------
// query — the read side
// ---------------------------------------------------------------------------

testAsync('sparse metrics keep their real spacing on the time axis', async () => {
  // Two workouts nine days apart. Positioned by array index they would be drawn as
  // neighbours; the range must come back with one bucket per day so the gap is real.
  const days = [1, 10];
  await db.putPoints(days.map((d) => ({
    dataType: 'exercise', pointId: `ex/${d}`,
    startMs: Date.UTC(2026, 6, d, 18), endMs: Date.UTC(2026, 6, d, 19),
    value: 3600000, parts: {}, raw: {},
  })));

  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 15);
  const payload = await query.seriesPayload('exercise', from, to, 86400000, 0);

  assert.strictEqual(payload.points.length, 14, 'one bucket per day in the range');
  const withData = payload.points.filter((p) => p.v !== null);
  assert.strictEqual(withData.length, 2);
  const [a, b] = withData.map((p) => payload.points.indexOf(p));
  assert.strictEqual(b - a, 9, 'nine empty buckets separate the two workouts');
  assert.strictEqual(payload.points[a + 1].v, null, 'an empty day is null, never 0');
});

testAsync('denseBuckets never invents a bucket outside the range', async () => {
  const from = Date.UTC(2026, 6, 1);
  const to = Date.UTC(2026, 6, 4);
  const dense = query.denseBuckets([], from, to, 86400000, 0, (t) => ({ t, v: null }));
  assert.strictEqual(dense.length, 3);
  assert.strictEqual(dense[0].t, from);
  assert.ok(dense[dense.length - 1].t < to);
});

testAsync('out-of-range zone time is stored but kept out of the stack', async () => {
  await db.putPoints([{
    dataType: 'time-in-heart-rate-zone', pointId: 'z/day1',
    startMs: Date.UTC(2026, 6, 20), endMs: Date.UTC(2026, 6, 21),
    value: 1242, parts: { OUT_OF_RANGE: 1200, FAT_BURN: 30, CARDIO: 12 }, raw: {},
  }]);
  const payload = await query.seriesPayload('time-in-heart-rate-zone',
    Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 21), 86400000, 0);
  assert.deepStrictEqual(payload.keys, ['FAT_BURN', 'CARDIO'],
    'a 1,200-minute segment would flatten every zone that matters');
  assert.strictEqual(payload.points[0].parts.OUT_OF_RANGE, undefined);
  // Still on disk, still in the table view.
  const table = await query.tablePayload('time-in-heart-rate-zone',
    Date.UTC(2026, 6, 20), Date.UTC(2026, 6, 21), 10);
  assert.strictEqual(table.rows.length, 1);
});

testAsync('the delta compares against the previous equal-length period', async () => {
  // 50 bpm across the earlier week, 55 across the later one: +10%.
  const rows = [];
  for (let d = 0; d < 14; d++) {
    rows.push({
      dataType: 'daily-resting-heart-rate', pointId: `rhr/${d}`,
      startMs: Date.UTC(2026, 8, 1 + d), endMs: Date.UTC(2026, 8, 1 + d),
      value: d < 7 ? 50 : 55, parts: {}, raw: {},
    });
  }
  await db.putPoints(rows);

  const tiles = await query.summaryPayload(Date.UTC(2026, 8, 8), Date.UTC(2026, 8, 15), 0);
  const tile = tiles.find((x) => x.type === 'daily-resting-heart-rate');
  assert.strictEqual(tile.value, 55);
  assert.ok(Math.abs(tile.delta - 10) < 0.001, `expected +10%, got ${tile.delta}`);
  // The flag that stops the UI painting a rising resting heart rate green.
  assert.strictEqual(tile.upIsGood, false);
});

// ---------------------------------------------------------------------------
// demo — proves the whole normalize path, since it uses the same one
// ---------------------------------------------------------------------------

test('demo data normalizes with no shape warnings', () => {
  const byType = demo.generate(3);
  let rows = 0;
  for (const [typeId, points] of byType) {
    const { rows: r, notes } = normalize.normalizeBatch(points, catalog.get(typeId));
    assert.strictEqual(notes.length, 0, `${typeId}: ${notes.join('; ')}`);
    assert.ok(r.length > 0, `${typeId} produced no rows`);
    assert.ok(r.every((x) => Number.isFinite(x.startMs)), `${typeId} has a bad timestamp`);
    rows += r.length;
  }
  assert.ok(rows > 100);
});

// ---------------------------------------------------------------------------
// webhook — the auth ordering is what makes registration succeed
// ---------------------------------------------------------------------------

testAsync('unauthenticated handshake gets 401 (registration depends on it)', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: {} },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 401,
    'an endpoint that 200s an unauthenticated probe fails subscriber creation');
});

testAsync('authorized handshake gets 200', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 200);
});

testAsync('a wrong secret is rejected even with a valid-looking body', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer wrong' } },
    Buffer.from(JSON.stringify({ type: 'verification' })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 401);
});

testAsync('an unsigned notification is refused by default', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  delete process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE;
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({ data: { dataType: 'steps', operation: 'UPSERT', intervals: [] } })),
    { onChange: async () => {}, log: () => {} },
  );
  assert.strictEqual(res.status, 403, 'this endpoint is public; the signature is the boundary');
});

testAsync('a notification triggers a targeted fetch of its interval', async () => {
  process.env.VITALS_WEBHOOK_SECRET = 'test-secret';
  process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE = '0';
  const calls = [];
  const res = await webhook.handle(
    { headers: { authorization: 'Bearer test-secret' } },
    Buffer.from(JSON.stringify({
      data: {
        dataType: 'steps',
        operation: 'UPSERT',
        intervals: [{
          physicalTimeInterval: {
            startTime: '2026-03-08T01:29:00Z', endTime: '2026-03-08T01:34:00Z',
          },
        }],
      },
    })),
    { onChange: async (...a) => calls.push(a), log: () => {} },
  );
  assert.strictEqual(res.status, 204, 'Google wants 204 immediately');
  await res.after();
  assert.strictEqual(calls.length, 1);
  const [typeId, from, to] = calls[0];
  assert.strictEqual(typeId, 'steps');
  assert.ok(from < Date.parse('2026-03-08T01:29:00Z'), 'window is padded either side');
  assert.ok(to > Date.parse('2026-03-08T01:34:00Z'));
  delete process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE;
});

test('the post-login redirect lands on the app root, not inside /auth', () => {
  // Regression: Location './' resolves against the DIRECTORY of /auth/callback,
  // giving /auth/ — an unrouted path — so a SUCCESSFUL login rendered
  // {"error":"not found"}. '../' is correct in both mount modes.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const callback = src.slice(src.indexOf("pathname === '/auth/callback'"));
  const redirect = /location:\s*'([^']+)'/.exec(callback);
  assert.ok(redirect, 'callback must redirect somewhere');
  assert.strictEqual(redirect[1], '../');

  const resolve = (base, rel) => new URL(rel, `http://x${base}`).pathname;
  assert.strictEqual(resolve('/auth/callback', redirect[1]), '/', 'local mount');
  assert.strictEqual(resolve('/vitals/auth/callback', redirect[1]), '/vitals/', 'fleet mount');
  assert.strictEqual(resolve('/auth/callback', './'), '/auth/', 'the bug this guards');
});

test('notification data types resolve in every naming form', () => {
  assert.strictEqual(webhook.resolveType('steps').id, 'steps');
  assert.strictEqual(webhook.resolveType('body_fat').id, 'body-fat');
  assert.strictEqual(webhook.resolveType('body-fat').id, 'body-fat');
  assert.strictEqual(webhook.resolveType('nope'), null);
});

// ---------------------------------------------------------------------------

(async () => {
  try {
    await db.open({ database: TEST_DATABASE });
    await db.clearAll();
    await db.clearTokens();
    dbReady = true;
  } catch (err) {
    process.stdout.write(`\n  SKIPPING storage tests — no database (${err.message})\n`
      + '  Pure tests still ran. For the full suite point MYSQL_* at a server.\n\n');
  }

  let skipped = 0;
  for (const [name, fn] of asyncTests) {
    if (!dbReady && DB_BACKED.has(name)) { skipped++; continue; }
    try { await fn(); passed++; } catch (err) { failures.push([name, err]); }
  }

  if (dbReady) await db.close();

  if (failures.length) {
    for (const [name, err] of failures) {
      process.stderr.write(`FAIL  ${name}\n      ${err.message}\n`);
    }
    process.stderr.write(`\n${failures.length} failed, ${passed} passed\n`);
    process.exit(1);
  }
  process.stdout.write(`${passed} tests passed${skipped ? ` (${skipped} storage tests skipped)` : ''}\n`);
})();
