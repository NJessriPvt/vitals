'use strict';
/**
 * vitals — dashboard controller.
 *
 * Two rules shape this file:
 *
 *   ONE FILTER STATE. The row at the top scopes everything below it. Tiles, charts
 *   and tables all read the same {from, to, bucket}, so two numbers on screen can
 *   never disagree about which slice they describe.
 *
 *   COLOUR FOLLOWS THE ENTITY. A metric's colour comes from its position in the
 *   catalog, not from its position in the current selection — so removing a series
 *   from the compare chart never repaints the ones that remain. A reader who learned
 *   "steps is blue" keeps that.
 */

import {
  lineChart, barChart, stackedChart, compareChart, sparkline, tableView, fmtNumber,
} from './charts.js';

const $ = (id) => document.getElementById(id);
const api = (p) => `./api/${p}`;

const state = {
  catalog: null,
  status: null,
  rangeDays: 30,
  from: null,
  to: null,
  bucket: 'auto',
  group: 'all',
  search: '',
  compare: [],
  tables: new Set(),
  charts: new Map(),
  loading: false,
};

// Compare tops out at three lines. Three clears every colour-separation gate
// including the strict all-pairs one, and past three a multi-line chart needs
// direct labels that collide the moment the lines converge.
const COMPARE_MAX = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colorForType(typeId) {
  const i = state.catalog.types.findIndex((t) => t.id === typeId);
  const slot = i < 0 ? 0 : i % 8;
  return getComputedStyle(document.documentElement).getPropertyValue(`--series-${slot + 1}`).trim();
}

/**
 * Map ordered categories onto the single-hue ramp. `--ord-1` is always the step
 * nearest the surface ("least") through `--ord-4` ("most"), in both themes.
 *
 * `reverse` is for scales whose STACK order is the opposite of their MAGNITUDE
 * order — sleep stacks DEEP at the bottom, but deep sleep is the "most" end and has
 * to get the darkest step. More categories than ramp steps reuse the end step
 * rather than inventing a hue.
 */
function ordinalColors(keys, reverse = false) {
  const cs = getComputedStyle(document.documentElement);
  const ramp = [1, 2, 3, 4].map((i) => cs.getPropertyValue(`--ord-${i}`).trim());
  const out = {};
  keys.forEach((k, i) => {
    const slot = reverse ? (keys.length - 1 - i) : i;
    out[k] = ramp[Math.min(Math.max(slot, 0), ramp.length - 1)];
  });
  return out;
}

function autoBucket(from, to) {
  const days = (to - from) / 86400000;
  if (days <= 2) return '5min';
  if (days <= 14) return 'hour';
  if (days <= 120) return 'day';
  return 'week';
}

function currentRange() {
  if (state.rangeDays === 'custom' && state.from && state.to) {
    return { from: state.from, to: state.to };
  }
  // Snap to local day boundaries. "Last 30 days" measured from this instant makes
  // the first and last buckets partial, which quietly drags every daily average
  // down and puts a stub bar at each end of the chart.
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const to = end.getTime() + 86400000;
  return { from: to - Number(state.rangeDays) * 86400000, to };
}

function currentBucket(from, to) {
  return state.bucket === 'auto' ? autoBucket(from, to) : state.bucket;
}

function tzOffsetMs() {
  // Negative of getTimezoneOffset: the amount to ADD to UTC to get local time.
  return -new Date().getTimezoneOffset() * 60000;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---------------------------------------------------------------------------
// Setup panel
// ---------------------------------------------------------------------------

function renderSetup() {
  const s = state.status;
  const panel = $('setup');
  const body = $('setup-body');
  const title = $('setup-title');

  if (s.connected && !s.authError) {
    panel.hidden = Boolean(!s.demo);
    if (s.demo) {
      title.textContent = 'Demo data is loaded';
      body.replaceChildren(el('p', 'This dashboard is showing generated data, not your own. '
        + 'Clear it once your real sync has run.'));
      body.appendChild(actions([
        ['Clear demo data', 'btn', async () => { await fetch(api('demo'), { method: 'DELETE' }); await refreshAll(); }],
      ]));
    }
    return;
  }

  panel.hidden = false;
  title.textContent = s.connected ? 'Reconnect Google Health' : 'Connect Google Health';
  body.replaceChildren();

  if (s.authError === 'invalid_grant') {
    body.appendChild(notice('warn', 'Google refused the stored refresh token. '
      + 'Unpublished OAuth apps expire refresh tokens after 7 days — reconnecting fixes it. '
      + 'Publishing the app (Testing → In production) stops it recurring.'));
  }

  if (!s.configured) {
    const ol = document.createElement('ol');
    const steps = [
      ['Create a Google Cloud project and enable the <b>Google Health API</b> on it.', null],
      ['Configure the OAuth consent screen (External), and add your own Google account under <b>Test users</b>.', null],
      ['Create an <b>OAuth 2.0 Web application</b> client and add this exact redirect URI:', s.redirectUri],
      ['Put the client id and secret in the environment and restart:', 'GOOGLE_CLIENT_ID=…  GOOGLE_CLIENT_SECRET=…'],
    ];
    for (const [html, code] of steps) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.innerHTML = html; // static, authored here — no user or API data
      li.appendChild(span);
      if (code) {
        li.appendChild(document.createElement('br'));
        const c = document.createElement('code');
        c.textContent = code;
        li.appendChild(c);
      }
      ol.appendChild(li);
    }
    body.appendChild(ol);
    body.appendChild(notice('warn', 'Access note: Google closed new Fitbit Web API signups in May 2024, '
      + 'and the Google Health API is its successor. If your Cloud project cannot enable the API, '
      + 'that is an access decision on Google\'s side, not a bug here — the demo data below still '
      + 'exercises the whole pipeline.'));
  }

  const buttons = [];
  if (s.configured) buttons.push(['Connect Google', 'btn btn-primary', () => { window.location.href = './auth/start'; }]);
  if (!s.demo) buttons.push(['Load demo data', 'btn', async () => { await postJson(api('demo'), { days: 180 }); await refreshAll(); }]);
  if (s.connected) buttons.push(['Disconnect', 'btn', async () => { await postJson('./auth/disconnect'); await refreshAll(); }]);
  body.appendChild(actions(buttons));
}

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function notice(kind, text) {
  const d = el('div', null, `notice notice-${kind === 'warn' ? 'warn' : 'bad'}`);
  d.appendChild(el('span', kind === 'warn' ? '!' : '×', 'notice-icon'));
  d.appendChild(el('span', text));
  return d;
}

function actions(list) {
  const wrap = el('div', null, 'setup-actions');
  for (const [label, cls, fn] of list) {
    const b = el('button', label, cls);
    b.type = 'button';
    b.addEventListener('click', () => Promise.resolve(fn()).catch((e) => alert(e.message)));
    wrap.appendChild(b);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function renderTiles(tiles) {
  const host = $('tiles');
  host.replaceChildren();
  if (!tiles.length) {
    host.appendChild(el('p', 'No data yet for this range.', 'card-sub'));
    return;
  }
  for (const t of tiles) {
    const card = el('div', null, 'tile');
    card.appendChild(el('div', t.label, 'tile-label'));

    const value = el('div', null, 'tile-value');
    // Tiles compact (12.9K); tooltips and tables stay exact.
    value.appendChild(document.createTextNode(fmtNumber(t.value, t.precision, true)));
    value.appendChild(el('span', ` ${t.unit}`, 'tile-unit'));
    card.appendChild(value);

    const meta = el('div', null, 'tile-meta');
    if (t.delta !== null && Number.isFinite(t.delta)) {
      const up = t.delta > 0.5;
      const down = t.delta < -0.5;
      const good = up ? t.upIsGood : down ? !t.upIsGood : null;
      const cls = good === null ? 'flat' : good ? 'up' : 'down';
      // The arrow is a second channel so direction never rests on colour alone.
      const arrow = up ? '↑' : down ? '↓' : '→';
      meta.appendChild(el('span', `${arrow} ${Math.abs(t.delta).toFixed(1)}%`, `tile-delta ${cls}`));
    }
    meta.appendChild(el('span', t.mode));
    card.appendChild(meta);

    const spark = el('div', null, 'tile-spark');
    card.appendChild(spark);
    host.appendChild(card);
    sparkline(spark, t.spark, colorForType(t.type));
  }
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function visibleTypes() {
  const withData = new Set((state.status.stats || []).filter((s) => s.points > 0).map((s) => s.data_type));
  const q = state.search.trim().toLowerCase();
  return state.catalog.types.filter((t) => {
    if (!withData.has(t.id)) return false;
    if (state.group !== 'all' && t.group !== state.group) return false;
    if (q && !(`${t.label} ${t.group} ${t.id}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function chartCard(type, payload, bucketMs) {
  const card = el('section', null, 'card');

  const head = el('div', null, 'card-head');
  const left = el('div');
  left.appendChild(el('h2', type.label));
  const modeWord = { sum: 'total', avg: 'average', last: 'latest', max: 'peak' }[type.agg] || type.agg;
  left.appendChild(el('p', `${bucketLabel(bucketMs)} ${modeWord} · ${type.unit}`, 'card-sub'));
  head.appendChild(left);

  const acts = el('div', null, 'card-actions');
  const showing = state.tables.has(type.id);
  const toggle = el('button', showing ? 'Chart' : 'Table', 'btn btn-quiet');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    if (showing) state.tables.delete(type.id); else state.tables.add(type.id);
    render();
  });
  acts.appendChild(toggle);
  head.appendChild(acts);
  card.appendChild(head);

  const spec = { ...payload, label: type.label, bucketMs, precision: type.precision };

  // A legend is present whenever there are two or more series; a single-series
  // chart doesn't get one, because the card title already names what is plotted.
  if (payload.chart === 'stacked') {
    spec.colors = ordinalColors(payload.keys, payload.rampReverse);
    const legend = el('div', null, 'legend');
    for (const k of payload.keys) {
      const item = el('div', null, 'legend-item');
      const sw = el('span', null, 'legend-swatch');
      sw.style.background = spec.colors[k];
      item.appendChild(sw);
      item.appendChild(el('span', payload.labels[k] || k));
      legend.appendChild(item);
    }
    card.appendChild(legend);
  }

  const body = el('div', null, state.tables.has(type.id) ? 'table-wrap' : 'chart');
  card.appendChild(body);

  requestAnimationFrame(() => {
    if (state.tables.has(type.id)) { tableView(body, spec); return; }
    const color = colorForType(type.id);
    let handle;
    if (payload.chart === 'stacked') handle = stackedChart(body, spec);
    else if (payload.chart === 'bar') handle = barChart(body, { ...spec, color });
    // No area fill on a diverging metric: the fill would run from the value down to
    // the axis floor, so a −0.4 °C reading paints a large block that reads as "a lot
    // of something" instead of "slightly below normal".
    else handle = lineChart(body, { ...spec, color, area: !spec.band && !spec.diverging });
    state.charts.set(type.id, handle);
  });

  return card;
}

function bucketLabel(ms) {
  if (ms === 0) return 'Raw';
  if (ms < 3600000) return `${ms / 60000}-minute`;
  if (ms === 3600000) return 'Hourly';
  if (ms === 86400000) return 'Daily';
  if (ms === 604800000) return 'Weekly';
  return '';
}

function renderComparePicker() {
  const host = $('compare-picker');
  host.replaceChildren();
  const candidates = state.catalog.types.filter((t) => t.primary && t.chart !== 'stacked');
  for (const t of candidates) {
    const on = state.compare.includes(t.id);
    const chip = el('button', null, 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(on));
    const dot = el('span', null, 'chip-dot');
    if (on) dot.style.background = colorForType(t.id);
    chip.append(dot, document.createTextNode(t.label));
    chip.addEventListener('click', () => {
      if (on) state.compare = state.compare.filter((x) => x !== t.id);
      else if (state.compare.length < COMPARE_MAX) state.compare = [...state.compare, t.id];
      else return;
      render();
    });
    if (!on && state.compare.length >= COMPARE_MAX) chip.disabled = true;
    host.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let renderToken = 0;

async function render() {
  const mine = ++renderToken;
  const { from, to } = currentRange();
  const bucket = currentBucket(from, to);
  const tz = tzOffsetMs();

  $('range-label').textContent = `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`
    + ` · ${bucketLabel({ raw: 0, '5min': 300000, hour: 3600000, day: 86400000, week: 604800000 }[bucket] || 86400000).toLowerCase()}`;

  renderComparePicker();

  const types = visibleTypes();
  const wanted = [...new Set([...state.compare, ...types.map((t) => t.id)])];

  document.querySelector('main').classList.add('loading');
  let summary;
  let series;
  try {
    [summary, series] = await Promise.all([
      getJson(`${api('summary')}?from=${from}&to=${to}&tz=${tz}`),
      wanted.length
        ? getJson(`${api('series')}?type=${wanted.join(',')}&from=${from}&to=${to}&bucket=${bucket}&tz=${tz}`)
        : Promise.resolve({ series: [] }),
    ]);
  } catch (err) {
    document.querySelector('main').classList.remove('loading');
    $('log-sub').textContent = err.message;
    return;
  }
  if (mine !== renderToken) return; // a newer render already started
  document.querySelector('main').classList.remove('loading');

  renderTiles(summary.tiles);

  const byType = new Map(series.series.map((s) => [s.type, s]));
  const bucketMs = series.bucketMs ?? 86400000;

  // Compare
  const cmp = state.compare
    .map((id) => {
      const t = state.catalog.types.find((x) => x.id === id);
      const payload = byType.get(id);
      if (!t || !payload) return null;
      return {
        label: t.label, unit: t.unit, precision: t.precision,
        color: colorForType(id), points: payload.points,
      };
    })
    .filter(Boolean);

  const legend = $('compare-legend');
  legend.replaceChildren();
  for (const s of cmp) {
    const item = el('div', null, 'legend-item');
    const line = el('span', null, 'legend-line');
    line.style.background = s.color;
    item.appendChild(line);
    item.appendChild(el('span', `${s.label} (${s.unit})`));
    legend.appendChild(item);
  }
  if (cmp.length) compareChart($('compare-chart'), cmp, { bucketMs });
  else {
    $('compare-chart').replaceChildren(
      el('div', `Pick up to ${COMPARE_MAX} metrics to overlay.`, 'chart-empty'),
    );
    $('compare-chart').firstChild.style.height = '120px';
  }

  // Per-metric cards
  const grid = $('charts');
  grid.replaceChildren();
  state.charts.clear();
  for (const t of types) {
    const payload = byType.get(t.id);
    if (!payload || !payload.points.length) continue;
    grid.appendChild(chartCard(t, payload, bucketMs));
  }
  if (!grid.children.length) {
    grid.appendChild(el('p', 'Nothing matches this filter yet.', 'card-sub'));
  }
}

function renderStatus() {
  const s = state.status;
  const pulse = document.querySelector('.pulse');
  const label = $('sync-state');

  pulse.classList.toggle('live', Boolean(s.sync.running && (s.connected || s.demo)));
  if (s.demo && !s.connected) label.textContent = 'demo data';
  else if (!s.connected) label.textContent = 'not connected';
  else if (s.sync.phase === 'tail') label.textContent = 'syncing…';
  else if (s.sync.phase === 'backfill') label.textContent = 'backfilling…';
  else if (s.sync.lastTailMs) label.textContent = `synced ${ago(s.sync.lastTailMs)}`;
  else label.textContent = 'idle';

  $('btn-sync').disabled = !s.connected;

  const total = (s.stats || []).reduce((a, x) => a + x.points, 0);
  $('log-sub').textContent = `${total.toLocaleString()} points stored`
    + (s.webhook.configured ? ' · webhook armed' : ' · polling only');

  const log = $('log');
  log.replaceChildren();
  for (const e of s.events || []) {
    const li = document.createElement('li');
    li.appendChild(el('span', new Date(e.ts_ms).toLocaleTimeString(), 'log-time'));
    li.appendChild(el('span', e.kind, `log-kind ${e.kind}`));
    li.appendChild(el('span', `${e.data_type ? `${e.data_type}: ` : ''}${e.message || ''}`, 'log-msg'));
    log.appendChild(li);
  }
  renderSetup();
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function refreshStatus() {
  state.status = await getJson(api('status'));
  renderStatus();
}

async function refreshAll() {
  await refreshStatus();
  await render();
}

function initTheme() {
  const saved = localStorage.getItem('vitals-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('btn-theme').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme;
    const next = now === 'dark' ? 'light' : now === 'light' ? '' : 'dark';
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem('vitals-theme', next);
    render(); // charts read their colours from CSS tokens at draw time
  });
}

function initFilters() {
  const groupSel = $('f-group');
  for (const g of state.catalog.groups) {
    const opt = document.createElement('option');
    opt.value = g.name;
    opt.textContent = g.name;
    groupSel.appendChild(opt);
  }

  $('f-range').addEventListener('change', (e) => {
    state.rangeDays = e.target.value === 'custom' ? 'custom' : Number(e.target.value);
    $('custom-range').hidden = e.target.value !== 'custom';
    if (state.rangeDays === 'custom' && !state.from) {
      const to = Date.now();
      const from = to - 30 * 86400000;
      $('f-from').value = new Date(from).toISOString().slice(0, 10);
      $('f-to').value = new Date(to).toISOString().slice(0, 10);
      state.from = from;
      state.to = to;
    }
    render();
  });

  const readCustom = () => {
    const f = $('f-from').value;
    const t = $('f-to').value;
    if (!f || !t) return;
    state.from = new Date(`${f}T00:00:00`).getTime();
    // Inclusive end date: a range that says "to the 14th" must include the 14th.
    state.to = new Date(`${t}T00:00:00`).getTime() + 86400000;
    render();
  };
  $('f-from').addEventListener('change', readCustom);
  $('f-to').addEventListener('change', readCustom);

  $('f-bucket').addEventListener('change', (e) => { state.bucket = e.target.value; render(); });
  $('f-group').addEventListener('change', (e) => { state.group = e.target.value; render(); });

  let searchTimer;
  $('f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value; render(); }, 180);
  });

  $('btn-sync').addEventListener('click', async () => {
    const btn = $('btn-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try { await postJson(api('sync')); await refreshAll(); } catch (e) { alert(e.message); } finally {
      btn.textContent = 'Sync now';
      btn.disabled = false;
    }
  });

  $('setup-toggle').addEventListener('click', () => {
    const body = $('setup-body');
    body.hidden = !body.hidden;
    $('setup-toggle').textContent = body.hidden ? 'Show' : 'Hide';
  });
}

function initStream() {
  const es = new EventSource(api('stream'));
  let timer = null;
  es.addEventListener('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.data); } catch { return; }
    // Coalesce: a tail pass emits an event per data type and each one would
    // otherwise trigger a full reload.
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (evt.count) refreshAll();
      else refreshStatus();
    }, 1200);
  });
}

function initResize() {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 200);
  });
}

async function boot() {
  initTheme();
  state.catalog = await getJson(api('catalog'));
  state.status = await getJson(api('status'));
  // Open on the three metrics that answer "how am I doing" without configuration.
  state.compare = ['steps', 'daily-resting-heart-rate', 'sleep']
    .filter((id) => state.catalog.types.some((t) => t.id === id && t.chart !== 'stacked'))
    .slice(0, COMPARE_MAX);
  if (state.compare.length < COMPARE_MAX) {
    for (const t of state.catalog.types) {
      if (state.compare.length >= COMPARE_MAX) break;
      if (t.primary && t.chart !== 'stacked' && !state.compare.includes(t.id)) state.compare.push(t.id);
    }
  }
  initFilters();
  initResize();
  initStream();
  renderStatus();
  await render();
  setInterval(refreshStatus, 30000);
}

boot().catch((err) => {
  document.body.appendChild(el('p', `Failed to start: ${err.message}`, 'card-sub'));
});
