import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseMission, shouldAutoRetry } from '../src/agent/diagnosis.ts';

test('diagnosis: model route failure is classified and retryable', () => {
  const d = diagnoseMission({
    status: 'FAILED',
    errorMessage: 'Model Generation Failed: keyless route returned no content',
    keylessRouteErrors: ['kilo: empty response'],
  });
  assert.equal(d.category, 'MODEL_ROUTE');
  assert.equal(d.retryable, true);
  assert.ok(d.recovery.includes('VERIFY_KEYLESS_ROUTE'));
});

test('diagnosis: no substantive checks is not retryable and asks for a check script', () => {
  const d = diagnoseMission({
    status: 'BLOCKED',
    blockerReason: 'No recognized target-project test, lint, build, or model-smoke script exists; whitespace validation alone is not sufficient to authorize a coding PR.',
  });
  assert.equal(d.category, 'NO_SUBSTANTIVE_CHECKS');
  assert.equal(d.retryable, false);
  assert.deepEqual(d.recovery, ['DEFINE_PROJECT_CHECK_SCRIPT']);
});

test('diagnosis: dependency installation failure is an environment issue', () => {
  const d = diagnoseMission({
    status: 'FAILED',
    errorMessage: 'Target dependency installation failed twice (last exit 1).',
  });
  assert.equal(d.category, 'ENVIRONMENT');
  assert.equal(d.retryable, true);
});

test('diagnosis: a moved base refreshes and retries', () => {
  const d = diagnoseMission({
    status: 'BLOCKED',
    blockerReason: 'Target branch moved during inspection (expected abc, cloned def). Retry against the new base.',
  });
  assert.equal(d.category, 'BASE_MOVED');
  assert.deepEqual(d.recovery, ['REFRESH_BASE_AND_RETRY']);
});

test('diagnosis: input validation failure is not retryable', () => {
  const d = diagnoseMission({ status: 'FAILED', errorMessage: 'Validation Failed: Invalid target repository format "x". Expected "owner/repo".' });
  assert.equal(d.category, 'VALIDATION');
  assert.equal(d.retryable, false);
});

test('diagnosis: policy withholding is high severity and manual', () => {
  const d = diagnoseMission({ status: 'BLOCKED', blockerReason: 'Permission policy withheld Pull Request: profile does not allow PR.' });
  assert.equal(d.category, 'POLICY');
  assert.equal(d.severity, 'HIGH');
  assert.deepEqual(d.recovery, ['MANUAL_REVIEW']);
});

test('diagnosis: failed target checks surface their commands', () => {
  const d = diagnoseMission({
    status: 'FAILED',
    testResults: [
      { command: 'npm run lint', status: 'PASSED' },
      { command: 'npm run build', status: 'FAILED' },
    ],
  });
  assert.equal(d.category, 'CHECK_FAILURE');
  assert.deepEqual(d.failedChecks, ['npm run build']);
  assert.ok(d.recovery.includes('INSPECT_CHECK_OUTPUT'));
});

test('diagnosis: a missing target repository is a repo-inspection issue', () => {
  const d = diagnoseMission({
    status: 'BLOCKED',
    blockerReason: 'Repository inspection failed: Repository not found (HTTP 404). It has not been created yet or the token lacks read access.',
  });
  assert.equal(d.category, 'REPO_INSPECTION');
  assert.equal(d.retryable, false);
  assert.ok(d.recovery.includes('FIX_INPUTS'));
});

test('diagnosis: unclassified stop is manual review, never a false retry', () => {
  const d = diagnoseMission({ status: 'FAILED', errorMessage: 'something entirely unexpected happened' });
  assert.equal(d.category, 'UNKNOWN');
  assert.equal(d.retryable, false);
  assert.deepEqual(d.recovery, ['MANUAL_REVIEW']);
});

test('autoRetry: no diagnosis is never retried', () => {
  assert.equal(shouldAutoRetry(undefined, 1, 2), false);
});

test('autoRetry: a retryable diagnosis earns one bounded retry', () => {
  const d = diagnoseMission({ status: 'FAILED', errorMessage: 'Model Generation Failed: keyless route returned no content' });
  assert.equal(shouldAutoRetry(d, 1, 2), true);
  assert.equal(shouldAutoRetry(d, 2, 2), false);
});

test('autoRetry: a non-retryable diagnosis is never retried', () => {
  const d = diagnoseMission({ status: 'FAILED', errorMessage: 'Validation Failed: Invalid target repository format "x". Expected "owner/repo".' });
  assert.equal(d.retryable, false);
  assert.equal(shouldAutoRetry(d, 1, 2), false);
});

test('autoRetry: zero retries configured disables the loop', () => {
  const d = diagnoseMission({ status: 'FAILED', errorMessage: 'Target dependency installation failed twice (last exit 1).' });
  assert.equal(shouldAutoRetry(d, 1, 0), false);
});

test('diagnosis: failed stages are derived from the trace', () => {
  const d = diagnoseMission({
    status: 'BLOCKED',
    trace: [
      { stage: 'INSPECT', status: 'PASSED' },
      { stage: 'TEST', status: 'FAILED' },
      { stage: 'TEST', status: 'FAILED' },
    ],
    testResults: [{ command: 'npm test', status: 'FAILED' }],
  });
  assert.deepEqual(d.failedStages, ['TEST']);
});
