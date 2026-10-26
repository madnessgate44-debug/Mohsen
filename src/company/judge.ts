/**
 * Judges: how the company decides which attempt wins.
 *
 * Scoring is deterministic and evidence-only. A claim earns nothing; a passing
 * check earns points. Every lookup is scoped to the attempt being scored, so one
 * attempt can never win on another attempt's evidence. The rubric is pure, so it
 * can be unit-tested and audited, and two attempts with identical evidence always
 * rank the same way.
 */
import type { ArtifactBus } from './bus.ts';
import type { TeamRun } from './team.ts';

export interface RubricContext {
  /** The attempt scope being scored, e.g. `w1#2`. */
  attempt: string;
  run: TeamRun;
  bus: ArtifactBus;
}

export interface Scorecard {
  attempt: string;
  criteria: Record<string, number>;
  total: number;
  eligible: boolean;
  notes: string[];
}

export interface Rubric {
  name: string;
  points: number;
  mandatory?: boolean;
  test: (ctx: RubricContext) => boolean;
}

function evidenceChecks(ctx: RubricContext): { name: string; status: string }[] {
  return (ctx.bus.latest(ctx.attempt, 'evidence')?.data.checks as { name: string; status: string }[] | undefined) ?? [];
}

function passing(ctx: RubricContext, check: string): boolean {
  return evidenceChecks(ctx).some((c) => c.name === check && c.status === 'PASSED');
}

function latestInScope(ctx: RubricContext, kind: 'review' | 'security') {
  return ctx.bus.latest(ctx.attempt, kind);
}

/** The default rubric: real checks and real evidence beat confident summaries. */
export const DEFAULT_RUBRIC: Rubric[] = [
  { name: 'completed', points: 3, mandatory: true, test: ({ run }) => run.status === 'COMPLETED' },
  { name: 'tests-pass', points: 5, mandatory: true, test: (ctx) => passing(ctx, 'test') },
  { name: 'lint-clean', points: 2, test: (ctx) => passing(ctx, 'lint') },
  { name: 'review-clean', points: 2, test: (ctx) => Number(latestInScope(ctx, 'review')?.data.blockers ?? 1) === 0 },
  { name: 'security-clean', points: 3, mandatory: true, test: (ctx) => latestInScope(ctx, 'security')?.data.clean === true },
  { name: 'has-change', points: 1, test: ({ run }) => Object.keys(run.changes).length > 0 },
];

export function scoreAttempt(attempt: string, run: TeamRun, bus: ArtifactBus, rubric: Rubric[] = DEFAULT_RUBRIC): Scorecard {
  const ctx: RubricContext = { attempt, run, bus };
  const criteria: Record<string, number> = {};
  const notes: string[] = [];
  let total = 0;
  let eligible = true;
  for (const r of rubric) {
    const pass = r.test(ctx);
    criteria[r.name] = pass ? r.points : 0;
    if (pass) total += r.points;
    if (!pass && r.mandatory) {
      eligible = false;
      notes.push(`ineligible: mandatory "${r.name}" not met`);
    } else if (!pass) {
      notes.push(`missed "${r.name}" (-${r.points})`);
    }
  }
  return { attempt, criteria, total, eligible, notes };
}

export interface Competition {
  workItem: string;
  scorecards: Scorecard[];
  winner: string | null;
  reason: string;
}

/**
 * Rank attempts deterministically: eligible first, then by total points, then by
 * attempt id, so the outcome never depends on order of arrival.
 */
export function judgeCompetition(workItem: string, runs: { attempt: string; run: TeamRun }[], bus: ArtifactBus, rubric: Rubric[] = DEFAULT_RUBRIC): Competition {
  const scorecards = runs.map(({ attempt, run }) => scoreAttempt(attempt, run, bus, rubric));
  const ranked = [...scorecards].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.total !== b.total) return b.total - a.total;
    return a.attempt < b.attempt ? -1 : a.attempt > b.attempt ? 1 : 0;
  });
  const best = ranked[0];
  if (!best || !best.eligible) {
    return { workItem, scorecards, winner: null, reason: 'no attempt met the mandatory criteria' };
  }
  return { workItem, scorecards, winner: best.attempt, reason: `attempt "${best.attempt}" won with ${best.total} point(s)` };
}
