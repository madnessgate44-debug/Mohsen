/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * R7 — Permission control plane ("ultimate control").
 *
 * This module is the single authority for how much a mission may do to GitHub.
 * It is deliberately conservative: the default profile preserves the existing
 * behaviour (commit to an isolated branch and open a reviewable PR), and every
 * broader capability must be enabled explicitly by an operator. Nothing here
 * widens the agent's authority on its own.
 *
 * The decision is pure and deterministic so it is unit-testable and auditable.
 */

export type PermissionProfile = 'readonly' | 'sandbox' | 'review' | 'publish';

const PROFILE_RANK: Record<PermissionProfile, number> = {
  readonly: 0,
  sandbox: 1,
  review: 2,
  publish: 3,
};

export interface PermissionConfig {
  profile: PermissionProfile;
  /** When true, the effective profile is capped at `sandbox` — human sign-off required. */
  requireHumanApproval: boolean;
  /** Sandbox branches must start with this prefix. */
  allowedBranchPrefix: string;
  /** Branches the agent must never push to. */
  forbiddenBranches: string[];
  /** Repositories the agent may act on (`owner/repo`). Empty list = use default. */
  allowedRepos: string[];
}

export interface PermissionRequest {
  /** The caller's explicit consent to write to GitHub (task.allowPrCreation). */
  requestedPrCreation: boolean;
  /** The isolated branch the agent would push to. */
  branchName: string;
  /** The base branch the PR would target. */
  targetBranch: string;
  /** Target repository as `owner/repo`. */
  repo: string;
}

export interface PermissionDecision {
  profile: PermissionProfile;
  effectiveProfile: PermissionProfile;
  allowBranchWrite: boolean;
  allowCommit: boolean;
  allowOpenPr: boolean;
  /** Reserved capability; merge is never granted by this module. */
  allowMerge: boolean;
  reason: string;
  violations: string[];
}

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isProfile(value: string): value is PermissionProfile {
  return value in PROFILE_RANK;
}

export function loadPermissionConfig(env: NodeJS.ProcessEnv = process.env): PermissionConfig {
  const rawProfile = (env.FORGE_PERMISSION_PROFILE ?? 'review').trim().toLowerCase();
  const profile: PermissionProfile = isProfile(rawProfile) ? rawProfile : 'review';
  return {
    profile,
    requireHumanApproval: envFlag(env, 'FORGE_REQUIRE_HUMAN_APPROVAL', false),
    allowedBranchPrefix: (env.FORGE_ALLOWED_BRANCH_PREFIX ?? 'forge/task-').trim(),
    forbiddenBranches: (env.FORGE_FORBIDDEN_BRANCHES ?? 'main,master')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowedRepos: (env.FORGE_ALLOWED_REPOS ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

/** The most restrictive of two profiles. */
function minProfile(a: PermissionProfile, b: PermissionProfile): PermissionProfile {
  return PROFILE_RANK[a] <= PROFILE_RANK[b] ? a : b;
}

export function evaluatePermissionPolicy(
  req: PermissionRequest,
  cfg: PermissionConfig = loadPermissionConfig(),
): PermissionDecision {
  const effectiveProfile = cfg.requireHumanApproval ? minProfile(cfg.profile, 'sandbox') : cfg.profile;
  const rank = PROFILE_RANK[effectiveProfile];

  const violations: string[] = [];
  if (cfg.allowedRepos.length && !cfg.allowedRepos.includes(req.repo.toLowerCase())) {
    violations.push(`repository ${req.repo} is not in the allowlist`);
  }
  const branch = req.branchName.toLowerCase();
  if (rank >= PROFILE_RANK.sandbox) {
    if (cfg.forbiddenBranches.includes(branch)) {
      violations.push(`branch ${req.branchName} is protected`);
    }
    if (!branch.startsWith(cfg.allowedBranchPrefix.toLowerCase())) {
      violations.push(`branch ${req.branchName} does not start with the allowed prefix ${cfg.allowedBranchPrefix}`);
    }
  }
  if (cfg.forbiddenBranches.includes(req.targetBranch.toLowerCase()) && req.targetBranch.toLowerCase() === branch) {
    violations.push(`target branch ${req.targetBranch} must not be pushed to directly`);
  }

  const writesPermitted = violations.length === 0;
  const consented = req.requestedPrCreation;
  const allowBranchWrite = writesPermitted && consented && rank >= PROFILE_RANK.sandbox;
  const allowCommit = allowBranchWrite;
  const allowOpenPr = writesPermitted && consented && rank >= PROFILE_RANK.review;
  const allowMerge = false;

  let reason: string;
  if (!writesPermitted) {
    reason = `denied by policy: ${violations.join('; ')}`;
  } else if (!consented) {
    reason = 'caller did not authorize GitHub writes (allowPrCreation=false)';
  } else if (rank < PROFILE_RANK.sandbox) {
    reason = `profile '${effectiveProfile}' is read-only: no branch, commit, or PR`;
  } else if (rank < PROFILE_RANK.review) {
    reason = `profile '${effectiveProfile}': sandbox branch and commit allowed, PR withheld`;
  } else {
    reason = `profile '${effectiveProfile}': branch, commit, and PR allowed`;
  }
  if (cfg.requireHumanApproval && cfg.profile !== effectiveProfile) {
    reason += ' (capped by FORGE_REQUIRE_HUMAN_APPROVAL)';
  }

  return {
    profile: cfg.profile,
    effectiveProfile,
    allowBranchWrite,
    allowCommit,
    allowOpenPr,
    allowMerge,
    reason,
    violations,
  };
}
