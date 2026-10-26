/**
 * Teams: an ordered roster that works one job together.
 *
 * Each role runs the hardened loop with its own mandate, tools and authority,
 * then posts its artifact to the shared bus. Later roles read what earlier roles
 * produced, which is how the employees "integrate" — the handoff is explicit and
 * typed, never implicit.
 */
import { runAgentLoop, FINISH_TOOL, type AgentAction, type LoopLimits } from '../kernel/loop.ts';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ArtifactBus } from './bus.ts';
import type { Role, RoleInput, RoleResult } from './roles.ts';

/** Workspace tools that change a file on disk. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

export interface TeamRun {
  workItem: string;
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  reason: string;
  results: { role: string; result: RoleResult }[];
  /** Files under change after the team ran (for downstream judging). */
  changes: Record<string, string>;
}

export interface TeamOptions {
  /** The whole-company goal. */
  goal: string;
  /** The work item this team owns. */
  workItem: string;
  /** The scope id for artifacts (usually `${workItem}#${attempt}`). */
  scope: string;
  /** The ordered roster. */
  roster: Role[];
  /** Shared artifact bus. */
  bus: ArtifactBus;
  limits?: LoopLimits;
  /** Files under change; a mutating role may add to this. */
  changes?: Record<string, string>;
  /** Stop the whole team if a role fails (default: true for producers of change). */
  stopOnFailure?: boolean;
  /** A directory a mutating role writes real files into, so the change map reflects disk. */
  workspaceDir?: string;
}

/** Derive a role result from the loop's terminal action. */
function interpret(role: Role, actions: AgentAction[], status: string, reason: string): RoleResult {
  const finish = [...actions].reverse().find((a) => a.tool === FINISH_TOOL);
  const data = (finish?.input?.data as Record<string, unknown> | undefined) ?? {};
  const summary = (finish?.input?.summary as string | undefined) ?? reason;
  return {
    ok: status === 'COMPLETED',
    kind: role.produces,
    summary,
    data,
    steps: actions.length,
    reason: status === 'COMPLETED' ? undefined : reason,
  };
}

export async function runTeam(options: TeamOptions): Promise<TeamRun> {
  const { goal, workItem, scope, roster, bus } = options;
  const stopOnFailure = options.stopOnFailure ?? true;
  const changes: Record<string, string> = { ...(options.changes ?? {}) };
  const results: { role: string; result: RoleResult }[] = [];

  for (const role of roster) {
    const input: RoleInput = {
      goal,
      workItem,
      scope,
      artifacts: bus.forScope(scope),
      changes: { ...changes },
    };

    // Give the brain the upstream artifacts and the files already under change.
    const memory = JSON.stringify({
      upstream: input.artifacts.map((a) => ({ kind: a.kind, author: a.author, summary: a.summary, data: a.data })),
      changes: input.changes,
    });

    const loop = await runAgentLoop({
      goal: `${role.title}: ${role.mandate} [${workItem}]`,
      tools: role.tools,
      brain: (state) => role.brain({ ...state, memory: state.memory }),
      authorize: role.authorize,
      limits: role.limits ?? options.limits,
      workspace: scope,
      memory,
      verifyCompletion: role.verifyCompletion,
    });

    const result = interpret(role, loop.steps.map((s) => s.action), loop.status, loop.reason);

    // QA evidence is derived from the commands the role actually ran, never from a
    // self-reported claim: a check counts only if the loop observed it pass.
    if (role.produces === 'evidence') {
      const observed = loop.steps
        .filter((s) => s.action.tool === 'run_check')
        .map((s) => ({ name: String(s.action.input?.command ?? 'check'), status: s.observation.ok ? 'PASSED' : 'FAILED' }));
      if (observed.length) result.data = { ...result.data, checks: observed };
    }

    // A mutating role records the files it changed. `files` must be a path->content
    // map; a plain list of touched names (e.g. from a design) is not a change.
    const wrote = result.data.files;
    if (wrote && typeof wrote === 'object' && !Array.isArray(wrote)) {
      Object.assign(changes, wrote as Record<string, string>);
    }
    // Capture files the role actually wrote to disk, so the change map reflects
    // real writes even when the brain did not enumerate them in its finish data.
    // `edit_file` is included: the role prompt requires it for existing files
    // (write_file is refused on an existing path), so an edit-only role would
    // otherwise report no change and the company would block a real success.
    if (options.workspaceDir) {
      for (const step of loop.steps) {
        if (!MUTATING_TOOLS.has(step.action.tool) || !step.observation.ok) continue;
        const rel = step.action.input?.path;
        if (typeof rel !== 'string') continue;
        try {
          changes[rel] = readFileSync(path.join(options.workspaceDir, rel), 'utf8');
        } catch {
          /* file vanished; skip */
        }
      }
    }

    bus.post({ kind: role.produces, author: role.id, scope, summary: result.summary, data: { ...result.data, changes: { ...changes } } });
    results.push({ role: role.id, result });

    if (!result.ok && stopOnFailure) {
      return { workItem, status: 'BLOCKED', reason: `${role.id} failed: ${result.reason ?? result.summary}`, results, changes };
    }
  }

  const failed = results.some((r) => !r.result.ok);
  return {
    workItem,
    status: failed ? 'BLOCKED' : 'COMPLETED',
    reason: failed ? 'one or more roles failed' : 'team completed the work item',
    results,
    changes,
  };
}
