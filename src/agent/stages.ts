/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileChangePlan } from '../types/agent.ts';

export interface EditApplication {
  ok: boolean;
  content: string;
  error?: string;
}

/**
 * Apply exact-anchor edits to one file's content. Each find string must occur
 * exactly once, so an ambiguous or missing anchor is a hard, reported error
 * rather than a silent partial edit.
 */
export function applyExactEdits(content: string, edits: { find: string; replace: string }[]): EditApplication {
  let current = content;
  for (const edit of edits) {
    if (!edit || typeof edit.find !== 'string' || edit.find.length === 0 || typeof edit.replace !== 'string') {
      return { ok: false, content: current, error: 'Malformed exact-edit entry.' };
    }
    const first = current.indexOf(edit.find);
    if (first < 0) {
      return { ok: false, content: current, error: `Exact anchor not found: ${JSON.stringify(edit.find.slice(0, 100))}` };
    }
    const second = current.indexOf(edit.find, first + edit.find.length);
    if (second >= 0) {
      return { ok: false, content: current, error: `Anchor is ambiguous: ${JSON.stringify(edit.find.slice(0, 100))}` };
    }
    current = current.slice(0, first) + edit.replace + current.slice(first + edit.find.length);
  }
  return { ok: true, content: current };
}

export interface MissionStage {
  id: string;
  /** File changes for this stage only. */
  changes: FileChangePlan[];
  /** Check command expected to verify this stage, if any. */
  check?: string;
}

export type StageStatus = 'APPLIED' | 'FAILED' | 'SKIPPED';

export interface StageOutcome {
  id: string;
  status: StageStatus;
  problems: string[];
  checkPassed?: boolean;
}

export interface StagedMissionResult {
  stages: StageOutcome[];
  finalContents: Record<string, string>;
  appliedStages: number;
  completed: boolean;
}

/**
 * Execute an ordered, bounded sequence of file-edit stages against a snapshot of
 * file contents. A stage is applied only after its anchors validate against the
 * cumulative contents; if a stage fails validation or its check fails, the
 * mission stops and every remaining stage is SKIPPED. This guarantees a failing
 * stage is never treated as success and that the final contents reflect only
 * validated, applied stages.
 */
export async function runStagedMission(
  stages: MissionStage[],
  initialContents: Record<string, string>,
  runCheck?: (stage: MissionStage) => Promise<boolean>
): Promise<StagedMissionResult> {
  const contents: Record<string, string> = { ...initialContents };
  const outcomes: StageOutcome[] = [];
  let completed = true;

  for (const stage of stages) {
    const problems: string[] = [];
    const nextContents: Record<string, string> = { ...contents };

    for (const change of stage.changes) {
      if (change.action === 'create') {
        if (contents[change.path] !== undefined) {
          problems.push(`${change.path}: stage marked existing file as create.`);
          continue;
        }
        if (typeof change.content !== 'string' || change.content.length === 0) {
          problems.push(`${change.path}: create needs content.`);
          continue;
        }
        nextContents[change.path] = change.content;
        continue;
      }
      if (change.action !== 'modify') {
        problems.push(`${change.path}: unsupported stage action "${change.action}".`);
        continue;
      }
      const source = nextContents[change.path];
      if (typeof source !== 'string') {
        problems.push(`${change.path}: source content was not supplied to validate the edit anchors.`);
        continue;
      }
      const result = applyExactEdits(source, change.edits ?? []);
      if (!result.ok) {
        problems.push(`${change.path}: ${result.error}`);
        continue;
      }
      nextContents[change.path] = result.content;
    }

    if (problems.length > 0) {
      outcomes.push({ id: stage.id, status: 'FAILED', problems });
      completed = false;
      // Mark every remaining stage SKIPPED.
      for (const remaining of stages.slice(outcomes.length)) {
        outcomes.push({ id: remaining.id, status: 'SKIPPED', problems: ['Not run: a prior stage failed.'] });
      }
      break;
    }

    Object.assign(contents, nextContents);

    if (stage.check && runCheck) {
      const checkPassed = await runCheck(stage);
      if (!checkPassed) {
        outcomes.push({ id: stage.id, status: 'FAILED', problems: [], checkPassed: false });
        completed = false;
        for (const remaining of stages.slice(outcomes.length)) {
          outcomes.push({ id: remaining.id, status: 'SKIPPED', problems: ['Not run: a prior stage failed.'] });
        }
        break;
      }
      outcomes.push({ id: stage.id, status: 'APPLIED', problems: [], checkPassed: true });
      continue;
    }

    outcomes.push({ id: stage.id, status: 'APPLIED', problems: [] });
  }

  return {
    stages: outcomes,
    finalContents: contents,
    appliedStages: outcomes.filter((outcome) => outcome.status === 'APPLIED').length,
    completed,
  };
}
