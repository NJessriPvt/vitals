'use strict';
/**
 * Synthetic data, shaped like the real thing.
 *
 * This exists for one reason: getting Google Health credentials is a multi-step,
 * out-of-band task (Cloud project, OAuth client, consent screen, a wearable actually
 * feeding the account). Without demo data the dashboard cannot be looked at, judged
 * or fixed until all of that is done — so charts would get built blind.
 *
 * Every generated point goes through the SAME normalize -> putPoints path as live
 * data and carries a realistic raw envelope, so demo mode exercises the real
 * pipeline rather than a parallel one. Demo rows are marked with platform "DEMO",
 * which is how the UI knows to say so out loud.
 */

const catalog = require('./catalog');
const db = require('./db');
const normalize = require('./normalize');

/** Deterministic PRNG — the same seed gives the same body, so charts are stable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function envelope(typeId, body, i) {
  const t = catalog.get(typeId);
  return {
    name: `users/demo/dataTypes/${typeId}/dataPoints/${i}`,
    dataSource: { recordingMethod: 'AUTO_DETECTED', platform: 'DEMO' },
    [t.payload]: body,
  };
}

const interval = (a, b) => ({ startTime: iso(a), endTime: iso(b) });

function generate(days = 180, seed = 20260815) {
  const rand = mulberry32(seed);
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  const byType = new Map();
  const push = (typeId, point) => {
    if (!byType.has(typeId)) byType.set(typeId, []);
    byType.get(typeId).push(point);
  };

  let weight = 78 + rand() * 4;
  let fitness = 0; // slow drift that ties resting HR, HRV and VO2 max together

  for (let d = days; d >= 0; d--) {
    const dayStart = midnight.getTime() - (d * 86400000);
    const dow = new Date(dayStart).getDay();
    const weekend = dow === 0 || dow === 6;
    const seq = (days - d) * 1000;

    // A body doesn't jump: fitness drifts, and everything derived from it follows.
    fitness += (rand() - 0.48) * 0.08;
    fitness = Math.max(-1, Math.min(1, fitness));

    const dayTarget = Math.round((weekend ? 6200 : 9100) + (rand() - 0.5) * 4200 + fitness * 900);
    const active = dayTarget > 8000;

    // ---- Steps, distance, floors: hourly interval points -------------------
    let stepsToday = 0;
    for (let h = 6; h <= 22; h++) {
      const peak = h === 8 || h === 13 || h === 18 ? 2.2 : 1;
      const share = (rand() * 0.9 + 0.35) * peak;
      const steps = Math.max(0, Math.round((dayTarget / 17) * share));
      stepsToday += steps;
      const a = dayStart + h * 3600000;
      const b = a + 3600000;
      if (steps > 0) {
        push('steps', envelope('steps', { interval: interval(a, b), count: String(steps) }, seq + h));
        push('distance', envelope('distance', {
          interval: interval(a, b),
          distanceMillimeters: Math.round(steps * 720),
        }, seq + h));
      }
    }
    push('floors', envelope('floors', {
      interval: interval(dayStart, dayStart + 86400000),
      count: String(Math.round(4 + rand() * 16)),
    }, seq));

    const activeMin = Math.round(18 + (stepsToday / 400) + rand() * 20);
    push('active-minutes', envelope('active-minutes', {
      interval: interval(dayStart, dayStart + 86400000), minutes: activeMin,
    }, seq));
    push('active-zone-minutes', envelope('active-zone-minutes', {
      interval: interval(dayStart, dayStart + 86400000),
      minutes: Math.round(activeMin * (0.35 + rand() * 0.35)),
    }, seq));
    push('sedentary-period', envelope('sedentary-period', {
      interval: interval(dayStart, dayStart + 86400000),
      durationMillis: Math.round((10 - (activeMin / 60)) * 3600000),
    }, seq));

    // ---- Energy ------------------------------------------------------------
    const bmr = 1680;
    const activeKcal = Math.round(stepsToday * 0.042 + rand() * 90);
    push('active-energy-burned', envelope('active-energy-burned', {
      interval: interval(dayStart, dayStart + 86400000), calories: activeKcal,
    }, seq));
    push('total-calories', envelope('total-calories', {
      interval: interval(dayStart, dayStart + 86400000), calories: bmr + activeKcal,
    }, seq));

    // ---- Heart: intraday samples on a circadian curve ----------------------
    const restHr = Math.round(58 - fitness * 4 + (rand() - 0.5) * 3);
    for (let m = 0; m < 1440; m += 10) {
      const hour = m / 60;
      const asleep = hour < 7 || hour >= 23;
      let hr = asleep
        ? restHr - 4 + rand() * 5
        : restHr + 8 + Math.sin((hour - 6) / 18 * Math.PI) * 12 + rand() * 9;
      // A workout leaves a visible spike, which is what makes the chart readable.
      if (active && !asleep && hour > 17.5 && hour < 18.6) hr += 45 + rand() * 20;
      push('heart-rate', envelope('heart-rate', {
        sampleTime: { physicalTime: iso(dayStart + m * 60000) },
        beatsPerMinute: Math.round(hr),
      }, seq + m));
    }
    push('daily-resting-heart-rate', envelope('daily-resting-heart-rate', {
      date: day(dayStart), beatsPerMinute: restHr,
    }, seq));
    push('daily-heart-rate-variability', envelope('daily-heart-rate-variability', {
      date: day(dayStart), dailyRmssd: Math.round(38 + fitness * 12 + (rand() - 0.5) * 10),
    }, seq));
    push('daily-oxygen-saturation', envelope('daily-oxygen-saturation', {
      date: day(dayStart), averagePercentage: Number((95.5 + rand() * 2.6).toFixed(1)),
    }, seq));
    push('daily-respiratory-rate', envelope('daily-respiratory-rate', {
      date: day(dayStart), breathsPerMinute: Number((13.5 + rand() * 3).toFixed(1)),
    }, seq));
    push('daily-vo2-max', envelope('daily-vo2-max', {
      date: day(dayStart), vo2Max: Number((41 + fitness * 5 + rand()).toFixed(1)),
    }, seq));

    // ---- Heart-rate zones (an ordered scale, drawn as a stack) -------------
    push('time-in-heart-rate-zone', envelope('time-in-heart-rate-zone', {
      interval: interval(dayStart, dayStart + 86400000),
      zones: [
        { zone: 'OUT_OF_RANGE', minutes: Math.round(1200 + rand() * 60) },
        { zone: 'FAT_BURN', minutes: Math.round(activeMin * 0.6) },
        { zone: 'CARDIO', minutes: active ? Math.round(12 + rand() * 18) : Math.round(rand() * 6) },
        { zone: 'PEAK', minutes: active ? Math.round(rand() * 8) : 0 },
      ],
    }, seq));

    // ---- Sleep: a session ENDING on this day, with stages ------------------
    const bedtime = dayStart - 3600000 + Math.round(rand() * 5400000); // ~23:00 ±
    const inBed = (6.4 + rand() * 2.1) * 3600000;
    const stages = [];
    let cursor = bedtime;
    const wake = bedtime + inBed;
    while (cursor < wake) {
      const roll = rand();
      const type = roll < 0.16 ? 'DEEP' : roll < 0.38 ? 'REM' : roll < 0.94 ? 'LIGHT' : 'AWAKE';
      const len = Math.min(wake - cursor, (12 + rand() * 45) * 60000);
      stages.push({ startTime: iso(cursor), endTime: iso(cursor + len), type });
      cursor += len;
    }
    push('sleep', envelope('sleep', {
      startTime: iso(bedtime), endTime: iso(wake), sleepType: 'STAGES', sleepStages: stages,
    }, seq));
    push('daily-sleep-temperature-derivations', envelope('daily-sleep-temperature-derivations', {
      date: day(dayStart), temperatureDeltaCelsius: Number(((rand() - 0.5) * 1.6).toFixed(2)),
    }, seq));

    // ---- Workouts, roughly three a week ------------------------------------
    if (active && rand() < 0.55) {
      const start = dayStart + 17.5 * 3600000;
      const dur = Math.round((28 + rand() * 42) * 60000);
      push('exercise', envelope('exercise', {
        interval: interval(start, start + dur),
        exerciseType: ['RUNNING', 'WALKING', 'CYCLING', 'STRENGTH_TRAINING'][Math.floor(rand() * 4)],
        displayName: 'Workout',
        activeDuration: `${Math.round(dur / 1000)}s`,
        metricsSummary: {
          caloriesKcal: Math.round(dur / 60000 * (7 + rand() * 4)),
          distanceMillimiters: Math.round(dur / 60000 * 160000),
          steps: String(Math.round(dur / 60000 * 105)),
          activeZoneMinutes: String(Math.round(dur / 60000 * 0.7)),
        },
      }, seq));
    }

    // ---- Body: weight every few days, drifting slowly ----------------------
    weight += (rand() - 0.52) * 0.14;
    if (d % 3 === 0) {
      push('weight', envelope('weight', {
        sampleTime: { physicalTime: iso(dayStart + 7 * 3600000) },
        weightKilograms: Number(weight.toFixed(1)),
      }, seq));
      push('body-fat', envelope('body-fat', {
        sampleTime: { physicalTime: iso(dayStart + 7 * 3600000) },
        percentage: Number((21 - fitness * 1.5 + rand() * 0.8).toFixed(1)),
      }, seq));
    }
    if (d === days) {
      push('height', envelope('height', {
        sampleTime: { physicalTime: iso(dayStart) }, heightCentimeters: 178,
      }, seq));
    }

    // ---- Intake ------------------------------------------------------------
    push('hydration-log', envelope('hydration-log', {
      interval: interval(dayStart, dayStart + 86400000),
      milliliters: Math.round(1400 + rand() * 1300),
    }, seq));
  }

  return byType;
}

/** Generate and store. Returns a per-type count. */
async function load(days = 180) {
  const byType = generate(days);
  const counts = {};
  const now = Date.now();

  for (const [typeId, points] of byType) {
    const type = catalog.get(typeId);
    const { rows } = normalize.normalizeBatch(points, type);
    await db.putPoints(rows);
    counts[typeId] = rows.length;
    await db.setCursor(typeId, {
      from_ms: now - days * 86400000,
      to_ms: now,
      backfill_done: 1,
      last_sync_ms: now,
      last_error: null,
    });
  }
  await db.setSetting('demo', '1');
  await db.addEvent('demo', null, `demo data loaded — ${days} days`, days);
  return counts;
}

async function isDemo() {
  return (await db.getSetting('demo', '')) === '1';
}

async function clear() {
  await db.clearAll();
  await db.setSetting('demo', '');
}

module.exports = { generate, load, clear, isDemo };
