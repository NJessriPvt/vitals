'use strict';
/**
 * Google Health API v4 client — the only module that speaks HTTP to Google.
 *
 * Three things this wraps that callers must never hand-roll:
 *
 *   RATE LIMITING. The documented per-user ceiling is 300 requests/minute. A
 *   backfill of 20 data types over a year is thousands of requests and will hit it,
 *   so every call goes through one token bucket set below the ceiling. Getting
 *   429'd is not free — it costs the request AND the retry.
 *
 *   WINDOW CHUNKING. Maximum query range is 90 days for most types but 14 for
 *   heart-rate, active-minutes, total-calories and calories-in-heart-rate-zone.
 *   Ask for a year in one call and it fails; `chunks()` is the only correct way to
 *   walk a long range.
 *
 *   PAGINATION. `pageSize` defaults to 1440 and caps at 10,000. Intraday heart rate
 *   for one day exceeds the default easily, so a caller that ignores nextPageToken
 *   silently truncates the day and the chart looks fine while being wrong.
 */

const catalog = require('./catalog');

const BASE = process.env.VITALS_HEALTH_API || 'https://health.googleapis.com/v4';

// The ceiling is 300/min per user; sit under it so a burst of retries has headroom.
const RATE_PER_MIN = Number(process.env.VITALS_RATE_PER_MIN || 240);
const PAGE_SIZE = Number(process.env.VITALS_PAGE_SIZE || 5000);
const MAX_RETRIES = 5;

const bucket = {
  tokens: RATE_PER_MIN,
  last: Date.now(),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function takeToken() {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(RATE_PER_MIN, bucket.tokens + ((now - bucket.last) / 60000) * RATE_PER_MIN);
    bucket.last = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
    await sleep(Math.ceil((1 - bucket.tokens) * (60000 / RATE_PER_MIN)));
  }
}

class HealthApiError extends Error {
  constructor(status, body, url) {
    const detail = body && body.error ? (body.error.message || body.error.status) : String(body).slice(0, 200);
    super(`Google Health API ${status}: ${detail}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * One authenticated request, with retry. Retries 429 and 5xx with exponential
 * backoff, honouring Retry-After when Google sends it. Never retries a 4xx that
 * isn't 429 — a malformed filter would just fail five more times.
 */
async function request(getToken, urlPath, { method = 'GET', body = null, query = null } = {}) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : `${BASE}${urlPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  let attempt = 0;
  for (;;) {
    await takeToken();
    const token = await getToken();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      if (attempt++ >= MAX_RETRIES) throw netErr;
      await sleep(Math.min(30000, 500 * 2 ** attempt));
      continue;
    }

    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }

    if (res.ok) return json || {};

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      attempt++;
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 1000 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new HealthApiError(res.status, json, url.pathname);
  }
}

/**
 * Split [fromMs, toMs) into windows no longer than the type's documented maximum.
 * Newest chunk first: a backfill that is interrupted has then filled the range the
 * dashboard actually opens on, rather than a year-old prefix nobody is looking at.
 */
/**
 * The rollup range cap is 14 CIVIL DAYS and is unrelated to the type's `list`
 * window — floors lists at 90 days but rolls up at 14. Chunks are cut at 13 because
 * the request rounds its exclusive end up to the next civil day, so a 14-day span
 * asks for 15 days and is rejected.
 */
const ROLLUP_MAX_DAYS = 13;

function chunks(type, fromMs, toMs) {
  const days = type.listMethod === 'dailyRollUp'
    ? Math.min(type.maxDays, ROLLUP_MAX_DAYS)
    : type.maxDays;
  const maxMs = days * 86400000;
  const out = [];
  let end = toMs;
  while (end > fromMs) {
    const start = Math.max(fromMs, end - maxMs);
    out.push([start, end]);
    end = start;
  }
  return out;
}

/** All data points for one type in one window, following pagination to the end. */
async function listDataPoints(getToken, typeId, fromMs, toMs, { onPage = null } = {}) {
  const type = catalog.get(typeId);
  if (!type) throw new Error(`unknown data type ${typeId}`);

  const points = [];
  let pageToken = '';
  let pages = 0;
  do {
    const res = await request(getToken, `/users/me/dataTypes/${type.id}/dataPoints`, {
      query: {
        filter: catalog.timeRangeFilter(type, fromMs, toMs),
        pageSize: PAGE_SIZE,
        pageToken: pageToken || undefined,
      },
    });
    const batch = res.dataPoints || [];
    points.push(...batch);
    if (onPage) onPage(batch, ++pages);
    pageToken = res.nextPageToken || '';
    // A server that keeps handing back a token with no rows would loop forever.
    if (!batch.length) break;
  } while (pageToken);

  return points;
}

/**
 * Daily rollups. Some types refuse `list` outright — the API answers "List is not
 * supported for data type total-calories, but the following actions are supported:
 * rollup, dailyRollup" — so for those this is the ONLY way to read them.
 *
 * Note the different shape at every level: a POST not a GET, a civil-date `range`
 * object instead of a filter string, and `rollupDataPoints` instead of `dataPoints`.
 */
async function dailyRollUp(getToken, typeId, fromMs, toMs) {
  const type = catalog.get(typeId);
  if (!type) throw new Error(`unknown data type ${typeId}`);

  const points = [];
  let pageToken = '';
  do {
    const res = await request(getToken, `/users/me/dataTypes/${type.id}/dataPoints:dailyRollUp`, {
      method: 'POST',
      body: {
        // `end` is EXCLUSIVE and expressed as a whole civil day, so passing today's
        // date drops today entirely — the symptom being a "daily total" that is
        // always yesterday's. Round up to the day after the one `toMs` falls in.
        range: { start: catalog.civilDate(fromMs), end: catalog.civilDate(toMs + 86399999) },
        windowSizeDays: 1,
        // NO pageSize. The reference documents it on this method, but sending it is
        // rejected with "Invalid argument in request" — measured, on both types that
        // require rollup. One row per day keeps responses small anyway.
        ...(pageToken ? { pageToken } : {}),
      },
    });
    const batch = res.rollupDataPoints || [];
    points.push(...batch);
    pageToken = res.nextPageToken || '';
    if (!batch.length) break;
  } while (pageToken);

  return points;
}

/** Read a window by whichever method the type actually supports. */
async function fetchWindow(getToken, typeId, fromMs, toMs) {
  const type = catalog.get(typeId);
  return type.listMethod === 'dailyRollUp'
    ? { rollup: true, points: await dailyRollUp(getToken, typeId, fromMs, toMs) }
    : { rollup: false, points: await listDataPoints(getToken, typeId, fromMs, toMs) };
}

/** Which user this token belongs to. Also the cheapest way to prove auth works. */
async function identity(getToken) {
  return request(getToken, '/users/me/identity');
}

/** Devices feeding the account — the honest answer to "why is there no data". */
async function pairedDevices(getToken) {
  const res = await request(getToken, '/users/me/pairedDevices');
  return res.pairedDevices || res.devices || [];
}

// --- Webhook subscribers ----------------------------------------------------
// Note the path takes the project NUMBER, not the project id.

async function listSubscribers(getToken, projectNumber) {
  const res = await request(getToken, `/projects/${projectNumber}/subscribers`);
  return res.subscribers || [];
}

async function createSubscriber(getToken, projectNumber, subscriberId, { endpointUri, dataTypes, secret }) {
  return request(getToken, `/projects/${projectNumber}/subscribers`, {
    method: 'POST',
    query: { subscriberId },
    body: {
      endpointUri,
      subscriberConfigs: [{ dataTypes, subscriptionCreatePolicy: 'AUTOMATIC' }],
      endpointAuthorization: { secret: `Bearer ${secret}` },
    },
  });
}

async function deleteSubscriber(getToken, projectNumber, subscriberId) {
  return request(getToken, `/projects/${projectNumber}/subscribers/${subscriberId}`, { method: 'DELETE' });
}

module.exports = {
  request, chunks, listDataPoints, dailyRollUp, fetchWindow, identity, pairedDevices,
  listSubscribers, createSubscriber, deleteSubscriber,
  HealthApiError, BASE,
};
