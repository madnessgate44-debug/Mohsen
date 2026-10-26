import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMerge, loadSentinelConfig, type SentinelConfig } from '../src/agent/sentinel.ts';

// The Sentinel is the independent verifier that replaces the human merge gate.
// These tests exercise the real decision engine with no network or model call.

const BASE: SentinelConfig = {
  allowedSourcePrefix: 'forge/',
  forbiddenSourceBranches: ['main', 'master'],
  requiredChecks: ['lint', 'build', 'test'],
  modelJudgeEnabled: false,
};

const pass = (name: string) => ({ name, passed: true });

test('S1: merges only when every required check passes', () => {
  const ok = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config: BASE,
  });
  assert.equal(ok.merge, true);
  assert.equal(ok.violations.length, 0);
});

test('S1b: a failing required check blocks the merge and names it', () => {
  const decision = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), { name: 'build', passed: false }, pass('test')],
    config: BASE,
  });
  assert.equal(decision.merge, false);
  assert.match(decision.violations.join(' '), /"build" failed/);
});

test('S1c: a required check that did not run is a failure, never a silent pass', () => {
  const decision = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), pass('test')], // build missing
    config: BASE,
  });
  assert.equal(decision.merge, false);
  assert.match(decision.violations.join(' '), /"build" did not run/);
});

test('S3: the default branch can never be a merge source (no direct write)', () => {
  const decision = decideMerge({
    sourceBranch: 'main',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config: BASE,
  });
  assert.equal(decision.merge, false);
  assert.match(decision.violations.join(' '), /equals the target branch|forbidden/);
});

test('S3b: a branch outside the allowed prefix is refused even if green', () => {
  const decision = decideMerge({
    sourceBranch: 'hotfix/urgent',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config: BASE,
  });
  assert.equal(decision.merge, false);
  assert.match(decision.violations.join(' '), /outside the allowed prefix/);
});

test('S4: with the model judge on, an uncertain verdict holds instead of merging', () => {
  const config: SentinelConfig = { ...BASE, modelJudgeEnabled: true };
  const decision = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config,
    modelVerdict: 'uncertain',
  });
  assert.equal(decision.merge, false);
  assert.equal(decision.hold, true);
  assert.match(decision.reason, /inconclusive/i);
});

test('S4b: the model judge can only add caution, never override a passing gate to merge', () => {
  const config: SentinelConfig = { ...BASE, modelJudgeEnabled: true };
  const reject = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config,
    modelVerdict: 'reject',
  });
  assert.equal(reject.merge, false);
  assert.equal(reject.hold, false);
});

test('S4c: the model judge is ignored when disabled — tests remain the sole authority', () => {
  const decision = decideMerge({
    sourceBranch: 'forge/task-x',
    targetBranch: 'main',
    checks: [pass('lint'), pass('build'), pass('test')],
    config: BASE,
    modelVerdict: 'reject',
  });
  assert.equal(decision.merge, true);
});

test('S6: config is conservative by default (no auto-merge unless explicitly enabled)', () => {
  const config = loadSentinelConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.allowedSourcePrefix, 'forge/');
  assert.deepEqual(config.requiredChecks, ['lint', 'build', 'test']);
  assert.equal(config.modelJudgeEnabled, false);
});
