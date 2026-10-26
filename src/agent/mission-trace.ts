/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * M3 — Deterministic mission execution trace.
 *
 * A mission moves through a fixed sequence of stages. Recording each stage
 * transition as a plain, serializable entry gives exhaustion and repeatability
 * runs an analyzable record of exactly what happened, without changing behaviour:
 * the trace is derived data, never a control input.
 */

export type MissionStageName =
  | 'INSPECT'
  | 'PLAN'
  | 'VALIDATE'
  | 'APPLY'
  | 'TEST'
  | 'COMMIT'
  | 'PR'
  | 'POLICY';

export type MissionStageStatus = 'STARTED' | 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface TraceEntry {
  stage: MissionStageName;
  status: MissionStageStatus;
  /** Mission-level attempt index (1-based) this entry belongs to. */
  attempt: number;
  at: string;
  detail?: string;
}

export interface MissionTraceSummary {
  totalEntries: number;
  attempts: number;
  failedStages: MissionStageName[];
  blockedStages: MissionStageName[];
  completed: boolean;
}

export function traceEntry(
  stage: MissionStageName,
  status: MissionStageStatus,
  attempt = 1,
  detail?: string,
  now: () => string = () => new Date().toISOString(),
): TraceEntry {
  return { stage, status, attempt, at: now(), ...(detail ? { detail } : {}) };
}

/**
 * Summarize a trace deterministically. `completed` means the mission reached a
 * terminal success stage (PR or COMMIT) with no FAILED/BLOCKED entries.
 */
export function summarizeTrace(entries: TraceEntry[]): MissionTraceSummary {
  const failedStages = [...new Set(entries.filter((e) => e.status === 'FAILED').map((e) => e.stage))];
  const blockedStages = [...new Set(entries.filter((e) => e.status === 'BLOCKED').map((e) => e.stage))];
  const reachedSuccess = entries.some((e) => e.status === 'PASSED' && (e.stage === 'PR' || e.stage === 'COMMIT'));
  return {
    totalEntries: entries.length,
    attempts: entries.reduce((max, e) => Math.max(max, e.attempt), 0),
    failedStages,
    blockedStages,
    completed: reachedSuccess && failedStages.length === 0 && blockedStages.length === 0,
  };
}
