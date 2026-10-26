import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceEntry, summarizeTrace } from '../src/agent/mission-trace.ts';
import { loadForgeLimits } from '../src/agent/limits.ts';
import { isKeylessOnly } from '../src/services/model.ts';

const fixed = () => '2026-10-12T00:00:00.000Z';

test('traceEntry: records stage, status and attempt deterministically', () => {
  const e = traceEntry('INSPECT', 'PASSED', 1, 'base abc', fixed);
  assert.deepEqual(e, { stage: 'INSPECT', status: 'PASSED', attempt: 1, at: fixed(), detail: 'base abc' });
  assert.equal('detail' in traceEntry('PLAN', 'STARTED', 1, undefined, fixed), false);
});

test('summarizeTrace: a full success trace is completed', () => {
  const entries = [
    traceEntry('INSPECT', 'PASSED', 1, undefined, fixed),
    traceEntry('PLAN', 'PASSED', 1, undefined, fixed),
    traceEntry('VALIDATE', 'PASSED', 1, undefined, fixed),
    traceEntry('APPLY', 'PASSED', 1, undefined, fixed),
    traceEntry('TEST', 'PASSED', 1, undefined, fixed),
    traceEntry('COMMIT', 'PASSED', 1, undefined, fixed),
    traceEntry('PR', 'PASSED', 1, undefined, fixed),
  ];
  const s = summarizeTrace(entries);
  assert.equal(s.completed, true);
  assert.equal(s.totalEntries, 7);
  assert.equal(s.attempts, 1);
  assert.deepEqual(s.failedStages, []);
  assert.deepEqual(s.blockedStages, []);
});

test('summarizeTrace: a failure is never reported as completed', () => {
  const entries = [
    traceEntry('TEST', 'PASSED', 1, undefined, fixed),
    traceEntry('TEST', 'FAILED', 1, undefined, fixed),
    traceEntry('COMMIT', 'PASSED', 1, undefined, fixed),
  ];
  const s = summarizeTrace(entries);
  assert.equal(s.completed, false);
  assert.deepEqual(s.failedStages, ['TEST']);
});

test('summarizeTrace: a blocked stage prevents completion', () => {
  const entries = [traceEntry('POLICY', 'BLOCKED', 1, undefined, fixed)];
  const s = summarizeTrace(entries);
  assert.equal(s.completed, false);
  assert.deepEqual(s.blockedStages, ['POLICY']);
});

test('summarizeTrace: attempts reflects the highest attempt index', () => {
  const entries = [traceEntry('PLAN', 'PASSED', 1, undefined, fixed), traceEntry('TEST', 'PASSED', 3, undefined, fixed)];
  assert.equal(summarizeTrace(entries).attempts, 3);
});

test('loadForgeLimits: maxMissionAttempts is bounded and defaults to 1', () => {
  assert.equal(loadForgeLimits({} as NodeJS.ProcessEnv).maxMissionAttempts, 1);
  assert.equal(loadForgeLimits({ FORGE_MAX_MISSION_ATTEMPTS: '3' } as NodeJS.ProcessEnv).maxMissionAttempts, 3);
  assert.equal(loadForgeLimits({ FORGE_MAX_MISSION_ATTEMPTS: '99' } as NodeJS.ProcessEnv).maxMissionAttempts, 5);
  assert.equal(loadForgeLimits({ FORGE_MAX_MISSION_ATTEMPTS: '0' } as NodeJS.ProcessEnv).maxMissionAttempts, 1);
});

test('isKeylessOnly: engages regardless of GitHub capitalization', () => {
  // GitHub capitalizes repository-variable names, so the value arrives as "True".
  for (const v of ['true', 'True', 'TRUE', ' true ']) {
    assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: v } as NodeJS.ProcessEnv), true, v);
  }
  for (const v of ['', 'false', 'False', 'no', '0', undefined]) {
    assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: v } as NodeJS.ProcessEnv), false, String(v));
  }
});

