# CLAUDE.md — vitals

Personal health dashboard: syncs the **Google Health API** into the fleet's MySQL
and charts it. One dependency (`mysql2`); no framework, no build step. Deployed by
infra at **2 replicas** (`infra/apps/vitals.yml`). Read `README.md` for setup and the
API's access situation.

`npm start` · `npm test` · `npm run check:paths`

**Local dev needs a tunnel to the fleet DB** — MySQL's published port is filtered
from outside njvhost:

    ssh -f -N -L 3307:192.168.50.244:3306 njvhost

A locally-run server competes for the sync lease with production (same database), so
stop it when you are done or it will occasionally sync from your laptop.

## The five things that will bite you

1. **Three naming forms per data type.** kebab in the URL path (`body-fat`), snake in
   the `filter` expression (`body_fat`), camelCase as the payload key (`bodyFat`).
   `lib/catalog.js` is the only place that knows this — never hand-write a type name
   anywhere else.

2. **The filter field depends on the record type**, and a wrong one is a 400, not a
   wrong answer: INTERVAL → `.interval.start_time`, SESSION → `.interval.end_time`,
   SAMPLE → `.sample_time.physical_time`, DAILY → `.date` (a civil date — sending a
   timestamp there is rejected). Use `catalog.timeRangeFilter()`.

3. **Max query range is 14 days for four types, 90 for the rest.** `health.chunks()`
   is the only correct way to walk a long range.

4. **Google restates data.** A late watch sync rewrites the whole day; sleep is
   revised the next morning. Hence the 36-hour trailing re-read and upsert on
   `(data_type, point_id)`. Never make sync append-only.

5. **`pageSize` defaults to 1440.** Ignoring `nextPageToken` truncates a day of
   intraday heart rate and the chart still looks plausible.

## Measured API facts (live v4, Aug 2026)

These were established against the real API, not read off a doc page — several
contradict the published reference. Do not "correct" them back.

**Methods.** `total-calories` and `floors` REFUSE `list` entirely: *"List is not
supported for data type total-calories, but the following actions are supported:
rollup, dailyRollup"*. They go through `dailyRollUp` (`listMethod` in the catalog).

**dailyRollUp is a different animal**: POST, a civil-date `range` object instead of
a filter string, and `rollupDataPoints` instead of `dataPoints`.
- `range.start`/`end` are **CivilDateTime**, which nests under `date` — bare
  `{year, month, day}` is rejected with `Unknown name "year" at 'range.start'`.
- `end` is **exclusive and whole-day**, so passing today's date silently drops today.
- **Do not send `pageSize`.** The reference documents it; sending it returns
  `Invalid argument in request`.
- The range cap is **14 civil days**, unrelated to the type's `list` window (floors
  lists at 90, rolls up at 14). Chunks are cut at 13 because the end rounds up.

**Filters.** `exercise`, `hydration-log` and `nutrition-log` reject *every*
physical-time member and accept only `<snake>.interval.civil_start_time`, with an
offset-less local literal (`2026-08-14T20:03:00`). Sending RFC-3339 there gives
`INVALID_DATA_POINT_FILTER_CIVIL_DATE_TIME_FORMAT` — which is the useful error,
because it means the *member* was right and only the format was wrong.

**Real value fields** (the reference does not publish these per type):

| type | field | note |
|---|---|---|
| weight | `weightGrams` | grams, not kg — scale 1/1000 |
| height | `heightMillimeters` | mm, not cm — scale 1/10 |
| distance | `millimeters` | |
| active-energy-burned | `kcal` | |
| total-calories | `kcalSum` | rollup values carry a `Sum` suffix |
| heart-rate-variability | `rootMeanSquareOfSuccessiveDifferencesMilliseconds` | |
| active-minutes | `activeMinutesByActivityLevel[]` | an ARRAY, not a scalar |
| time-in-heart-rate-zone | *(none)* | one point per interval tagged `heartRateZoneType`; the interval duration IS the value |
| sedentary-period | *(none)* | interval only; its duration is the measurement |
| sleep | `stages[]`, `type` | not `sleepStages`/`sleepType` as the doc example shows |
| respiratory-rate-sleep-summary | `fullSleepStats.breathsPerMinute` | nested per sleep stage — needs a dotted path, or a bare key search returns deep-sleep |

Int64 values arrive as JSON **strings** (`"count": "15"`).

## Invariants — don't quietly break these

- **Point anchors must not depend on the host timezone.** `new Date(y, m, d)` is
  process-local; a UTC container and a UTC+4 laptop wrote two rows for the same
  rollup day and daily calories double-counted. Anchors are `Date.UTC`; the viewer's
  offset is applied at QUERY time, which is the only place a timezone belongs.
- **Periodic work is leased, and the lease is conditional on completion time.** A
  plain mutex makes replicas take turns rather than stand down — both still run the
  sweep, which is the exact failure it was meant to prevent. Manual sync deliberately
  passes `minInterval 0` to override the cadence.
- **`points.raw` is never dropped.** Derived values are re-computable from it
  (`normalize.renormalize`). Per-type value field names aren't fully published, so
  hints will need correcting; that must never require a re-sync.
- **`anchor_ms`, not `start_ms`, is what buckets and range-filters.** Sleep anchors on
  **wake** time (`bucketBy: 'end'`) — bucketing a night by bedtime puts a 23:40 and a
  00:20 start on different days and produces 15-hour double-nights.
- **Google is reached from exactly two modules**: `lib/oauth.js` (tokens) and
  `lib/health.js` (data). The dashboard reads only the database and never waits on upstream.
- **The webhook checks auth BEFORE answering the handshake.** Registration probes the
  endpoint *without* credentials and requires a 401/403; an endpoint that 200s
  everything fails with `FAILED_PRECONDITION`. This inverts the usual "handle health
  checks first" instinct.
- **No root-absolute URLs in `public/`.** Deployed, the app sits under a stripped path
  prefix, so `/style.css` works locally and 404s in the fleet. `npm run check:paths`
  gates it and runs in the Docker build.
- **`agg` is a property of the measurement, not a UI preference.** Summing a heart
  rate produces a meaningless number. Don't make it configurable.

## Charts (`public/charts.js`)

Hand-rolled SVG against the house data-viz method. The palette in `style.css` is
**validated** (both modes) — re-run the validator before changing any colour.

- Ordered scales (sleep stages, HR zones) use the **single-hue ordinal ramp**, never
  categorical hues. Sleep sets `rampReverse` because it stacks DEEP at the bottom
  while deep sleep is the *most* end of the scale and must be the darkest step.
- **Never a second y-axis.** The compare chart indexes each metric to its own mean
  over the range (100 = typical) and puts them on one axis.
- **A missing bucket is `null`, never `0`** — "not measured" and "measured zero" are
  different claims. `query.denseBuckets` emits every bucket so charts position by
  real time; lines break at gaps. `connectGaps` (weight, body fat, height) joins the
  runs *while keeping real indices*, because a standing value doesn't stop existing
  between measurements.
- Marks: bars ≤24px with a 4px rounded data-end, 2px lines, 2px surface gaps between
  fills, hairline solid gridlines, labels only on the last point. Every chart has a
  table view — that is also what satisfies the relief rule for the three light-mode
  palette slots under 3:1 contrast.
- Axis ticks take **one unit and one decimal rule for the whole axis**, derived from
  the largest tick and the step. Per-tick formatting prints `5,000` under `10.0K`,
  and integer rounding prints a 2.5 step as `0, 3, 5, 8, 10`.

## Testing

`test/run.js` deliberately targets what fails *silently*: filter syntax, window
chunking, restatement, timezone bucketing, sleep anchoring, gap handling, and the
webhook's auth ordering. Rendering is checked by looking at the page — run
`npm run demo` and open it.

## The assistant reads this app

`GET /api/assistant` is a one-call digest — today, yesterday, 14 days, 7/30-day
averages — aggregated here rather than in the model, because a language model doing
arithmetic over five responses is where invented numbers come from. It also reports
its own `freshness`, `coverage` and `notes`.

Two rules when changing it:

- **Never let the notes contradict the values.** They were listing resting HR/HRV/SpO2
  as "no data" while the same payload carried values filled in from raw samples. The
  assistant reads notes aloud, so a contradiction becomes a confident falsehood.
- **A null means not measured.** Do not substitute zero anywhere in this payload.

`POST /api/sync` forces a refresh ahead of the 5-minute cadence; the assistant is told
to call it before answering "right now" questions.
