'use strict';
/**
 * Google OAuth 2.0 — authorization-code flow with a refresh token.
 *
 * THE TWO THINGS THAT BREAK THIS FLOW, both silent:
 *
 * 1. `access_type=offline` + `prompt=consent` are both required to get a refresh
 *    token. Google returns one only on the FIRST consent for a given client+user;
 *    re-authorizing without `prompt=consent` returns an access token and no refresh
 *    token, so the app works for an hour and then can never sync unattended again.
 *
 * 2. While the OAuth app is in "Testing" (which is where a personal, unverified app
 *    lives — see README), refresh tokens are revoked after 7 DAYS. This is not a bug
 *    to fix in code; it is a property of unpublished OAuth clients. The app detects
 *    the resulting `invalid_grant`, marks itself disconnected with an explicit
 *    reason, and asks for one click to reconnect — instead of showing an empty
 *    dashboard and a silent error in a log nobody reads.
 */

const db = require('./db');
const catalog = require('./catalog');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Refresh a minute early — a token that expires mid-request is a 401 for a sync that
// had already spent its quota on the call.
const EXPIRY_SKEW_MS = 60_000;

function config() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    baseUrl: (process.env.VITALS_BASE_URL || 'http://localhost:4330').replace(/\/+$/, ''),
  };
}

function redirectUri() {
  return `${config().baseUrl}/auth/callback`;
}

function configured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

function authUrl(state, typeIds) {
  const c = config();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: catalog.scopesFor(typeIds).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: 'non_json_response', raw: text }; }
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `token endpoint ${res.status}`);
    err.code = json.error || String(res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function exchangeCode(code) {
  const c = config();
  const t = await tokenRequest({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  if (!t.refresh_token) {
    // Worth shouting about: without this the app cannot sync unattended, and the
    // symptom (works now, dead in an hour) points nowhere near the cause.
    await db.addEvent('warn', null, 'Google returned no refresh token — re-consent with prompt=consent');
  }
  await db.putTokens({
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    expiry_ms: Date.now() + (Number(t.expires_in || 3600) * 1000) - EXPIRY_SKEW_MS,
    scope: t.scope || null,
    connected_ms: Date.now(),
  });
  return t;
}

async function refresh() {
  const c = config();
  const stored = await db.getTokens();
  if (!stored || !stored.refresh_token) {
    const e = new Error('not connected');
    e.code = 'not_connected';
    throw e;
  }
  try {
    const t = await tokenRequest({
      refresh_token: stored.refresh_token,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
    });
    await db.putTokens({
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      expiry_ms: Date.now() + (Number(t.expires_in || 3600) * 1000) - EXPIRY_SKEW_MS,
      scope: t.scope || null,
    });
    return t.access_token;
  } catch (err) {
    if (err.code === 'invalid_grant') {
      // Expired (7-day testing-mode window), revoked, or the user removed access.
      await db.setSetting('auth_error', 'invalid_grant');
      await db.addEvent('error', null,
        'Google refused the refresh token (invalid_grant) — reconnect. '
        + 'Unpublished OAuth apps expire refresh tokens after 7 days.');
    }
    throw err;
  }
}

/** A valid access token, refreshing if needed. The only way the rest of the app gets one. */
async function accessToken() {
  const stored = await db.getTokens();
  // The REFRESH token is what "connected" means. An absent or expired access token
  // is a routine state — first call after a restart, or a token that simply aged
  // out — and the answer is to mint a new one, not to declare the app disconnected.
  if (!stored || !stored.refresh_token) {
    const e = new Error('not connected');
    e.code = 'not_connected';
    throw e;
  }
  if (stored.access_token && stored.expiry_ms && Date.now() < stored.expiry_ms) {
    return stored.access_token;
  }
  return refresh();
}

async function connected() {
  const t = await db.getTokens();
  return Boolean(t && t.refresh_token);
}

async function disconnect() {
  const t = await db.getTokens();
  if (t && (t.refresh_token || t.access_token)) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
      });
    } catch { /* revocation is best-effort; local state is what matters */ }
  }
  await db.clearTokens();
  await db.setSetting('auth_error', '');
}

module.exports = {
  config, configured, redirectUri, authUrl,
  exchangeCode, refresh, accessToken, connected, disconnect,
};
