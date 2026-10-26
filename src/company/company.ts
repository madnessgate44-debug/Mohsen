/**
 * The company: one goal in, an integrated result out.
 *
 * The supervisor decomposes the goal into work items, runs a *competition* on
 * each (several independent attempts), judges them on evidence, then integrates
 * only the winners and re-verifies the whole. Everything is bounded by a
 * company-wide budget and recorded on the artifact bus.
 */
import { ArtifactBus } from './bus.ts';
import { runTeam, type TeamRun } from './team.ts';
import { judgeCompetition, DEFAULT_RUBRIC, type Competition, type Rubric } from './judge.ts';
import type { Role } from './roles.ts';
import type { LoopLimits } from '../kernel/loop.ts';

export interface WorkItem {
  id: string;
  title: string;
}

export interface CompanyOptions {
  goal: string;
  /** Decomposition (the "CEO"): goal -> work items. Pure, so it is testable. */
  plan: (goal: string) => WorkItem[];
  /** Build the roster for one attempt. Different attempts may differ. */
  rosterFor: (item: WorkItem, attempt: number) => Role[];
  /** How many independent attempts compete per work item. Default 2. */
  attemptsPerItem?: number;
  /** Company-wide ceiling on total role-runs, so the org cannot run away. */
  maxRoleRuns?: number;
  bus?: ArtifactBus;
  limits?: LoopLimits;
  rubric?: Rubric[];
  /** Files under change at the start of the run. */
  changes?: Record<string, string>;
  /** A real directory mutating roles write into, so changes reflect disk. */
  workspaceDir?: string;
  /** Final gate: given the winners' merged changes, may the company ship? */
  integrate?: (state: { goal: string; winners: string[]; changes: Record<string, string>; bus: ArtifactBus }) => { ok: boolean; reason: string };
}

export interface CompanyRun {
  goal: string;
  items: { item: WorkItem; competition: Competition }[];
  /** Changes from the winning attempt of every work item. */
  integratedChanges: Record<string, string>;
  winners: string[];
  status: 'COMPLETED' | 'BLOCKED';
  reason: string;
  bus: ArtifactBus;
}

export async function runCompany(options: CompanyOptions): Promise<CompanyRun> {
  const { goal, plan, rosterFor } = options;
  const attemptsPerItem = Math.max(1, options.attemptsPerItem ?? 2);
  const maxRoleRuns = Math.max(1, options.maxRoleRuns ?? 40);
  const bus = options.bus ?? new ArtifactBus();
  const rubric = options.rubric ?? DEFAULT_RUBRIC;

  const items = plan(goal);
  const results: { item: WorkItem; competition: Competition }[] = [];
  let integratedChanges: Record<string, string> = { ...(options.changes ?? {}) };
  const winners: string[] = [];
  let roleRuns = 0;

  for (const item of items) {
    const runs: { attempt: string; run: TeamRun }[] = [];
    for (let attempt = 1; attempt <= attemptsPerItem; attempt += 1) {
      if (roleRuns >= maxRoleRuns) {
        return { goal, items: results, integratedChanges, winners, status: 'BLOCKED', reason: `company budget exhausted (${maxRoleRuns} role-runs)`, bus };
      }
      const roster = rosterFor(item, attempt);
      roleRuns += roster.length;
      const attemptId = `${item.id}#${attempt}`;
      const run = await runTeam({
        goal,
        workItem: item.title,
        scope: attemptId,
        roster,
        bus,
        limits: options.limits,
        changes: integratedChanges,
        workspaceDir: options.workspaceDir,
      });
      runs.push({ attempt: attemptId, run });
    }

    const competition = judgeCompetition(item.title, runs, bus, rubric);
    results.push({ item, competition });

    if (!competition.winner) {
      return { goal, items: results, integratedChanges, winners, status: 'BLOCKED', reason: `no eligible attempt for "${item.title}"`, bus };
    }
    winners.push(competition.winner);
    const winning = runs.find((r) => r.attempt === competition.winner)!.run;
    integratedChanges = { ...integratedChanges, ...winning.changes };
    bus.post({
      kind: 'decision',
      author: 'supervisor',
      scope: competition.winner,
      summary: competition.reason,
      data: { workItem: item.title, winner: competition.winner, scorecards: competition.scorecards },
    });
  }

  const verdict = options.integrate
    ? options.integrate({ goal, winners, changes: integratedChanges, bus })
    : { ok: true, reason: 'all work items resolved and integrated' };

  return {
    goal,
    items: results,
    integratedChanges,
    winners,
    status: verdict.ok ? 'COMPLETED' : 'BLOCKED',
    reason: verdict.reason,
    bus,
  };
}
