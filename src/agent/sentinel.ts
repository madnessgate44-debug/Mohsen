/**
 * M3 — The Sentinel: an independent verifier that replaces the human merge gate.
 *
 * Forge writes to an isolated branch and opens a PR. The Sentinel is a SEPARATE
 * workflow run (fresh context, never Forge approving itself) that re-runs the
 * deterministic checks and decides whether the PR may merge into `main`.
 *
 * Tests-first policy: the deterministic checks (lint/build/test) are the
 * authority. The model judge is an optional extra signal that can only make the
 * Sentinel MORE cautious (hold on uncertain/reject); it is never the sole gate.
 *
 * The decision is pure and deterministic so it is unit-testable and auditable.
 */

export interface CheckResult {
  name: string;
  passed: boolean;
}

export type ModelVerdict = 'approve' | 'reject' | 'uncertain';

export interface SentinelConfig {
  /** Only branches with this prefix may be auto-merged (Forge's isolated branches). */
  allowedSourcePrefix: string;
  /** Source branches that may never be merged (e.g. the default branch itself). */
  forbiddenSourceBranches: string[];
  /** Every one of these checks must have run and passed. */
  requiredChecks: string[];
  /** When true, a model verdict of reject/uncertain blocks the merge. */
  modelJudgeEnabled: boolean;
}

export interface SentinelInput {
  sourceBranch: string;
  targetBranch: string;
  checks: CheckResult[];
  config: SentinelConfig;
  modelVerdict?: ModelVerdict;
}

export interface MergeDecision {
  /** True only when every gate passed. */
  merge: boolean;
  /** True when the Sentinel deliberately held instead of merging (uncertain/insufficient). */
  hold: boolean;
  reason: string;
  violations: string[];
}

export function loadSentinelConfig(env: NodeJS.ProcessEnv = process.env): SentinelConfig {
  return {
    allowedSourcePrefix: (env.SENTINEL_ALLOWED_SOURCE_PREFIX ?? 'forge/').trim(),
    forbiddenSourceBranches: (env.SENTINEL_FORBIDDEN_SOURCE_BRANCHES ?? 'main,master')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    requiredChecks: (env.SENTINEL_REQUIRED_CHECKS ?? 'lint,build,test')
      .split(',').map((s) => s.trim()).filter(Boolean),
    modelJudgeEnabled: ['1', 'true', 'yes', 'on'].includes(
      (env.SENTINEL_MODEL_JUDGE ?? '').trim().toLowerCase()
    ),
  };
}

export function decideMerge(input: SentinelInput): MergeDecision {
  const { sourceBranch, targetBranch, checks, config, modelVerdict } = input;
  const violations: string[] = [];

  // Gate 1 — the source must be an isolated Forge branch, never the default branch.
  const source = (sourceBranch ?? '').trim();
  if (!source) {
    violations.push('No source branch was provided.');
  } else if (source.toLowerCase() === targetBranch.trim().toLowerCase()) {
    violations.push(`Source branch equals the target branch (${targetBranch}); refusing a direct write.`);
  } else if (config.forbiddenSourceBranches.includes(source.toLowerCase())) {
    violations.push(`Source branch "${source}" is forbidden.`);
  } else if (!source.startsWith(config.allowedSourcePrefix)) {
    violations.push(`Source branch "${source}" is outside the allowed prefix "${config.allowedSourcePrefix}".`);
  }

  // Gate 2 — deterministic checks are the authority. Every required check must
  // have run and passed. A missing check is treated as a failure, never a pass.
  const byName = new Map(checks.map((c) => [c.name, c.passed]));
  for (const required of config.requiredChecks) {
    if (!byName.has(required)) {
      violations.push(`Required check "${required}" did not run.`);
    } else if (!byName.get(required)) {
      violations.push(`Required check "${required}" failed.`);
    }
  }

  // Gate 3 — optional model judge. It can only add caution.
  let hold = false;
  if (config.modelJudgeEnabled) {
    if (modelVerdict === 'reject') {
      violations.push('Model judge rejected the change.');
    } else if (modelVerdict === 'uncertain' || modelVerdict === undefined) {
      hold = true;
      violations.push(`Model judge could not approve (${modelVerdict ?? 'no verdict'}); holding for review.`);
    }
  }

  if (violations.length > 0) {
    return {
      merge: false,
      hold,
      reason: hold
        ? 'Held: verification was inconclusive; no merge performed.'
        : `Blocked: ${violations[0]}`,
      violations,
    };
  }

  return {
    merge: true,
    hold: false,
    reason: `Verified: all required checks passed (${config.requiredChecks.join(', ')}). Safe to merge as one revertable commit.`,
    violations: [],
  };
}
