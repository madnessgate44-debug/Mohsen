/**
 * Roles: the employees. A role is the hardened loop with a mandate, a scoped
 * toolset, an authority level, and a brain. The roster below is the default
 * company; callers can compose their own.
 */
import type { AgentBrain, AgentTool, Authorization } from '../kernel/loop.ts';
import type { ArtifactBus, ArtifactKind } from './bus.ts';

export type RoleId = 'pm' | 'architect' | 'implementer' | 'reviewer' | 'qa' | 'security' | 'docs' | 'release' | (string & {});

/** What a role is allowed to change. */
export type Authority = 'read-only' | 'branch-write';

export interface RoleInput {
  /** The company goal. */
  goal: string;
  /** The specific work item this role is acting on. */
  workItem: string;
  /** The scope id for artifacts produced here. */
  scope: string;
  /** Everything produced so far for this scope, oldest first. */
  artifacts: readonly import('./bus.ts').Artifact[];
  /** Files currently under change (for reviewers/QA). */
  changes?: Record<string, string>;
}

export interface RoleResult {
  /** Did the role finish its mandate? */
  ok: boolean;
  /** Artifact kind this role emits. */
  kind: ArtifactKind;
  summary: string;
  data: Record<string, unknown>;
  /** Steps taken (for evidence). */
  steps: number;
  reason?: string;
}

export interface Role {
  id: RoleId;
  title: string;
  mandate: string;
  authority: Authority;
  /** Which artifact kind this role consumes, if any. */
  consumes?: ArtifactKind;
  /** Which artifact kind this role produces. */
  produces: ArtifactKind;
  /** Tools this role may use (built by the caller, scoped to the workspace). */
  tools: AgentTool[];
  /** The decision-maker. Deterministic in tests; model-backed in production. */
  brain: AgentBrain;
  authorize?: Authorization;
  limits?: import('../kernel/loop.ts').LoopLimits;
  /** Independent gate on this role's completion (e.g. "a test must pass first"). */
  verifyCompletion?: (state: { goal: string; summary: string; history: import('../kernel/loop.ts').LoopStep[] }) => { ok: boolean; reason?: string };
}

/** The default roster: a small but complete software company. */
export const DEFAULT_ROSTER: { id: RoleId; title: string; mandate: string; authority: Authority; consumes?: ArtifactKind; produces: ArtifactKind }[] = [
  { id: 'pm', title: 'Product Manager', mandate: 'Turn the goal into testable requirements.', authority: 'read-only', produces: 'requirements' },
  { id: 'architect', title: 'Architect', mandate: 'Design the change and name the files it touches.', authority: 'read-only', consumes: 'requirements', produces: 'design' },
  { id: 'implementer', title: 'Implementer', mandate: 'Write the change and make the checks pass.', authority: 'branch-write', consumes: 'design', produces: 'change' },
  { id: 'reviewer', title: 'Reviewer', mandate: 'Read the change and find correctness flaws.', authority: 'read-only', consumes: 'change', produces: 'review' },
  { id: 'qa', title: 'QA Engineer', mandate: 'Run the real checks and record evidence.', authority: 'branch-write', consumes: 'change', produces: 'evidence' },
  { id: 'security', title: 'Security Engineer', mandate: 'Attack the change for escapes and unsafe writes.', authority: 'read-only', consumes: 'change', produces: 'security' },
  { id: 'release', title: 'Release Engineer', mandate: 'Decide whether the change may ship.', authority: 'read-only', consumes: 'evidence', produces: 'decision' },
];

export function findRole(roster: Role[], id: RoleId): Role | undefined {
  return roster.find((r) => r.id === id);
}

export type { ArtifactBus };
