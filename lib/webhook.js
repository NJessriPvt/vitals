'use strict';
/**
 * Webhook receiver — the "almost real time" half of sync.
 *
 * Google pushes a notification when data changes, for six types only (steps,
 * altitude, distance, floors, weight, sleep). The payload says WHAT changed over
 * WHICH interval — it carries no values — so a notification is an instruction to
 * fetch that window now, not data to store.
 *
 * THE VERIFICATION HANDSHAKE is the part that trips people up. On subscriber
 * create/update Google sends `{"type":"verification"}` TWICE:
 *
 *   1. with the Authorization header you configured  -> must answer 200/201
 *   2. with NO credentials                           -> must answer 401/403
 *
 * The second call is the real test: it proves the endpoint is actually guarded. An
 * endpoint that cheerfully 200s everything FAILS registration with
 * FAILED_PRECONDITION. So the auth check below must run BEFORE the handshake reply,
 * never after — which is the opposite of the usual "handle health checks first"
 * instinct.
 *
 * Notifications are signed (ECDSA P-256 / SHA-256, Tink keyset, keys rotate every
 * 30 days). This endpoint is publicly reachable by definition, so the signature is
 * verified against the raw bytes before anything is acted on.
 */

const crypto = require('crypto');
const catalog = require('./catalog');

const KEYSET_URL = process.env.VITALS_WEBHOOK_KEYSET
  || 'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
const SIGNATURE_HEADER = 'google-health-api-signature';
const KEYSET_TTL_MS = 6 * 3600000;
// Refetch is cheap, but hammering gstatic on every forged request is not.
const KEYSET_MIN_REFETCH_MS = 60000;

// Fetch a little either side of the reported interval: the notification's window is
// the changed data's window, and a session edited at its edge can move a boundary.
const WINDOW_PAD_MS = 10 * 60000;

let keysetCache = { keys: null, fetchedMs: 0 };

// --- minimal protobuf reader (only what a Tink EcdsaPublicKey needs) --------
// Rather than take a dependency for ~40 lines. Reads length-delimited fields.

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error('malformed varint');
}

function protoFields(buf) {
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      out.set(field, v);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      out.set(field, buf.subarray(pos, pos + len));
      pos += len;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

/** EC coordinates arrive big-endian, sometimes with a leading sign byte. */
function coord32(buf) {
  let b = Buffer.from(buf);
  while (b.length > 32 && b[0] === 0) b = b.subarray(1);
  if (b.length > 32) throw new Error('EC coordinate too large');
  if (b.length < 32) b = Buffer.concat([Buffer.alloc(32 - b.length), b]);
  return b;
}

function keyFromTinkEntry(entry) {
  const value = Buffer.from(entry.keyData.value, 'base64');
  const fields = protoFields(value);
  const x = fields.get(3);
  const y = fields.get(4);
  if (!x || !y) throw new Error('EcdsaPublicKey missing coordinates');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: coord32(x).toString('base64url'),
    y: coord32(y).toString('base64url'),
  };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

async function loadKeyset(force = false) {
  const age = Date.now() - keysetCache.fetchedMs;
  if (!force && keysetCache.keys && age < KEYSET_TTL_MS) return keysetCache.keys;
  if (force && age < KEYSET_MIN_REFETCH_MS && keysetCache.keys) return keysetCache.keys;

  const res = await fetch(KEYSET_URL);
  if (!res.ok) throw new Error(`keyset fetch failed: ${res.status}`);
  const json = await res.json();
  const keys = new Map();
  for (const entry of json.key || []) {
    if (entry.status && entry.status !== 'ENABLED') continue;
    try {
      keys.set(Number(entry.keyId), keyFromTinkEntry(entry));
    } catch { /* skip a key we can't parse rather than failing the whole set */ }
  }
  keysetCache = { keys, fetchedMs: Date.now() };
  return keys;
}

/**
 * Verify the signature over the RAW request bytes. Re-serialising the parsed JSON
 * would change byte-for-byte (key order, spacing) and never verify.
 */
async function verifySignature(rawBody, headerValue) {
  if (!headerValue) return { ok: false, reason: 'missing signature header' };
  let sig;
  try { sig = Buffer.from(headerValue, 'base64'); } catch { return { ok: false, reason: 'signature not base64' }; }
  if (sig.length < 8) return { ok: false, reason: 'signature too short' };

  // Tink output prefix: 0x01 + 4-byte big-endian key id, then the signature.
  let keyId = null;
  let raw = sig;
  if (sig[0] === 0x01) {
    keyId = sig.readUInt32BE(1);
    raw = sig.subarray(5);
  }

  let keys;
  try { keys = await loadKeyset(); } catch (err) { return { ok: false, reason: `keyset: ${err.message}` }; }

  let candidates = keyId !== null && keys.has(keyId) ? [keys.get(keyId)] : [...keys.values()];
  if (keyId !== null && !keys.has(keyId)) {
    // Keys rotate every 30 days — an unknown id means our cache is stale, not that
    // the request is forged. Refetch once before rejecting.
    try {
      keys = await loadKeyset(true);
      candidates = keys.has(keyId) ? [keys.get(keyId)] : [...keys.values()];
    } catch { /* fall through with what we have */ }
  }
  if (!candidates.length) return { ok: false, reason: 'no usable verification keys' };

  for (const key of candidates) {
    for (const dsaEncoding of ['der', 'ieee-p1363']) {
      try {
        if (crypto.verify('sha256', rawBody, { key, dsaEncoding }, raw)) return { ok: true };
      } catch { /* try the next encoding/key */ }
    }
  }
  return { ok: false, reason: 'signature did not verify' };
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function secret() {
  return process.env.VITALS_WEBHOOK_SECRET || '';
}

function authorized(req) {
  const s = secret();
  if (!s) return false;
  const got = req.headers.authorization || '';
  return timingSafeEqualStr(got, `Bearer ${s}`);
}

/** notification dataType ("steps", "active_minutes", "body-fat") -> catalog id. */
function resolveType(name) {
  if (!name) return null;
  const direct = catalog.get(name);
  if (direct) return direct;
  const kebab = String(name).replace(/_/g, '-');
  return catalog.get(kebab) || catalog.all().find((t) => t.snake === name) || null;
}

/**
 * Handle one POST. Returns {status, body} — the caller writes the response and only
 * then runs `after` (Google wants 204 immediately; work happens after the socket is
 * answered, and a slow handler means retries and duplicate work).
 */
async function handle(req, rawBody, { onChange, log }) {
  // Auth FIRST — the unauthorized handshake must get a 401 (see header note).
  if (!authorized(req)) {
    return { status: 401, body: { error: 'unauthorized' }, after: null };
  }

  let payload = null;
  try { payload = JSON.parse(rawBody.toString('utf8') || '{}'); } catch {
    return { status: 400, body: { error: 'invalid json' }, after: null };
  }

  // The authorized half of the handshake.
  if (payload && payload.type === 'verification') {
    if (log) log('webhook', null, 'verification handshake accepted');
    return { status: 200, body: { ok: true }, after: null };
  }

  const requireSig = process.env.VITALS_WEBHOOK_REQUIRE_SIGNATURE !== '0';
  const sigHeader = req.headers[SIGNATURE_HEADER];
  const verdict = await verifySignature(rawBody, sigHeader);
  if (!verdict.ok) {
    if (requireSig) {
      if (log) log('warn', null, `webhook rejected: ${verdict.reason}`);
      return { status: 403, body: { error: 'signature verification failed' }, after: null };
    }
    if (log) log('warn', null, `webhook signature unverified (${verdict.reason}) — accepted by config`);
  }

  const data = payload.data || payload;
  const type = resolveType(data.dataType);
  const intervals = Array.isArray(data.intervals) ? data.intervals : [];

  // Answer 204 now; fetch afterwards.
  return {
    status: 204,
    body: null,
    after: async () => {
      if (!type) {
        if (log) log('warn', null, `webhook for unhandled data type "${data.dataType}"`);
        return;
      }
      const windows = [];
      for (const iv of intervals) {
        const t = iv.physicalTimeInterval || iv.interval || iv;
        const start = Date.parse(t.startTime);
        const end = Date.parse(t.endTime || t.startTime);
        if (Number.isFinite(start)) {
          windows.push([start - WINDOW_PAD_MS, (Number.isFinite(end) ? end : start) + WINDOW_PAD_MS]);
        }
      }
      // A DELETE tells us data went away; the same refetch settles it, because the
      // window comes back without the deleted point. (Points removed upstream are
      // not purged locally — deliberate: this store is also the archive.)
      if (!windows.length) windows.push([Date.now() - 86400000, Date.now() + WINDOW_PAD_MS]);
      for (const [from, to] of windows) await onChange(type.id, from, to, data.operation || 'UPSERT');
    },
  };
}

module.exports = { handle, resolveType, secret };
