import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  withBoundedRetry,
  validateModelPlanShape,
} from '../src/agent/forge.ts';
import { loadForgeLimits } from '../src/agent/limits.ts';

// All waits here are injected, so the suite is deterministic and never depends
// on wall-clock time or public free-model availability.

test('classifyFailure: HTTP 429 and 5xx are RETRYABLE', () => {
  assert.equal(classifyFailure({ status: 429 }), 'RETRYABLE');
  assert.equal(classifyFailure({ status: 503 }), 'RETRYABLE');
  assert.equal(classifyFailure(new Error('fetch failed')), 'RETRYABLE');
  assert.equal(classifyFailure(new Error('The operation timed out')), 'RETRYABLE');
});

test('classifyFailure: permanent errors are FATAL', () => {
  assert.equal(classifyFailure(new Error('validation failed: bad path')), 'FATAL');
  assert.equal(classifyFailure({ status: 403 }), 'FATAL');
});

test('withBoundedRetry: retries a 429 then succeeds within bounds', async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withBoundedRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('rate limit'), { status: 429 });
      return 'ok';
    },
    { attempts: 5, sleep: async (ms) => { delays.push(ms); } }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('withBoundedRetry: stops immediately on a FATAL error', async () => {
  let calls = 0;
  const result = await withBoundedRetry(
    async () => {
      calls += 1;
      throw new Error('validation failed');
    },
    { attempts: 5, sleep: async () => {} }
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

test('withBoundedRetry: exhaustion stops at the configured attempt ceiling', async () => {
  let calls = 0;
  const result = await withBoundedRetry(
    async () => {
      calls += 1;
      throw Object.assign(new Error('still 503'), { status: 503 });
    },
    { attempts: 3, sleep: async () => {} }
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
});

test('validateModelPlanShape: accepts a well-formed plan and normalizes defaults', () => {
  const shape = validateModelPlanShape({
    requirements: [{ description: 'x', acceptanceCriteria: 'npm run lint' }],
    changes: [{ path: 'src/a.ts', action: 'modify', edits: [{ find: 'a', replace: 'b' }] }],
  });
  assert.equal(shape.ok, true);
  assert.equal(shape.requirements[0].id, 'REQ-1');
  assert.equal(shape.changes[0].path, 'src/a.ts');
});

test('validateModelPlanShape: rejects a non-object plan', () => {
  const shape = validateModelPlanShape('not json');
  assert.equal(shape.ok, false);
});

test('validateModelPlanShape: rejects malformed model output deterministically', () => {
  assert.equal(validateModelPlanShape({ requirements: 'nope' }).ok, false);
  assert.equal(validateModelPlanShape({ changes: [{ action: 'modify' }] }).ok, false);
  assert.equal(validateModelPlanShape({ changes: [{ path: 'a', action: 'destroy' }] }).ok, false);
  assert.equal(validateModelPlanShape({ changes: [{ path: 'a', action: 'modify', edits: 'x' }] }).ok, false);
});

test('loadForgeLimits: every ceiling is bounded and env-overridable', () => {
  const defaults = loadForgeLimits({} as NodeJS.ProcessEnv);
  assert.ok(defaults.maxModelCalls >= 1 && defaults.maxFilesPerMission >= 1 && defaults.maxRuntimeMs >= 10_000);
  const raised = loadForgeLimits({ FORGE_MAX_MODEL_CALLS: '12' } as NodeJS.ProcessEnv);
  assert.equal(raised.maxModelCalls, 12);
  const clamped = loadForgeLimits({ FORGE_MAX_MODEL_CALLS: '9999' } as NodeJS.ProcessEnv);
  assert.equal(clamped.maxModelCalls, 50);
});
