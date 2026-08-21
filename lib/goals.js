'use strict';
/**
 * Goals — three daily rings, targets that adapt to state, and milestones.
 *
 * The design bias is Oura's, not the drill sergeant's: on a low-readiness morning
 * the movement targets COME DOWN, visibly, with the reason attached. A goal that
 * ignores what the body said overnight is a nag; one that flexes is a coach.
 *
 * Rings are Move (active calories), Train (zone minutes) and Recover (sleep vs
 * need) — recovery is a goal to close, not the absence of one.
 */

const stats = require('./stats');

const { clamp, round } = stats;

/**
 * Pure: today's targets from trailing medians and this morning's readiness.
 * Baselines are the person's own 28-day medians so the goal ratchets with real
 * behaviour; bounds stop a bad month from shrinking the goal into meaninglessness.
 */
function buildAdaptiveGoals({
  stepsMedian, activeCalMedian, readinessScore, tonightNeedHours, weeklyAzmTarget = 150,
}) {
  const lowDay = Number.isFinite(readinessScore) && readinessScore < 45;
  const factor = lowDay ? 0.8 : 1;
  const reason = lowDay ? `lowered — readiness ${readinessScore}` : null;

  const steps = Number.isFinite(stepsMedian)
    ? Math.round(clamp(stepsMedian * factor, 4000, 16000) / 250) * 250
    : 10000;
  const moveKcal = Number.isFinite(activeCalMedian)
    ? Math.round(clamp(activeCalMedian * factor, 200, 900) / 10) * 10
    : 500;
  const trainAzm = Math.round((weeklyAzmTarget / 7) * (lowDay ? 0.5 : 1));
  const recoverHours = Number.isFinite(tonightNeedHours) ? round(tonightNeedHours, 1) : 8;

  return {
    steps: { goal: steps, reason },
    move: { goal: moveKcal, unit: 'kcal', reason },
    train: { goal: trainAzm, unit: 'AZM', reason: lowDay ? reason : `${weeklyAzmTarget}/week (WHO guideline) ÷ 7` },
    recover: { goal: recoverHours, unit: 'h', reason: 'tonight’s computed sleep need' },
    adapted: lowDay,
    derived: true,
    method: 'Move and steps are your own 28-day medians (bounded), ×0.8 on readiness under 45; Train is the WHO 150 weekly zone minutes split daily; Recover is tonight’s sleep need.',
  };
}

/** Pure: ring fill fractions from today's actuals. A ring with no goal stays null. */
function buildRings(goals, { activeCalories, activeZoneMinutes, sleepHours }) {
  const ring = (id, label, value, goal, unit) => ({
    id,
    label,
    value: round(value, unit === 'h' ? 2 : 0),
    goal,
    unit,
    fraction: Number.isFinite(value) && Number.isFinite(goal) && goal > 0
      ? round(Math.min(1.5, value / goal), 3) : null,
    closed: Number.isFinite(value) && Number.isFinite(goal) && value >= goal,
  });
  return [
    ring('move', 'Move', activeCalories, goals.move.goal, 'kcal'),
    ring('train', 'Train', activeZoneMinutes, goals.train.goal, 'AZM'),
    ring('recover', 'Recover', sleepHours, goals.recover.goal, 'h'),
  ];
}

// ---------------------------------------------------------------------------
// Badges & lifetime milestones
// ---------------------------------------------------------------------------

/**
 * Ladder badges over lifetime odometers plus a few one-off records. Every badge
 * states its exact rule — a trophy whose criterion is a mystery is just clip art.
 */
const LADDERS = [
  { id: 'distance', label: 'Distance walked', unit: 'km', steps: [100, 500, 1000, 2500, 5000, 10000] },
  { id: 'steps', label: 'Lifetime steps', unit: '', steps: [1e6, 5e6, 10e6, 25e6, 50e6] },
  { id: 'floors', label: 'Floors climbed', unit: 'floors', steps: [500, 1000, 2500, 5000, 10000] },
  { id: 'sessions', label: 'Workouts', unit: '', steps: [10, 50, 100, 250, 500, 1000] },
  { id: 'nights', label: 'Nights tracked', unit: '', steps: [30, 100, 365, 730, 1500] },
];

function buildBadges(totals, records = []) {
  const fmt = (v) => (v >= 1e6 ? `${v / 1e6}M` : v >= 1000 ? `${(v / 1000).toLocaleString()}k` : String(v));
  const badges = [];
  for (const ladder of LADDERS) {
    const total = totals[ladder.id];
    if (!Number.isFinite(total)) continue;
    const earned = ladder.steps.filter((s) => total >= s);
    const next = ladder.steps.find((s) => total > 0 && total < s) || null;
    badges.push({
      id: ladder.id,
      label: ladder.label,
      unit: ladder.unit,
      total: Math.round(total),
      earned: earned.map((s) => ({ threshold: s, label: `${fmt(s)} ${ladder.unit || ladder.label.toLowerCase()}`.trim() })),
      next: next ? {
        threshold: next,
        progress: round(total / next, 3),
        label: `${fmt(next)} ${ladder.unit || ladder.label.toLowerCase()}`.trim(),
      } : null,
    });
  }
  return {
    badges,
    records,
    earnedCount: badges.reduce((a, b) => a + b.earned.length, 0),
    derived: true,
    method: 'Ladder thresholds over lifetime totals from the whole synced history; each badge names its exact rule.',
  };
}

/** Longest run of consecutive goal-met days in a dense daily series. */
function longestStreak(values, goal) {
  let best = 0;
  let cur = 0;
  for (const v of values) {
    if (v !== null && Number.isFinite(v) && v >= goal) { cur += 1; best = Math.max(best, cur); } else cur = 0;
  }
  return best;
}

module.exports = { buildAdaptiveGoals, buildRings, buildBadges, longestStreak, LADDERS };
