/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TraceEntry } from '../agent/mission-trace.ts';

export type TaskStatus =
  | 'QUEUED'
  | 'VALIDATING'
  | 'INSPECTING'
  | 'PLANNING'
  | 'EDITING'
  | 'TESTING'
  | 'VERIFYING'
  | 'PR_OPENED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export type RequirementStatus = 'PENDING' | 'PASS' | 'FAIL' | 'BLOCKED';

export interface TaskRequirement {
  id: string;
  description: string;
  acceptanceCriteria: string;
  status: RequirementStatus;
  evidence?: string;
  /** Checks the model predicts verify this requirement. */
  checkCommands?: string[];
  /** Reason this requirement cannot be verified automatically. */
  manualReviewNote?: string;
}

export interface RequirementEvidenceInput {
  acceptanceCriteria?: string;
  description?: string;
  /** Checks the model predicts verify this requirement. */
  checkCommands?: string[];
  /** Reason this requirement cannot be verified automatically. */
  manualReviewNote?: string;
}

export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  targetRepo: string; // e.g. madnessgate44-debug/Firstborn
  targetBranch: string; // e.g. main
  createdAt: string;
  author: string;
  allowPrCreation: boolean;
}

export interface TestExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  status: 'PASSED' | 'FAILED' | 'ERROR';
}

export interface FileChangePlan {
  path: string;
  action: 'create' | 'modify' | 'delete';
  rationale: string;
  content?: string;
  edits?: { find: string; replace: string }[];
}

export interface TaskExecutionReport {
  taskId: string;
  status: TaskStatus;
  startTime: string;
  endTime?: string;
  baseCommitSha: string;
  headCommitSha?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  modelInvoked: {
    provider: string;
    model: string;
    callsCount: number;
    fallbackUsed?: boolean;
    keylessRouteErrors?: string[];
  };
  requirements: TaskRequirement[];
  plannedChanges: FileChangePlan[];
  testResults: TestExecutionResult[];
  /** M3: ordered stage transitions for exhaustion/repeatability analysis. */
  trace?: TraceEntry[];
  /** M4: structured root-cause diagnosis, populated when a mission does not reach PR_OPENED. */
  diagnosis?: import('../agent/diagnosis.ts').Diagnosis;
  logs: { timestamp: string; level: 'info' | 'warn' | 'error'; message: string }[];
  errorMessage?: string;
  blockerReason?: string;
}
