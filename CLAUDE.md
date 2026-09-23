# CLAUDE.md — vitals

Personal health dashboard: syncs the **Google Health API** into the fleet's MySQL
and turns it into five screens — **Today · Sleep · Train · Trends · You** — each
served by one purpose-built endpoint (`/api/screen/*`, composed in
`lib/screens.js`). One dependency (`mysql2`); no framework, no build step. Deployed
by infra at **2 replicas** (`infra/apps/vitals.yml`). Read `README.md` for setup,
the API's access situation, and what each screen carries. Mobile-web first; the
same payloads are the contract for a future native client, so keep them
self-describing (dates, units, `method`, freshness) and never UI-shaped.

`npm start` · `npm test` · `npm run check:paths`

**Local dev needs a tunnel to the DB host** — MySQL's published port is filtered
from outside the database's own host:

    ssh -f -N -L 3307:<db-host>:3306 <db-server>

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
| daily-heart-rate-variability | `averageHeartRateVariabilityMilliseconds` | also `deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds`, `entropy` |
| daily-sleep-temperature-derivations | `nightlyTemperatureCelsius` − `baselineTemperatureCelsius` | NO delta field — both are absolute (~33 °C); the plotted deviation is computed |
| daily-oxygen-saturation | `averagePercentage` | plus lower/upper bound, SD |

Int64 values arrive as JSON **strings** (`"count": "15"`).

**Daily types date with an OBJECT**, `date: {year, month, day}` — not the
`"2026-09-18"` string the demo writes. Until Sep 2026 `toMs` only parsed strings and
every daily summary was dropped as "no timestamp found"; that was mistaken for "the
device doesn't report daily resting HR/HRV/SpO2". It does (a Fitbit Air, since at
least Aug 14).

**Empty point ids.** `respiratory-rate-sleep-summary` names every point
`.../dataPoints/` — nothing after the slash. A name ending in `/` is treated as
nameless (time key), or every night upserts onto one row.

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
  `lib/health.js` (data). The dashboard reads only the database and never waits on
  upstream — including for age, which sync writes into settings so `metrics.getProfile()`
  stays a pure database read.
- **The webhook checks auth BEFORE answering the handshake.** Registration probes the
  endpoint *without* credentials and requires a 401/403; an endpoint that 200s
  everything fails with `FAILED_PRECONDITION`. This inverts the usual "handle health
  checks first" instinct.
- **No root-absolute URLs in `public/`.** Deployed, the app sits under a stripped path
  prefix, so `/style.css` works locally and 404s in the fleet. `npm run check:paths`
  gates it and runs in the Docker build.
- **Heart rate is read through `hr_minute`, never through the raw samples.** The
  2-second PPG stream is 1.2M rows and 800 MB after five weeks and grows ~34k rows
  a day; `hr_minute` is a per-minute rollup (sum/n/min/max) that `putPoints`
  rebuilds for exactly the minutes a write touched, straight from `points` — so
  restatement, `renormalize` and a demo load all repair it and it can never drift.
  It is a projection: `points` stays authoritative and nothing reads it as a
  source. Sleeping HR, the reference band, the intraday trace and every
  minute-aligned HR series come off it, VALUE-FOR-VALUE identical (2875→35ms,
  2730→18ms, 3088→42ms measured) because each was already averaging up to whole
  minutes. A bucket is `SUM(sum_v)/SUM(n)` — the mean of the SAMPLES; averaging
  per-minute means would weight a sparse minute like a full one. Two things it
  cannot serve: sub-minute or minute-misaligned buckets (`hrRollupUsable` gates
  this), and **zone time**, which is decided per sample and would smear across
  zone boundaries at minute resolution — that one stays on the raw stream.
- **The optimiser picks the wrong index on `points`, so the hot scans say
  `FORCE INDEX`.** `raw` is LONGTEXT stored inline, which makes the clustered index
  800 MB against ~15 MB of covering index, and MySQL's cost model does not charge
  for the pages it drags through a 128 MB buffer pool — so it costs the clustered
  scan as *cheaper* and takes it (zone time: 7538ms its way, 5336ms forced,
  identical rows). Don't remove those hints without re-measuring.
- **Count nothing you only test for zero.** `COUNT(*) GROUP BY data_type` cannot be
  answered without walking all 1.2M index entries (440ms, and it was on every
  screen); `db.typeRange()` asks each type for MIN/MAX only, 28 index dives, 10ms.
  `first_ms === null` IS `points === 0` because `anchor_ms` is NOT NULL. Use
  `db.typeStats()` only where a count is actually REPORTED (`/api/status`,
  the assistant digest) and `db.typeCount(type)` for one small type.
- **Screen reads are memoized per replica** (`db.memoized`): zone derivation,
  reference bands, bucketed series, typeStats/platforms. Timestamps in memo keys
  quantize to the minute (request windows end at `Date.now()`, which would
  otherwise mint a fresh key per request). `putPoints` prunes them **by range**
  (`memoInvalidateSince`): every entry records the `toMs` it covers, and a write
  drops only entries whose window reaches at or past the oldest anchor it touched
  — measured over the incoming rows AND the pre-write anchors of the ids being
  overwritten, so a restatement that moves a point also expires the day it left.
  A manual sync still shows its own points immediately; what changed is that the
  36-hour tail no longer empties the whole cache every five minutes, which had made
  the cold path the normal path. Never bypass `series`/`aggregate` with
  hand-written point queries in a screen path — the covering index
  `(data_type, anchor_ms, value)`, `hr_minute` and this memo are why screens are fast.
- **`agg` is a property of the measurement, not a UI preference.** Summing a heart
  rate produces a meaningless number. Don't make it configurable.

## Charts (`public/charts.js`)

Hand-rolled SVG against the house data-viz method. The palette in `style.css` is
**validated** (both modes) — re-run the validator before changing any colour.

- Ordered scales (sleep stages, HR zones) use the **single-hue ordinal ramp**, never
  categorical hues. Sleep sets `rampReverse` because it stacks DEEP at the bottom
  while deep sleep is the *most* end of the scale and must be the darkest step.
- **Never a second y-axis.** If metrics with different units ever share a chart,
  index each to its own mean over the range (100 = typical) on one axis — never
  align two scales.
- **A missing bucket is `null`, never `0`** — "not measured" and "measured zero" are
  different claims. `query.denseBuckets` emits every bucket so charts position by
  real time; lines break at gaps. `connectGaps` (weight, body fat, height) joins the
  runs *while keeping real indices*, because a standing value doesn't stop existing
  between measurements.
- Marks: bars ≤24px with a 4px rounded data-end, 2px lines, 2px surface gaps between
  fills, hairline solid gridlines, labels only on the last point. Every time-series
  chart card carries a table toggle (`withTable` in app.js → `tableView`) — that is
  also what satisfies the relief rule for the three light-mode palette slots under
  3:1 contrast.
- Axis ticks take **one unit and one decimal rule for the whole axis**, derived from
  the largest tick and the step. Per-tick formatting prints `5,000` under `10.0K`,
  and integer rounding prints a 2.5 step as `0, 3, 5, 8, 10`.
- New marks follow the same system: `ringGauge`/`arcGauge` keep the semantic colour
  on the arc only (numerals wear text ink); `overlayChart` compares two days of the
  SAME metric on one real axis, ghost dashed — still never a second y-axis;
  `corridorChart` is band + dotted line; `heatCalendar` is single-hue sequential
  with untracked days as empty dashed cells (not zero-coloured), and every cell is
  a button that jumps to its day; `lineChart` gained `refBand` — the personal
  p10–p90 painted behind any series — the Today heart-rate chart pairs it with
  `band: true`, whose shaded range is each bucket's real min–max, because an
  averaged 71 bpm hides a 48–160 day. Its reference band comes from
  `db.bucketBand`, which takes the quantiles IN SQL over bucket averages at the
  SAME bucket size the chart draws: quantiles of raw one-minute samples are much
  wider than quantiles of five-minute averages, and the wider band behind the
  narrower line makes an ordinary day look becalmed. The stress `stateStrip` (on Today) marks
  off-wrist hours as unknown, never calm. `overlayChart` positions every point by
  REAL TIME against each series' own origin — its two curves can be sparse and
  differently bucketed, so index alignment would pair different clock times; its
  zero-basing is opt-in (`nonNegative: true` for accumulating metrics only). The
  Aurora glass treatment changes surfaces only — the validated palette values are
  untouched.

## Derived insights (`lib/insights.js` + `lib/scores.js`/`night.js`/`training.js`/`trends.js`/`goals.js`)

The derived layer follows one shape everywhere: **pure `build*` functions taking
pre-fetched inputs** (unit-testable) plus thin async wrappers that do the IO;
`lib/screens.js` fetches shared inputs once per request and composes. Shared
statistics live in `lib/stats.js` — medians/quantiles/EWMA that drop null, never
substitute zero.

- Activity detection is heart-rate-only. It may label a session “Elevated heart
  rate”; it must not guess an activity type without movement/GPS evidence.
- The Zone 3 entry threshold is 60% of the profile's max HR. Max HR uses `220 - age`
  unless an override is set through `POST /api/settings` — API-only; there is no
  profile screen in the UI.
- **Age is READ FROM THE GOOGLE ACCOUNT, never typed in.** `GET /users/me/profile`
  returns it as whole years under the already-granted `googlehealth.profile.readonly`
  scope (`/users/me` and `/users/me/userProfile` are both 404 — only that exact path
  works). Sync stores it; `POST /api/settings` rejects `age` outright. A hand-entered
  age would silently outlive every sync and shift every zone boundary with it. Max HR
  stays overridable — a measured max beats any estimate. The pre-sync fallback still
  answers 30, but reports `ageSource: 'default'` so nothing presents the assumption
  as a measurement; a failed profile read keeps the last known age and must never
  fail the sweep.
- Ten elevated minutes qualify; five minutes below threshold or without samples ends
  the session. Do not bridge an off-wrist gap and call it exercise.
- Activity calories prefer granular active-energy intervals. A day-scale record is a
  fallback only for portions of the detected session with no granular coverage; summing
  both shapes counts the same time twice.
- Recovery is a transparent personal-baseline comparison, never a claim to reproduce
  WHOOP's proprietary score. Keep `derived`, `method`, and `limitation` in the payload.
- Fitness age is an experimental, whole-year estimate against PUBLISHED NORMS —
  never WHOOP Age, biological age or a diagnosis. Five bounded drivers: nightly HRV
  vs Lifelines age-band medians (Tegegne 2020, n = 84,772, lifted e^0.30 to the
  nocturnal level — the one uncited constant, kept identical to Cadence's), resting
  HR vs Quer 2020 (n = 92,457), VO2max = 15.3·HRmax/HRrest (Uth 2004) vs FRIEND
  decade medians at HALF weight while max HR is an age estimate, activity vs WHO
  150 min/wk, sleep outside 7–9 h. Norms are the male/female mean (sex is unknown
  here). Needs HRV, RHR and one more driver; capped ±8 years. It used to score RHR
  and HRV on CHANGE vs the prior month, so a stable excellent reader scored zero and
  a training block "aged" them — a level needs a referent; do not go back.
- **Readiness is a z-score composite**: every input against the person's own 28-day
  history (personal SD with a per-metric floor — HRV 0.08 on ln, RHR 1.5 bpm), clamped
  ±3, combined as `50 + 20 × Σw·z / Σw` over the inputs that ARE measured (HRV .40,
  RHR .25, sleep .25, a .10 pool for breathing / skin temp / yesterday's strain);
  bands 67/33. Dividing by Σw is what makes "an unavailable input lowers COVERAGE,
  never the score" literally true; fewer than two of HRV/RHR/sleep means no score
  (`calibrating`). It is CALIBRATED BY TEST — 4,000 stationary mornings must read
  mean ≈ 50, SD 8–16, a tenth high and a tenth low, and planted alcohol / late-bed /
  illness nights must cost their points. The additive base-62 model this replaced
  had no distributional test and four terms that could only subtract; do not bring
  back raw-percent caps.
- **Resting HR is ONE derivation**: the device's daily figure, else the mean of the
  lowest decile of one-minute averages over the night (22:00–08:00, ≥ 60 minutes;
  `db.sleepingHeartRateDaily`, surfaced by `insights.restingDaily`). Today's value,
  its 28-day baseline, fitness age and the assistant digest all read it — they used
  to take three different windows (a single-sample 00–08 min, a whole-day min, a
  20–08 min) and compare unlike things. A sample minimum of 2-second PPG is an
  artefact, never a level.
- **The symptom radar is z-gated, not quantile-gated.** Each vital is a z against
  the flat 28-day mean and floored SD (never an EW mean — it chases a fever and goes
  quiet); a signal counts at 1.8 σ the wrong way, the card needs two. p10–p90 bands
  flagged a tenth of ordinary nights per signal by construction; the test holds the
  joint card under 3 % of stationary nights.
- **Strain is a TRIMP transform** (`21·(1−e^(−load/350))`), stated as such — never
  present it as WHOOP's algorithm. Its daily input prefers the device's own
  `time-in-heart-rate-zone` minutes (one cheap parts query) and only recomputes
  zones from raw samples for a bounded recent window.
- **A rest day is load 0; a pre-history day is null.** "Did not train" decays
  fitness; "before the account existed" must not invent a detraining spiral. The
  fitness/fatigue EWMAs seed at the first measured day for the same reason.
- **Sleep need is anchored on physiology, never on habit**: base 8 h (or the
  `sleepNeedHours` setting, 6–11), plus five minutes per strain point over 10 (≤ 45
  min) and **5 %** of standing debt. The median-of-your-own-nights base it replaced
  was circular (a 6h40 habit became a 6h40 need and readiness congratulated it), and
  Σ0.85^i over 14 nights is 5.08, so the old 25 % repayment gave the need↔debt loop
  a gain of 1.27 — above one, every short sleeper chased the cap. Debt comes from
  measured nights only (≥ 4 h; sub-4 h sessions are tracking noise); long nights
  repay at half rate; naps credit at half rate AND enter the debt arithmetic
  (`nightHours` returns main + ½ naps — the credit used to be printed and never
  applied). Sessions on the same day ≤ 90 min apart are STITCHED into one night with
  the gap as awake-in-bed (`stitchSessions`); everything that is not the night is
  listed under `naps`, a > 3 h daytime sleep flagged `long` rather than dropped. A
  stageless (CLASSIC) record is 92 % asleep, `stagesEstimated: true`, not 100 %
  efficient. Consistency does clock arithmetic on an 18:00-anchored scale so a
  23:40 and a 00:20 bedtime are 40 minutes apart, not 23 hours.
- **The symptom radar needs joint deviation** — two adverse signals for minor,
  three for major, at least three measurable vitals to speak at all — and its
  wording stays "signs of strain", never illness.
- **Correlation cards** are Spearman ρ over ≥ 21 paired days with every candidate
  pair corrected as ONE Benjamini–Hochberg family at FDR 0.10, plus a floor on the
  effect in real units; they report the above/below-median split in real units and
  say "associated", never "causes". The old `n ≥ 14, |r| ≥ 0.3` rule was p ≈ 0.3 per
  test and put a card on a noise month more often than not; the test holds it under
  20 % of noise months.
- The strength log (`strength_log` table, `/api/strength`) is the one manual
  input; its volume index sits BESIDE cardio load and is never summed into it.
- The demo workout-window cadence must remain no coarser than the one-minute coverage
  cap or every synthetic workout correctly looks like missing-watch data. Demo civil
  dates are formatted from LOCAL date parts — the UTC slice of a local midnight dated
  every daily summary a day early on a UTC+4 host, which left "today" without
  vitals. Demo units mirror the measured API (weight in grams, height in mm).

## Testing

`test/run.js` deliberately targets what fails *silently*: filter syntax, window
chunking, restatement, timezone bucketing, sleep anchoring, gap handling, the
webhook's auth ordering — and, for the derived layer, the failure modes that would
lie politely: a missing input moving a score, a rest day reading as unknown (or
the reverse), debt counting untracked nights, consistency breaking at midnight,
a detected session double-counting a recorded one, correlations reported from
thirteen days of data. Screen payloads are also exercised against an EMPTY
database: a new account must get calibration states, not crashes or zeros.
Rendering is checked by looking at the page — run `npm run demo` and open it.

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
