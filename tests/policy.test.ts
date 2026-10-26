import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePermissionPolicy, loadPermissionConfig, type PermissionConfig } from '../src/agent/policy.ts';

type PermissionRequestLike = Parameters<typeof evaluatePermissionPolicy>[0];

const base: PermissionRequestLike = {
  requestedPrCreation: true,
  branchName: 'forge/task-demo-123',
  targetBranch: 'main',
  repo: 'madnessgate44-debug/Firstborn',
};

function cfg(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return {
    profile: 'review',
    requireHumanApproval: false,
    allowedBranchPrefix: 'forge/task-',
    forbiddenBranches: ['main', 'master'],
    allowedRepos: [],
    ...overrides,
  };
}

test('policy: default review profile allows branch, commit and PR', () => {
  const d = evaluatePermissionPolicy(base, cfg());
  assert.equal(d.effectiveProfile, 'review');
  assert.equal(d.allowBranchWrite, true);
  assert.equal(d.allowCommit, true);
  assert.equal(d.allowOpenPr, true);
  assert.equal(d.allowMerge, false);
});

test('policy: readonly profile denies every GitHub write', () => {
  const d = evaluatePermissionPolicy(base, cfg({ profile: 'readonly' }));
  assert.equal(d.allowBranchWrite, false);
  assert.equal(d.allowCommit, false);
  assert.equal(d.allowOpenPr, false);
  assert.match(d.reason, /read-only|denied/i);
});

test('policy: sandbox allows a branch but withholds the PR', () => {
  const d = evaluatePermissionPolicy(base, cfg({ profile: 'sandbox' }));
  assert.equal(d.allowBranchWrite, true);
  assert.equal(d.allowCommit, true);
  assert.equal(d.allowOpenPr, false);
});

test('policy: human approval caps publish down to sandbox', () => {
  const d = evaluatePermissionPolicy(base, cfg({ profile: 'publish', requireHumanApproval: true }));
  assert.equal(d.profile, 'publish');
  assert.equal(d.effectiveProfile, 'sandbox');
  assert.equal(d.allowOpenPr, false);
  assert.match(d.reason, /FORGE_REQUIRE_HUMAN_APPROVAL/);
});

test('policy: nobody may write to a protected branch', () => {
  const d = evaluatePermissionPolicy({ ...base, branchName: 'main' }, cfg({ profile: 'publish' }));
  assert.equal(d.allowBranchWrite, false);
  assert.equal(d.allowOpenPr, false);
  assert.ok(d.violations.some((v) => /protected/.test(v)));
});

test('policy: a branch outside the allowed prefix is denied', () => {
  const d = evaluatePermissionPolicy({ ...base, branchName: 'feature/x' }, cfg());
  assert.equal(d.allowBranchWrite, false);
  assert.ok(d.violations.some((v) => /prefix/.test(v)));
});

test('policy: an unlisted repository is denied', () => {
  const d = evaluatePermissionPolicy(base, cfg({ allowedRepos: ['someone/else'] }));
  assert.equal(d.allowBranchWrite, false);
  assert.ok(d.violations.some((v) => /allowlist/.test(v)));
});

test('policy: absent caller consent denies writes regardless of profile', () => {
  const d = evaluatePermissionPolicy({ ...base, requestedPrCreation: false }, cfg({ profile: 'publish' }));
  assert.equal(d.allowBranchWrite, false);
  assert.equal(d.allowOpenPr, false);
  assert.match(d.reason, /did not authorize/);
});

test('loadPermissionConfig: defaults are conservative and env-overridable', () => {
  const d = loadPermissionConfig({} as NodeJS.ProcessEnv);
  assert.equal(d.profile, 'review');
  assert.equal(d.requireHumanApproval, false);
  assert.deepEqual(d.forbiddenBranches, ['main', 'master']);

  const over = loadPermissionConfig({
    FORGE_PERMISSION_PROFILE: 'readonly',
    FORGE_REQUIRE_HUMAN_APPROVAL: 'true',
    FORGE_ALLOWED_REPOS: 'a/b, c/d',
  } as NodeJS.ProcessEnv);
  assert.equal(over.profile, 'readonly');
  assert.equal(over.requireHumanApproval, true);
  assert.deepEqual(over.allowedRepos, ['a/b', 'c/d']);
});
