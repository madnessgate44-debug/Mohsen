/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * M4 — Self-diagnosis for a failed mission.
 *
 * When a mission does not reach PR_OPENED, the report already contains enough
 * evidence to say why: the terminal status, the blocker/error text, the ordered
 * trace, the target-check results, and the keyless route errors. This module
 * turns that evidence into a structured diagnosis with a bounded, advisory
 * recovery plan.
 *
 * It is deterministic and pure: no network, no model, no filesystem. Recovery
 * plans are recommendations for an operator or the mission runner; they are
 * never executed here, so a diagnosis can never change mission behaviour.
 */

import type { MissionStageName } from './mission-trace.ts';

export type DiagnosisCategory =
  | 'MODEL_ROUTE'
  | 'CHECK_FAILURE'
  | 'NO_SUBSTANTIVE_CHECKS'
  | 'ENVIRONMENT'
  | 'BASE_MOVED'
  | 'REPO_INSPECTION'
  | 'VALIDATION'
  | 'POLICY'
  | 'GITHUB'
  | 'UNKNOWN';

export type DiagnosisSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export type RecoveryAction =
  | 'RETRY_MISSION'
  | 'REFRESH_BASE_AND_RETRY'
  | 'VERIFY_KEYLESS_ROUTE'
  | 'INSPECT_CHECK_OUTPUT'
  | 'DEFINE_PROJECT_CHECK_SCRIPT'
  | 'FIX_INPUTS'
  | 'MANUAL_REVIEW';

export interface Diagnosis {
  category: DiagnosisCategory;
  severity: DiagnosisSeverity;
  /** One-line human summary of the root cause. */
  summary: string;
  /** Ordered stage names that reported FAILED/BLOCKED, if any. */
  failedStages: MissionStageName[];
  /** Commands of target checks that did not pass. */
  failedChecks: string[];
  /** Advisory, bounded recovery steps. Never auto-executed by this module. */
  recovery: RecoveryAction[];
  /** Whether a bounded automatic retry is reasonable for this category. */
  retryable: boolean;
}

export interface DiagnosisInput {
  status: string;
  errorMessage?: string;
  blockerReason?: string;
  trace?: { stage: MissionStageName; status: string }[];
  testResults?: { command: string; status: string }[];
  keylessRouteErrors?: string[];
}

function failedStagesOf(input: DiagnosisInput): MissionStageName[] {
  const seen = new Set<MissionStageName>();
  for (const entry of input.trace ?? []) {
    if (entry.status === 'FAILED' || entry.status === 'BLOCKED') seen.add(entry.stage);
  }
  return [...seen];
}

function failedChecksOf(input: DiagnosisInput): string[] {
  return [...new Set((input.testResults ?? []).filter((r) => r.status !== 'PASSED').map((r) => r.command))];
}

function haystack(input: DiagnosisInput): string {
  return [input.errorMessage, input.blockerReason, ...(input.keylessRouteErrors ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Classify a non-success report. Success statuses are never diagnosed; callers
 * should only invoke this for FAILED/BLOCKED reports.
 */
export function diagnoseMission(input: DiagnosisInput): Diagnosis {
  const failedStages = failedStagesOf(input);
  const failedChecks = failedChecksOf(input);
  const text = haystack(input);

  const base: Omit<Diagnosis, 'category' | 'severity' | 'summary' | 'recovery' | 'retryable'> = {
    failedStages,
    failedChecks,
  };

  if (text.includes('model') && (text.includes('route') || text.includes('generation failed') || text.includes('json') || input.keylessRouteErrors?.length)) {
    return {
      ...base,
      category: 'MODEL_ROUTE',
      severity: 'HIGH',
      summary: 'The keyless model route did not return a usable plan or patch.',
      recovery: ['VERIFY_KEYLESS_ROUTE', 'RETRY_MISSION'],
      retryable: true,
    };
  }

  if (text.includes('no recognized') || text.includes('no substantive') || text.includes('whitespace validation alone')) {
    return {
      ...base,
      category: 'NO_SUBSTANTIVE_CHECKS',
      severity: 'MEDIUM',
      summary: 'The target repository exposes no test, lint, build, or model-smoke script, so a change cannot be authorized.',
      recovery: ['DEFINE_PROJECT_CHECK_SCRIPT'],
      retryable: false,
    };
  }

  if (text.includes('dependency installation failed') || text.includes('npm install') || text.includes('exit code')) {
    return {
      ...base,
      category: 'ENVIRONMENT',
      severity: 'MEDIUM',
      summary: 'The target project environment failed to install or a check exited non-zero.',
      recovery: failedChecks.length ? ['INSPECT_CHECK_OUTPUT', 'RETRY_MISSION'] : ['RETRY_MISSION'],
      retryable: true,
    };
  }

  if (text.includes('moved during') || text.includes('base moved') || text.includes('branch moved')) {
    return {
      ...base,
      category: 'BASE_MOVED',
      severity: 'LOW',
      summary: 'The target branch advanced while the mission was inspecting it.',
      recovery: ['REFRESH_BASE_AND_RETRY'],
      retryable: true,
    };
  }

  if (text.includes('repository inspection failed') || text.includes('repository not found') || text.includes('could not be resolved')) {
    return {
      ...base,
      category: 'REPO_INSPECTION',
      severity: 'MEDIUM',
      summary: 'The target repository or branch could not be inspected (missing, or the token lacks read access).',
      recovery: ['FIX_INPUTS', 'MANUAL_REVIEW'],
      retryable: false,
    };
  }

  if (text.includes('validation failed') || text.includes('invalid target repository') || text.includes('cannot be empty') || text.includes('too large')) {
    return {
      ...base,
      category: 'VALIDATION',
      severity: 'MEDIUM',
      summary: 'The task definition or supplied context failed input validation.',
      recovery: ['FIX_INPUTS'],
      retryable: false,
    };
  }

  if (text.includes('policy') || text.includes('permission')) {
    return {
      ...base,
      category: 'POLICY',
      severity: 'HIGH',
      summary: 'The permission policy withheld an action (commit or pull request).',
      recovery: ['MANUAL_REVIEW'],
      retryable: false,
    };
  }

  if (text.includes('pull request') || text.includes('git commit') || text.includes('commit blocked') || text.includes('pr opening') || text.includes('github')) {
    return {
      ...base,
      category: 'GITHUB',
      severity: 'MEDIUM',
      summary: 'A GitHub operation (commit or pull request) failed.',
      recovery: ['RETRY_MISSION', 'MANUAL_REVIEW'],
      retryable: true,
    };
  }

  if (failedChecks.length > 0) {
    return {
      ...base,
      category: 'CHECK_FAILURE',
      severity: 'MEDIUM',
      summary: 'The proposed patch failed one or more target checks.',
      recovery: ['INSPECT_CHECK_OUTPUT', 'RETRY_MISSION'],
      retryable: true,
    };
  }

  return {
    ...base,
    category: 'UNKNOWN',
    severity: 'MEDIUM',
    summary: 'The mission stopped without a classified root cause; inspect the trace and logs.',
    recovery: ['MANUAL_REVIEW'],
    retryable: false,
  };
}

/**
 * Decide whether a mission should be automatically re-run. Bounded and
 * conservative: only a classified, retryable diagnosis earns a retry, and never
 * more than `maxRetries` of them. Returns false for an absent diagnosis so a
 * mission without one is never re-run blindly.
 */
export function shouldAutoRetry(
  diagnosis: Diagnosis | undefined,
  attempt: number,
  maxRetries: number,
): boolean {
  if (!diagnosis) return false;
  if (maxRetries <= 0) return false;
  if (!diagnosis.retryable) return false;
  return attempt < maxRetries;
}
