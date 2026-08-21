'use strict';
/**
 * Chart engine — hand-rolled SVG, no library.
 *
 * The specs below are not taste, they are the fixed part of the house data-viz
 * method, and each one is here because the alternative is a known failure:
 *
 *   - Marks are thin: bars cap at 24px, lines are 2px, markers >= 8px.
 *   - Touching fills are separated by a 2px gap IN THE SURFACE COLOUR, never by a
 *     stroke around the mark (a stroke adds data-weight ink that isn't data).
 *   - Overlapping dots carry a 2px surface ring for the same reason.
 *   - Gridlines are solid hairlines one step off the surface. Never dashed —
 *     dashing reads as "threshold" when it is just a grid.
 *   - Ordered scales (sleep stages, heart-rate zones) use a single-hue ORDINAL ramp,
 *     never four categorical hues: those categories have a natural order, and
 *     spending identity colours on them says "unrelated things" about depth of sleep.
 *   - Labels are selective. A number on every point is chaos and goes unread, so
 *     only the last point is labelled and the axis + tooltip carry the rest.
 *   - Text never wears the series colour; identity comes from the mark beside it.
 *   - The container height includes the x-axis band, or the card grows a nested
 *     scrollbar that clips the axis.
 *
 * All labels go in via textContent — series names and category keys come from an
 * API response and are untrusted.
 */

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

function tokens(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const get = (n) => cs.getPropertyValue(n).trim();
  return {
    // The surface colour is what the 2px gaps and rings are PAINTED IN, so it has to
    // be the real panel colour — a stale name here resolves to '' and every gap
    // silently disappears.
    surface: get('--surface'),
    text: get('--text'),
    secondary: get('--text-2'),
    muted: get('--muted'),
    grid: get('--grid'),
    axis: get('--axis'),
    series: [1, 2, 3, 4, 5, 6].map((i) => get(`--series-${i}`)),
    ordinal: [1, 2, 3, 4, 5, 6].map((i) => get(`--ord-${i}`)),
    deemph: get('--surface-3'),
  };
}

// --- scales & ticks ---------------------------------------------------------

function niceStep(raw) {
  const exp = Math.floor(Math.log10(raw));
  const frac = raw / 10 ** exp;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

/** Round y-axis ticks to clean numbers — they carry the values not directly labelled. */
function yTicks(min, max, count = 4, nonNegative = false) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], lo: 0, hi: 1 };
  if (min === max) {
    // An all-zero day (no cardio load yet this morning) otherwise pads to ±1 and
    // draws an axis from -1 to 1 — inventing negative load, which cannot exist.
    if (nonNegative || min === 0) { min = 0; max = max === 0 ? 1 : max * 1.1; } else {
      const pad = Math.abs(min) * 0.1;
      min -= pad; max += pad;
    }
  }
  if (nonNegative && min > 0) min = 0;
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { ticks, lo, hi };
}

/**
 * Exact by default. Compaction is opt-in because it is only ever right in two
 * places — a stat tile's headline and a crowded axis — and is wrong everywhere a
 * reader went looking for the number: "11.7K" is not an answer to "how many steps".
 */
function fmtNumber(v, precision = 0, compact = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (compact && abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (compact && abs >= 10000) return `${(v / 1000).toFixed(1)}K`;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  });
}

function fmtTime(ms, bucketMs) {
  const d = new Date(ms);
  if (bucketMs === 0 || bucketMs < 3600000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (bucketMs < 86400000) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
  if (bucketMs >= 604800000) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtTimeFull(ms, bucketMs) {
  const d = new Date(ms);
  if (bucketMs >= 86400000) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// --- tooltip ----------------------------------------------------------------

/**
 * Contiguous runs of indices that have a value, given the FULL bucket list.
 * Everything downstream positions by index into that full list, so a gap keeps its
 * width on the x-axis instead of being closed up.
 */
function segments(pts, accessor) {
  const out = [];
  let cur = [];
  pts.forEach((p, i) => {
    const v = accessor(p);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (cur.length) { out.push(cur); cur = []; }
    } else {
      cur.push(i);
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

function makeTooltip(host) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  host.appendChild(tip);
  return {
    node: tip,
    show(x, y, rows, title) {
      tip.replaceChildren();
      const h = document.createElement('div');
      h.className = 'tip-title';
      h.textContent = title;
      tip.appendChild(h);
      for (const r of rows) {
        const line = document.createElement('div');
        line.className = 'tip-row';
        if (r.color) {
          // A short stroke keys the series. At tooltip density a filled box is
          // data-weight ink doing a label's job.
          const key = document.createElement('span');
          key.className = 'tip-key';
          key.style.background = r.color;
          line.appendChild(key);
        }
        const val = document.createElement('span');
        val.className = 'tip-value';
        val.textContent = r.value;
        const lab = document.createElement('span');
        lab.className = 'tip-label';
        lab.textContent = r.label;
        // Values lead, labels follow — the reader has the series and wants the number.
        line.append(val, lab);
        tip.appendChild(line);
      }
      tip.hidden = false;
      const hostRect = host.getBoundingClientRect();
      const w = tip.offsetWidth;
      let left = x + 14;
      if (left + w > hostRect.width) left = x - w - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// --- shared frame -----------------------------------------------------------

const PAD = { top: 14, right: 16, bottom: 26, left: 46 };

function frame(host, height) {
  host.replaceChildren();
  const width = Math.max(240, host.clientWidth || 600);
  const svg = el('svg', {
    width: '100%', height, viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none', role: 'img',
  });
  host.appendChild(svg);
  return { svg, width, height, plotW: width - PAD.left - PAD.right, plotH: height - PAD.top - PAD.bottom };
}

/**
 * Decimals come from the TICK STEP, not from the metric's display precision.
 * A resting heart rate of 56–58 gets a 0.5 step, and rendering that at the metric's
 * 0 decimals prints the axis as "58, 58, 57, 57, 56" — two pairs of identical
 * labels at different heights, which reads as a rendering bug.
 */
function tickDecimals(ticks) {
  if (ticks.length < 2) return 0;
  const step = Math.abs(ticks[1] - ticks[0]);
  if (!step) return 0;
  // Enough decimals to write the STEP exactly. A 2.5-hour step at zero decimals
  // prints "0, 3, 5, 8, 10" — evenly spaced gridlines wearing unevenly spaced
  // numbers, which is worse than a decimal place.
  for (let d = 0; d <= 4; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 4;
}

function drawGrid(svg, t, ticks, yOf, width, precision) {
  const g = el('g');
  // ONE unit for the whole axis, chosen from the largest tick. Deciding per tick
  // puts "5,000" directly under "10.0K" on the same scale, which reads as two
  // different units stacked on one axis.
  const maxAbs = Math.max(...ticks.map((v) => Math.abs(v)));
  const unit = maxAbs >= 1e6 ? { div: 1e6, suffix: 'M' }
    : maxAbs >= 10000 ? { div: 1000, suffix: 'K' }
      : { div: 1, suffix: '' };
  const scaledTicks = ticks.map((v) => v / unit.div);
  const decimals = tickDecimals(scaledTicks);
  for (const tick of ticks) {
    const y = yOf(tick);
    g.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
      stroke: t.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
    const label = el('text', {
      x: PAD.left - 8, y: y + 4, 'text-anchor': 'end',
      fill: t.muted, 'font-size': 11, class: 'tick',
    });
    // Zero keeps no suffix — "0K" is noise.
    label.textContent = tick === 0
      ? '0'
      : `${fmtNumber(tick / unit.div, decimals)}${unit.suffix}`;
    g.appendChild(label);
  }
  svg.appendChild(g);
}

function drawXAxis(svg, t, points, xOf, bucketMs, plotH) {
  const g = el('g');
  // When the whole series sits inside about a day, the date is the same on every
  // tick and repeating it four times is noise that crowds out the time.
  const span = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
  const sameDay = span > 0 && span <= 36 * 3600000;
  g.appendChild(el('line', {
    x1: PAD.left, x2: PAD.left + (svg.viewBox.baseVal.width - PAD.left - PAD.right),
    y1: PAD.top + plotH, y2: PAD.top + plotH,
    stroke: t.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
  }));
  const MIN_GAP = 78;
  const maxLabels = Math.max(2, Math.floor((svg.viewBox.baseVal.width - PAD.left - PAD.right) / MIN_GAP));
  const stride = Math.max(1, Math.ceil(points.length / maxLabels));
  let lastX = -Infinity;
  points.forEach((p, i) => {
    const isLast = i === points.length - 1;
    if (i % stride !== 0 && !isLast) return;
    // The final tick is always wanted, but forcing it on top of the previous one
    // renders two dates overlapping into an unreadable smear at the right edge.
    if (xOf(i) - lastX < MIN_GAP) {
      if (!isLast) return;
      const prev = g.lastChild;
      if (prev) g.removeChild(prev);
    }
    lastX = xOf(i);
    const label = el('text', {
      x: xOf(i), y: PAD.top + plotH + 16, 'text-anchor': 'middle',
      fill: t.muted, 'font-size': 11, class: 'tick',
    });
    label.textContent = sameDay
      ? new Date(p.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : fmtTime(p.t, bucketMs);
    g.appendChild(label);
  });
  svg.appendChild(g);
}

// --- line chart -------------------------------------------------------------

/**
 * spec: { points:[{t,v,lo,hi}], unit, precision, bucketMs, band, goal, label }
 * A single series needs no legend box — the card title already names it.
 */
export function lineChart(host, spec, height = 220) {
  const t = tokens();
  // Keep EVERY bucket, gaps included. Filtering the empties out first and then
  // positioning by array index is what silently redraws a nine-day gap and a
  // one-day gap as the same distance.
  const pts = spec.points;
  const runs = segments(pts, (p) => p.v);
  if (!runs.length) return empty(host, height);
  // connectGaps joins the runs into one path while KEEPING each point's real index,
  // so the line spans the empty days without the x-axis lying about their spacing.
  const segs = spec.connectGaps ? [runs.flat()] : runs;

  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
  const values = pts.map((p) => p.v).filter(has);
  const showBand = spec.band && pts.some((p) => has(p.lo) && p.hi !== p.lo);
  const lows = showBand ? pts.map((p) => p.lo).filter(has) : [];
  const highs = showBand ? pts.map((p) => p.hi).filter(has) : [];
  const ref = spec.refBand && has(spec.refBand.p10) && has(spec.refBand.p90)
    ? [spec.refBand.p10, spec.refBand.p90] : [];
  const min = Math.min(...values, ...lows, ...ref, ...(spec.goal ? [spec.goal] : []));
  const max = Math.max(...values, ...highs, ...ref, ...(spec.goal ? [spec.goal] : []));
  const { ticks, lo, hi } = yTicks(min, max);

  const xOf = (i) => PAD.left + (pts.length === 1 ? spec0(width) : (i / (pts.length - 1)) * (width - PAD.left - PAD.right));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  drawGrid(svg, t, ticks, yOf, width, spec.precision);

  const color = spec.color || t.series[0];

  // The personal-range layer: your own p10–p90 shaded behind the line with the
  // median as a hairline. This is the shared visual language for "is this normal
  // FOR ME" — the value is only meaningful relative to it.
  if (ref.length) {
    svg.appendChild(el('rect', {
      x: PAD.left, y: yOf(spec.refBand.p90),
      width: width - PAD.left - PAD.right,
      height: Math.max(1, yOf(spec.refBand.p10) - yOf(spec.refBand.p90)),
      fill: color, 'fill-opacity': 0.07,
    }));
    if (has(spec.refBand.median)) {
      svg.appendChild(el('line', {
        x1: PAD.left, x2: width - PAD.right,
        y1: yOf(spec.refBand.median), y2: yOf(spec.refBand.median),
        stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.35, 'shape-rendering': 'crispEdges',
      }));
    }
  }

  // The min–max band: on a bucketed average this is the range inside each bucket,
  // and without it an "average heart rate of 71" hides a 48–160 day. Drawn per
  // contiguous run so a gap stays a gap instead of being bridged by a fill.
  if (showBand) {
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const up = seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i].hi)}`).join('');
      const down = seg.slice().reverse().map((i) => `L${xOf(i)},${yOf(pts[i].lo)}`).join('');
      svg.appendChild(el('path', { d: `${up}${down}Z`, fill: color, 'fill-opacity': 0.1, stroke: 'none' }));
    }
  } else if (spec.area) {
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const line = seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i].v)}`).join('');
      svg.appendChild(el('path', {
        d: `${line}L${xOf(seg[seg.length - 1])},${yOf(lo)}L${xOf(seg[0])},${yOf(lo)}Z`,
        fill: color, 'fill-opacity': 0.1, stroke: 'none',
      }));
    }
  }

  if (spec.goal) {
    const y = yOf(spec.goal);
    svg.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
      stroke: t.muted, 'stroke-width': 1, 'stroke-opacity': 0.7, 'shape-rendering': 'crispEdges',
    }));
  }

  // On a diverging metric zero is the whole point — it is the "nothing" the values
  // are above or below — so it gets the axis weight rather than a gridline's.
  if (spec.diverging && lo < 0 && hi > 0) {
    svg.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: yOf(0), y2: yOf(0),
      stroke: t.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
  }

  // One path per contiguous run: a line that jumps a gap asserts data that isn't
  // there. A run of exactly one point has no line to draw, so it gets a dot.
  for (const seg of segs) {
    if (seg.length === 1) {
      svg.appendChild(el('circle', {
        cx: xOf(seg[0]), cy: yOf(pts[seg[0]].v), r: 3,
        fill: color, stroke: t.surface, 'stroke-width': 2,
      }));
      continue;
    }
    svg.appendChild(el('path', {
      d: seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i].v)}`).join(''),
      fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // End marker on the last point that HAS a value — a trailing empty bucket must
  // not drag the marker down to the axis.
  const lastSeg = segs[segs.length - 1];
  const lastI = lastSeg[lastSeg.length - 1];
  svg.appendChild(el('circle', {
    cx: xOf(lastI), cy: yOf(pts[lastI].v), r: 4.5,
    fill: color, stroke: t.surface, 'stroke-width': 2,
  }));

  drawXAxis(svg, t, pts, xOf, spec.bucketMs, plotH);

  // Crosshair: readers aim at a date, never at a 2px line.
  const hair = el('line', {
    y1: PAD.top, y2: PAD.top + plotH, stroke: t.axis, 'stroke-width': 1,
    'shape-rendering': 'crispEdges', opacity: 0,
  });
  const focus = el('circle', { r: 5, fill: color, stroke: t.surface, 'stroke-width': 2, opacity: 0 });
  svg.append(hair, focus);

  const overlay = el('rect', {
    x: PAD.left, y: PAD.top, width: Math.max(1, width - PAD.left - PAD.right), height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.appendChild(overlay);

  const at = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((clientX - rect.left) / rect.width) * width;
    const ratio = (rel - PAD.left) / Math.max(1, width - PAD.left - PAD.right);
    return Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))));
  };

  // Snap to the nearest bucket that HAS data. Landing the crosshair on an empty
  // bucket and showing "—" is a dead spot the reader has to hunt around.
  const dataIdx = segs.flat();
  const nearestWithData = (i) => dataIdx.reduce(
    (best, j) => (Math.abs(j - i) < Math.abs(best - i) ? j : best), dataIdx[0],
  );

  const move = (clientX) => {
    const i = nearestWithData(at(clientX));
    const p = pts[i];
    const x = xOf(i);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('opacity', 1);
    focus.setAttribute('cx', x); focus.setAttribute('cy', yOf(p.v)); focus.setAttribute('opacity', 1);
    const rows = [{ color, value: `${fmtNumber(p.v, spec.precision)} ${spec.unit}`, label: spec.label || '' }];
    if (showBand && p.lo !== p.hi) {
      rows.push({ value: `${fmtNumber(p.lo, spec.precision)}–${fmtNumber(p.hi, spec.precision)}`, label: 'range' });
    }
    const rect = svg.getBoundingClientRect();
    tip.show((x / width) * rect.width, (yOf(p.v) / height) * rect.height, rows, fmtTimeFull(p.t, spec.bucketMs));
  };

  overlay.addEventListener('pointermove', (e) => move(e.clientX));
  overlay.addEventListener('pointerleave', () => {
    tip.hide(); hair.setAttribute('opacity', 0); focus.setAttribute('opacity', 0);
  });
  return { redraw: () => lineChart(host, spec, height) };
}

function spec0(width) { return (width - PAD.left - PAD.right) / 2; }

// --- bar chart --------------------------------------------------------------

/** Columns: <=24px, 4px rounded cap, square at the baseline, 2px gaps. */
export function barChart(host, spec, height = 220) {
  const t = tokens();
  // Same rule as the line chart: every bucket keeps its slot, so three workouts
  // nine days apart are not drawn as three consecutive days.
  const pts = spec.points;
  const values = pts.map((p) => p.v).filter((v) => v !== null && Number.isFinite(v));
  if (!values.length) return empty(host, height);

  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  const { ticks, lo, hi } = yTicks(Math.min(0, ...values), Math.max(...values, spec.goal || 0), 4, values.every((v) => v >= 0));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  drawGrid(svg, t, ticks, yOf, width, spec.precision);

  const band = (width - PAD.left - PAD.right) / pts.length;
  const barW = Math.min(24, Math.max(1, band - 2)); // the 2px is the surface gap
  const xOf = (i) => PAD.left + band * i + band / 2;
  const color = spec.color || t.series[0];
  const zeroY = yOf(Math.max(lo, 0));

  if (spec.goal) {
    const y = yOf(spec.goal);
    svg.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
      stroke: t.muted, 'stroke-width': 1, 'stroke-opacity': 0.7, 'shape-rendering': 'crispEdges',
    }));
  }

  const bars = el('g');
  pts.forEach((p, i) => {
    // An empty bucket draws nothing. Drawing a zero-height bar would claim the
    // metric was measured and came out at zero.
    if (p.v === null || !Number.isFinite(p.v)) return;
    const y = yOf(p.v);
    const h = Math.abs(zeroY - y);
    const r = Math.min(4, h / 2, barW / 2); // rounded data-end, square at the baseline
    const x = xOf(i) - barW / 2;
    const top = Math.min(y, zeroY);
    const d = p.v >= 0
      ? `M${x},${top + h} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${top + h} Z`
      : `M${x},${top} L${x},${top + h - r} Q${x},${top + h} ${x + r},${top + h} L${x + barW - r},${top + h} Q${x + barW},${top + h} ${x + barW},${top + h - r} L${x + barW},${top} Z`;
    const bar = el('path', { d, fill: color });
    bars.appendChild(bar);

    // The hit target is the whole column, not the painted bar — a 3px-tall bar on a
    // rest day is otherwise unhoverable.
    const hit = el('rect', {
      x: PAD.left + band * i, y: PAD.top, width: band, height: plotH, fill: 'transparent',
    });
    const showTip = () => {
      bar.setAttribute('fill-opacity', 0.78);
      const rect = svg.getBoundingClientRect();
      tip.show((xOf(i) / width) * rect.width, (Math.min(y, zeroY) / height) * rect.height,
        [{ color, value: `${fmtNumber(p.v, spec.precision)} ${spec.unit}`, label: spec.label || '' }],
        fmtTimeFull(p.t, spec.bucketMs));
    };
    hit.addEventListener('pointerenter', showTip);
    hit.addEventListener('pointermove', showTip);
    hit.addEventListener('pointerleave', () => { bar.removeAttribute('fill-opacity'); tip.hide(); });
    bars.appendChild(hit);
  });
  svg.appendChild(bars);
  drawXAxis(svg, t, pts, xOf, spec.bucketMs, plotH);
  return { redraw: () => barChart(host, spec, height) };
}

// --- stacked bar ------------------------------------------------------------

/**
 * spec: { points:[{t,parts:{KEY:value}}], keys:[...], labels:{KEY:label} }
 * Ordered categories, so the fills come from the ORDINAL ramp (single hue,
 * light -> dark) and never from categorical slots.
 */
export function stackedChart(host, spec, height = 220) {
  const t = tokens();
  const pts = spec.points;
  if (!pts.length) return empty(host, height);

  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  const totals = pts.map((p) => spec.keys.reduce((a, k) => a + (p.parts[k] || 0), 0));
  const { ticks, lo, hi } = yTicks(0, Math.max(...totals, spec.goal || 0));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  drawGrid(svg, t, ticks, yOf, width, spec.precision);

  if (spec.goal) {
    const y = yOf(spec.goal);
    svg.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
      stroke: t.muted, 'stroke-width': 1, 'stroke-opacity': 0.7, 'shape-rendering': 'crispEdges',
    }));
  }

  const band = (width - PAD.left - PAD.right) / pts.length;
  const barW = Math.min(24, Math.max(1, band - 2));
  const xOf = (i) => PAD.left + band * i + band / 2;
  const colorOf = (k) => spec.colors[k] || t.ordinal[0];

  const g = el('g');
  pts.forEach((p, i) => {
    let acc = 0;
    const x = xOf(i) - barW / 2;
    const segs = [];
    spec.keys.forEach((k) => {
      const v = p.parts[k] || 0;
      if (v <= 0) return;
      const y0 = yOf(acc);
      const y1 = yOf(acc + v);
      acc += v;
      // 2px surface gap between segments — white doing the separating, never a stroke.
      const h = Math.max(0.5, (y0 - y1) - 2);
      segs.push({ k, v, y: y1, h });
    });
    segs.forEach((s, idx) => {
      const isTop = idx === segs.length - 1;
      const r = isTop ? Math.min(4, s.h / 2, barW / 2) : 0;
      const d = r > 0
        ? `M${x},${s.y + s.h} L${x},${s.y + r} Q${x},${s.y} ${x + r},${s.y} L${x + barW - r},${s.y} Q${x + barW},${s.y} ${x + barW},${s.y + r} L${x + barW},${s.y + s.h} Z`
        : `M${x},${s.y} h${barW} v${s.h} h${-barW} Z`;
      g.appendChild(el('path', { d, fill: colorOf(s.k) }));
    });

    const hit = el('rect', {
      x: PAD.left + band * i, y: PAD.top, width: band, height: plotH, fill: 'transparent',
    });
    const showTip = () => {
      const rows = spec.keys.filter((k) => (p.parts[k] || 0) > 0).reverse().map((k) => ({
        color: colorOf(k),
        value: fmtNumber(p.parts[k], spec.precision),
        label: spec.labels[k] || k,
      }));
      rows.push({ value: `${fmtNumber(totals[i], spec.precision)} ${spec.unit}`, label: 'total' });
      const rect = svg.getBoundingClientRect();
      tip.show((xOf(i) / width) * rect.width, (yOf(totals[i]) / height) * rect.height,
        rows, fmtTimeFull(p.t, spec.bucketMs));
    };
    hit.addEventListener('pointerenter', showTip);
    hit.addEventListener('pointermove', showTip);
    hit.addEventListener('pointerleave', () => tip.hide());
    g.appendChild(hit);
  });
  svg.appendChild(g);
  drawXAxis(svg, t, pts, xOf, spec.bucketMs, plotH);
  return { redraw: () => stackedChart(host, spec, height) };
}

// --- multi-series line (the compare view) -----------------------------------

/**
 * Several metrics on ONE axis, indexed to 100 at the first point.
 * Never a second y-scale: the alignment of two scales is arbitrary, so a dual axis
 * invents a correlation that isn't in the data.
 */
export function compareChart(host, series, spec, height = 260) {
  const t = tokens();
  const live = series.filter((s) => s.points.some((p) => p.v !== null));
  if (!live.length) return empty(host, height);

  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  // Index against each series' OWN MEAN over the range, not its first point. A
  // first-point base makes the whole comparison hostage to one day: an unusually
  // long walk on day 1 pushes that series' entire line below 100 and invents a
  // downward trend that isn't there. Against the mean, 100 reads as "typical for
  // this metric in this range", which is the comparison a reader actually wants.
  const indexed = live.map((s) => {
    const vals = s.points.map((p) => p.v).filter((v) => v !== null && Number.isFinite(v));
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const base = mean || 1;
    return { ...s, idx: s.points.map((p) => (p.v === null ? null : (p.v / base) * 100)) };
  });

  const flat = indexed.flatMap((s) => s.idx).filter((v) => v !== null);
  const { ticks, lo, hi } = yTicks(Math.min(...flat), Math.max(...flat));
  const n = Math.max(...indexed.map((s) => s.points.length));
  const xOf = (i) => PAD.left + (n === 1 ? spec0(width) : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  drawGrid(svg, t, ticks, yOf, width, 0);

  // Baseline at 100 — the thing every series is being compared against.
  if (lo < 100 && hi > 100) {
    svg.appendChild(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: yOf(100), y2: yOf(100),
      stroke: t.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
  }

  indexed.forEach((s) => {
    // Per-run paths again: skipping a null without starting a new subpath draws a
    // straight line across the gap, which is a claim about days that have no data.
    const segs = segments(s.idx.map((v) => ({ v })), (p) => p.v);
    for (const seg of segs) {
      if (seg.length < 2) continue;
      svg.appendChild(el('path', {
        d: seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(s.idx[i])}`).join(''),
        fill: 'none', stroke: s.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }
    const lastSeg = segs[segs.length - 1];
    if (lastSeg) {
      const lastI = lastSeg[lastSeg.length - 1];
      svg.appendChild(el('circle', {
        cx: xOf(lastI), cy: yOf(s.idx[lastI]), r: 4.5,
        fill: s.color, stroke: t.surface, 'stroke-width': 2,
      }));
    }
  });

  drawXAxis(svg, t, indexed[0].points, xOf, spec.bucketMs, plotH);

  const hair = el('line', {
    y1: PAD.top, y2: PAD.top + plotH, stroke: t.axis, 'stroke-width': 1,
    'shape-rendering': 'crispEdges', opacity: 0,
  });
  svg.appendChild(hair);
  const overlay = el('rect', {
    x: PAD.left, y: PAD.top, width: Math.max(1, width - PAD.left - PAD.right), height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.appendChild(overlay);

  overlay.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (rel - PAD.left) / Math.max(1, width - PAD.left - PAD.right);
    const i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    const x = xOf(i);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('opacity', 1);
    // One tooltip, every series — the pointer never has to land on a line.
    const rows = indexed.map((s) => ({
      color: s.color,
      value: s.points[i] && s.points[i].v !== null
        ? `${fmtNumber(s.points[i].v, s.precision)} ${s.unit}` : '—',
      label: s.label,
    }));
    tip.show((x / width) * rect.width, PAD.top + 10, rows,
      fmtTimeFull(indexed[0].points[i].t, spec.bucketMs));
  });
  overlay.addEventListener('pointerleave', () => { tip.hide(); hair.setAttribute('opacity', 0); });
  return { redraw: () => compareChart(host, series, spec, height) };
}

// --- sparkline (stat tiles) -------------------------------------------------

export function sparkline(host, values, color) {
  host.replaceChildren();
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (clean.length < 2) return;
  const w = 120;
  const h = 28;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const svg = el('svg', { width: '100%', height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  const xOf = (i) => (i / (values.length - 1)) * w;
  const yOf = (v) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
  const d = values.map((v, i) => (v === null ? '' : `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(v)}`)).join('');
  svg.appendChild(el('path', {
    d, fill: 'none', stroke: color, 'stroke-width': 1.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
  }));
  host.appendChild(svg);
}

// --- table view (the WCAG-clean twin every chart carries) -------------------

export function tableView(host, spec) {
  host.replaceChildren();
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const cols = spec.keys
    ? ['Time', ...spec.keys.map((k) => spec.labels[k] || k), 'Total']
    : ['Time', `Value (${spec.unit})`];
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const rows = spec.points.slice().reverse();
  for (const p of rows) {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    td0.textContent = fmtTimeFull(p.t, spec.bucketMs);
    tr.appendChild(td0);
    if (spec.keys) {
      let total = 0;
      for (const k of spec.keys) {
        const td = document.createElement('td');
        const v = p.parts[k] || 0;
        total += v;
        td.textContent = v ? fmtNumber(v, spec.precision) : '—';
        tr.appendChild(td);
      }
      const tt = document.createElement('td');
      tt.textContent = fmtNumber(total, spec.precision);
      tr.appendChild(tt);
    } else {
      const td = document.createElement('td');
      td.textContent = p.v === null ? '—' : fmtNumber(p.v, spec.precision);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function empty(host, height) {
  host.replaceChildren();
  const div = document.createElement('div');
  div.className = 'chart-empty';
  div.style.height = `${height}px`;
  div.textContent = 'No data in this range';
  host.appendChild(div);
  return { redraw: () => {} };
}


// --- zone histogram ---------------------------------------------------------

/**
 * Time in each heart-rate zone, as horizontal bars.
 *
 * Zones are an ORDERED scale, so they take the single-hue ordinal ramp — six
 * categorical hues would say "six unrelated things" about what is really one axis of
 * intensity. Bars are horizontal because the labels ("Zone 4 · 133–152") are long,
 * and a horizontal bar gives a label room to be read.
 *
 * Zone 1 routinely holds 20+ hours against minutes everywhere else, so the bars are
 * scaled to the LARGEST zone rather than to the total; scaled to the total, every
 * zone that matters would be an invisible sliver.
 */
export function zoneBars(host, zoneTable, minutesByZone) {
  host.replaceChildren();
  const t = tokens();
  const values = zoneTable.map((z) => minutesByZone[z.zone] || 0);
  const max = Math.max(...values, 1);

  zoneTable.forEach((z, i) => {
    const minutes = minutesByZone[z.zone] || 0;
    const row = document.createElement('div');
    row.className = 'zone-row';

    const name = document.createElement('div');
    name.className = 'zone-name';
    const sw = document.createElement('span');
    sw.className = 'zone-swatch';
    sw.style.background = t.ordinal[Math.min(i, t.ordinal.length - 1)];
    const label = document.createElement('span');
    label.textContent = `Z${z.zone}`;
    const bpm = document.createElement('span');
    bpm.className = 'zone-bpm';
    bpm.textContent = z.toBpm === null ? `${z.fromBpm}+` : `${z.fromBpm}–${z.toBpm}`;
    name.append(sw, label, bpm);

    const track = document.createElement('div');
    track.className = 'zone-track';
    const fill = document.createElement('div');
    fill.className = 'zone-fill';
    fill.style.width = `${(minutes / max) * 100}%`;
    fill.style.background = t.ordinal[Math.min(i, t.ordinal.length - 1)];
    track.appendChild(fill);

    const val = document.createElement('div');
    val.className = 'zone-val';
    val.textContent = minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
      : `${Math.round(minutes)}m`;

    row.append(name, track, val);
    row.title = `${z.label} (${z.range}) — ${z.note}`;
    host.appendChild(row);
  });
}

// --- hypnogram --------------------------------------------------------------

const STAGE_ORDER = ['AWAKE', 'REM', 'LIGHT', 'DEEP'];
const STAGE_SLOT = { AWAKE: 0, REM: 3, LIGHT: 2, DEEP: 5 };

/**
 * A night, stage by stage. Totals say "seven hours"; this says whether that was
 * seven hours or four wakings, which is the entire reason a sleep screen exists.
 *
 * One lane per stage rather than a single stacked strip: with one strip the eye has
 * to decode colour to read depth, and short awakenings vanish between neighbours.
 */
export function hypnogram(host, timeline, opts = {}) {
  host.replaceChildren();
  if (!timeline || !timeline.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No staged sleep for this night';
    host.appendChild(empty);
    return;
  }
  const t = tokens();
  const from = opts.from || timeline[0].from;
  const to = opts.to || timeline[timeline.length - 1].to;
  const span = Math.max(1, to - from);

  const present = STAGE_ORDER.filter((st) => timeline.some((x) => x.stage === st));
  for (const stage of present) {
    const row = document.createElement('div');
    row.className = 'hypno-row';

    const label = document.createElement('div');
    label.className = 'hypno-label';
    label.textContent = stage === 'AWAKE' ? 'Awake' : stage.toLowerCase();

    const track = document.createElement('div');
    track.className = 'hypno-track';
    for (const seg of timeline.filter((x) => x.stage === stage)) {
      const el2 = document.createElement('div');
      el2.className = 'hypno-seg';
      const left = ((seg.from - from) / span) * 100;
      const width = ((seg.to - seg.from) / span) * 100;
      el2.style.left = `${Math.max(0, left)}%`;
      // A two-minute waking is 0.4% of a night — floor the width so it stays visible
      // instead of rounding away to nothing.
      el2.style.width = `${Math.max(0.7, width)}%`;
      el2.style.background = t.ordinal[STAGE_SLOT[stage] ?? 2];
      const mins = Math.round((seg.to - seg.from) / 60000);
      el2.title = `${stage.toLowerCase()} · ${fmtTimeFull(seg.from, 0)} · ${mins} min`;
      track.appendChild(el2);
    }

    row.append(label, track);
    host.appendChild(row);
  }

  const axis = document.createElement('div');
  axis.className = 'hypno-axis';
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const a = document.createElement('span'); a.textContent = clock(from);
  const b = document.createElement('span'); b.textContent = clock(from + span / 2);
  const c = document.createElement('span'); c.textContent = clock(to);
  axis.append(a, b, c);
  host.appendChild(axis);
}

// --- score ring (readiness, sleep score) -------------------------------------

/**
 * One bounded score as a ring. The arc is the only place the semantic colour
 * appears — the numeral stays in text ink, per the "text never wears the series
 * colour" rule. `spec: {value, max, label, sublabel, color, size}`.
 */
export function ringGauge(host, spec) {
  host.replaceChildren();
  const t = tokens();
  const size = spec.size || 148;
  const r = size / 2 - 10;
  const c = size / 2;
  const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' });
  svg.appendChild(el('circle', { cx: c, cy: c, r, fill: 'none', stroke: t.grid, 'stroke-width': 9 }));
  if (spec.value !== null && spec.value !== undefined) {
    const frac = Math.max(0.004, Math.min(1, spec.value / (spec.max || 100)));
    const a0 = -Math.PI / 2;
    const a1 = a0 + Math.PI * 2 * Math.min(0.9999, frac);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const p = (a) => [c + r * Math.cos(a), c + r * Math.sin(a)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    svg.appendChild(el('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`,
      fill: 'none', stroke: spec.color || t.series[0], 'stroke-width': 9, 'stroke-linecap': 'round',
      class: 'ring-arc',
    }));
  }
  const num = el('text', {
    x: c, y: c + (spec.sublabel ? 2 : 8), 'text-anchor': 'middle',
    fill: t.text, class: 'ring-num',
  });
  num.textContent = spec.value === null || spec.value === undefined ? '—' : String(spec.value);
  svg.appendChild(num);
  if (spec.sublabel) {
    const sub = el('text', { x: c, y: c + 22, 'text-anchor': 'middle', fill: t.muted, 'font-size': 10, class: 'ring-sub' });
    sub.textContent = spec.sublabel;
    svg.appendChild(sub);
  }
  host.appendChild(svg);
}

// --- half-dial arc (strain vs target, battery, countdown) --------------------

/** `spec: {value, max, label, band:{lo,hi}, color, format}` — a half dial with an
 * optional target band shaded on the track. */
export function arcGauge(host, spec) {
  host.replaceChildren();
  const t = tokens();
  const w = spec.size || 130;
  const h = w * 0.62;
  const c = w / 2;
  const cy = h - 8;
  const r = w / 2 - 12;
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' });
  const at = (frac) => Math.PI + Math.PI * Math.max(0, Math.min(1, frac));
  const arc = (f0, f1, stroke, width, cap = 'butt') => {
    const a0 = at(f0);
    const a1 = at(f1);
    const p = (a) => [c + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return el('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`,
      fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': cap,
    });
  };
  svg.appendChild(arc(0, 1, t.grid, 7));
  const max = spec.max || 100;
  if (spec.band && spec.band.lo !== null) {
    svg.appendChild(arc(spec.band.lo / max, spec.band.hi / max, t.deemph, 7));
  }
  if (spec.value !== null && spec.value !== undefined) {
    svg.appendChild(arc(0, spec.value / max, spec.color || t.series[0], 7, 'round'));
  }
  const num = el('text', { x: c, y: cy - 8, 'text-anchor': 'middle', fill: t.text, class: 'arc-num' });
  num.textContent = spec.value === null || spec.value === undefined ? '—'
    : (spec.format ? spec.format(spec.value) : String(spec.value));
  svg.appendChild(num);
  const lab = el('text', { x: c, y: cy + 6, 'text-anchor': 'middle', fill: t.muted, 'font-size': 9, class: 'arc-label' });
  lab.textContent = spec.label || '';
  svg.appendChild(lab);
  host.appendChild(svg);
}

// --- three concentric rings (Move / Train / Recover) -------------------------

export function ringTrio(host, rings) {
  host.replaceChildren();
  const t = tokens();
  const size = 128;
  const c = size / 2;
  const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' });
  rings.forEach((ring, i) => {
    const r = c - 10 - i * 17;
    svg.appendChild(el('circle', { cx: c, cy: c, r, fill: 'none', stroke: t.grid, 'stroke-width': 12 }));
    if (ring.fraction === null) return;
    const frac = Math.max(0.005, Math.min(0.9999, ring.fraction));
    const a0 = -Math.PI / 2;
    const a1 = a0 + Math.PI * 2 * frac;
    const p = (a) => [c + r * Math.cos(a), c + r * Math.sin(a)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    svg.appendChild(el('path', {
      d: `M ${x0} ${y0} A ${r} ${r} 0 ${(a1 - a0) > Math.PI ? 1 : 0} 1 ${x1} ${y1}`,
      fill: 'none', stroke: ring.color, 'stroke-width': 12, 'stroke-linecap': 'round',
    }));
  });
  host.appendChild(svg);
}

// --- load corridor (band + the 7-day-load line threading it) -----------------

/** `spec: {series:[{t,lo,hi,fatigue}], bucketMs}` — the healthy-load corridor. */
export function corridorChart(host, spec, height = 200) {
  const t = tokens();
  const pts = spec.series.filter((d) => d.lo !== null || d.fatigue !== null);
  if (pts.length < 2) return empty(host, height);
  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  const values = pts.flatMap((d) => [d.lo, d.hi, d.fatigue]).filter((v) => v !== null && Number.isFinite(v));
  const { ticks, lo, hi } = yTicks(0, Math.max(...values), 4, true);
  const n = pts.length;
  const xOf = (i) => PAD.left + (n === 1 ? spec0(width) : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  drawGrid(svg, t, ticks, yOf, width, 0);

  const good = getComputedStyle(document.documentElement).getPropertyValue('--good').trim();
  const bandIdx = pts.map((d, i) => (d.lo !== null ? i : null)).filter((i) => i !== null);
  if (bandIdx.length > 1) {
    const up = bandIdx.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i].hi)}`).join('');
    const down = bandIdx.slice().reverse().map((i) => `L${xOf(i)},${yOf(pts[i].lo)}`).join('');
    svg.appendChild(el('path', { d: `${up}${down}Z`, fill: good, 'fill-opacity': 0.14, stroke: 'none' }));
    for (const edge of ['lo', 'hi']) {
      svg.appendChild(el('path', {
        d: bandIdx.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i][edge])}`).join(''),
        fill: 'none', stroke: good, 'stroke-width': 1, 'stroke-opacity': 0.5,
      }));
    }
  }
  const fatSegs = segments(pts, (p) => p.fatigue);
  for (const seg of fatSegs) {
    if (seg.length < 2) continue;
    svg.appendChild(el('path', {
      d: seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(pts[i].fatigue)}`).join(''),
      fill: 'none', stroke: t.text, 'stroke-width': 2, 'stroke-dasharray': '1 5',
      'stroke-linecap': 'round',
    }));
  }
  const lastI = fatSegs.length ? fatSegs[fatSegs.length - 1].slice(-1)[0] : null;
  if (lastI !== null) {
    svg.appendChild(el('circle', {
      cx: xOf(lastI), cy: yOf(pts[lastI].fatigue), r: 4.5,
      fill: t.text, stroke: t.surface, 'stroke-width': 2,
    }));
  }
  drawXAxis(svg, t, pts, xOf, spec.bucketMs || 86400000, plotH);

  const overlay = el('rect', {
    x: PAD.left, y: PAD.top, width: Math.max(1, width - PAD.left - PAD.right), height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.appendChild(overlay);
  overlay.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((rel - PAD.left) / Math.max(1, width - PAD.left - PAD.right)) * (n - 1))));
    const d = pts[i];
    const rows = [];
    if (d.fatigue !== null) rows.push({ color: t.text, value: fmtNumber(d.fatigue, 0), label: '7-day load' });
    if (d.lo !== null) rows.push({ color: good, value: `${fmtNumber(d.lo, 0)}–${fmtNumber(d.hi, 0)}`, label: 'healthy corridor' });
    tip.show((xOf(i) / width) * rect.width, PAD.top + 10, rows, fmtTimeFull(d.t, 86400000));
  });
  overlay.addEventListener('pointerleave', () => tip.hide());
  return { redraw: () => corridorChart(host, spec, height) };
}

// --- day overlay (compare: two days of the SAME metric on one axis) ----------

/**
 * `a`/`b`: {label, points:[{t,v}]}; `band`: optional typical p25–p75 per point of
 * b. Same unit on both sides, so this is one real axis, not an indexed trick;
 * the ghost wears a dash because it is a reference, not a measurement of today.
 */
export function overlayChart(host, spec, height = 230) {
  const t = tokens();
  const aPts = spec.a.points;
  const bPts = spec.b ? spec.b.points : [];
  const n = Math.max(aPts.length, bPts.length);
  if (!n || !aPts.some((p) => p.v !== null)) return empty(host, height);
  const { svg, width, plotH } = frame(host, height);
  const tip = makeTooltip(host);

  const all = [...aPts, ...bPts].flatMap((p) => [p.v, p.p25, p.p75])
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const { ticks, lo, hi } = yTicks(Math.min(...all), Math.max(...all), 4, spec.nonNegative !== false);
  const xOf = (i) => PAD.left + (n === 1 ? spec0(width) : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const yOf = (v) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  drawGrid(svg, t, ticks, yOf, width, spec.precision || 0);

  const ghost = t.secondary;
  if (bPts.some((p) => p.p25 !== null && p.p25 !== undefined)) {
    const idx = bPts.map((p, i) => (p.p25 !== null && p.p25 !== undefined && p.p75 !== null ? i : null)).filter((i) => i !== null);
    if (idx.length > 1) {
      const up = idx.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(bPts[i].p75)}`).join('');
      const down = idx.slice().reverse().map((i) => `L${xOf(i)},${yOf(bPts[i].p25)}`).join('');
      svg.appendChild(el('path', { d: `${up}${down}Z`, fill: ghost, 'fill-opacity': 0.1, stroke: 'none' }));
    }
  }
  for (const seg of segments(bPts, (p) => p.v)) {
    if (seg.length < 2) continue;
    svg.appendChild(el('path', {
      d: seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(bPts[i].v)}`).join(''),
      fill: 'none', stroke: ghost, 'stroke-width': 1.5, 'stroke-dasharray': '4 4', 'stroke-opacity': 0.85,
    }));
  }
  const aColor = spec.color || t.series[0];
  for (const seg of segments(aPts, (p) => p.v)) {
    if (seg.length < 2) {
      if (seg.length === 1) {
        svg.appendChild(el('circle', {
          cx: xOf(seg[0]), cy: yOf(aPts[seg[0]].v), r: 3, fill: aColor, stroke: t.surface, 'stroke-width': 2,
        }));
      }
      continue;
    }
    svg.appendChild(el('path', {
      d: seg.map((i, k) => `${k ? 'L' : 'M'}${xOf(i)},${yOf(aPts[i].v)}`).join(''),
      fill: 'none', stroke: aColor, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }
  drawXAxis(svg, t, (aPts.length >= bPts.length ? aPts : bPts), xOf, spec.bucketMs, plotH);

  const overlay = el('rect', {
    x: PAD.left, y: PAD.top, width: Math.max(1, width - PAD.left - PAD.right), height: plotH,
    fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.appendChild(overlay);
  overlay.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((rel - PAD.left) / Math.max(1, width - PAD.left - PAD.right)) * (n - 1))));
    const rows = [];
    const av = aPts[i] ? aPts[i].v : null;
    const bv = bPts[i] ? bPts[i].v : null;
    rows.push({ color: aColor, value: av === null ? '—' : `${fmtNumber(av, spec.precision || 0)} ${spec.unit}`, label: spec.a.label });
    if (spec.b) rows.push({ color: ghost, value: bv === null || bv === undefined ? '—' : `${fmtNumber(bv, spec.precision || 0)} ${spec.unit}`, label: spec.b.label });
    const at = (aPts[i] || bPts[i] || {}).t;
    tip.show((xOf(i) / width) * rect.width, PAD.top + 10, rows, at ? fmtTimeFull(at, spec.bucketMs) : '');
  });
  overlay.addEventListener('pointerleave', () => tip.hide());
  return { redraw: () => overlayChart(host, spec, height) };
}

// --- heat calendar -----------------------------------------------------------

/**
 * Weeks × weekdays, single-hue sequential cells (magnitude, one metric — identity
 * lives in the card title). Unmeasured days stay the empty surface: "not tracked"
 * must not look like "did nothing". Cells are buttons — every one is a door to
 * that day.
 */
export function heatCalendar(host, spec, onPick) {
  host.replaceChildren();
  const t = tokens();
  const wrap = document.createElement('div');
  wrap.className = 'heatcal';
  const colOf = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const th = spec.thresholds || [];
    let step = 0;
    for (const x of th) { if (x !== null && v > x) step++; }
    return t.ordinal[Math.min(1 + step, t.ordinal.length - 1)];
  };
  const firstDow = (new Date(spec.cells[0].t + (spec.offsetMs || 0)).getUTCDay() + 6) % 7;
  for (let i = 0; i < firstDow; i++) {
    wrap.appendChild(document.createElement('span'));
  }
  for (const cell of spec.cells) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'heatcell';
    const color = colOf(cell.v);
    if (color) b.style.background = color;
    else b.classList.add('empty');
    const d = new Date(cell.t + (spec.offsetMs || 0));
    b.title = `${d.toISOString().slice(0, 10)} — ${cell.v === null ? 'not tracked' : `${fmtNumber(cell.v, spec.precision || 0)} ${spec.unit || ''}`}`;
    b.setAttribute('aria-label', b.title);
    if (onPick) b.addEventListener('click', () => onPick(d.toISOString().slice(0, 10)));
    wrap.appendChild(b);
  }
  host.appendChild(wrap);
}

// --- stress / state strip ----------------------------------------------------

/** One coloured block per hour. Ordered intensity takes the ordinal ramp; special
 * states (active, restorative, unknown) are structural, not on the ramp. */
export function stateStrip(host, points, opts = {}) {
  host.replaceChildren();
  const t = tokens();
  const colors = {
    calm: t.ordinal[1], elevated: t.ordinal[3], high: t.ordinal[5],
    restorative: t.ordinal[0], active: t.deemph,
  };
  const strip = document.createElement('div');
  strip.className = 'state-strip';
  for (const p of points) {
    const cell = document.createElement('span');
    cell.className = `state-cell${p.state === null ? ' unknown' : ''}${p.state === 'active' ? ' active' : ''}`;
    if (p.state && colors[p.state]) cell.style.background = colors[p.state];
    const time = new Date(p.t).toLocaleTimeString([], { hour: 'numeric' });
    cell.title = p.state === null ? `${time} — not tracked`
      : `${time} — ${p.state}${p.avgHr ? ` · ${p.avgHr} bpm` : ''}`;
    strip.appendChild(cell);
  }
  host.appendChild(strip);
  if (opts.legend !== false) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const [key, label] of [['calm', 'Calm'], ['elevated', 'Elevated'], ['high', 'High'], ['active', 'Activity'], ['restorative', 'Nap']]) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = colors[key];
      item.append(sw, document.createTextNode(label));
      legend.appendChild(item);
    }
    host.appendChild(legend);
  }
}

export { tokens, fmtNumber, fmtTimeFull };
