import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetBranch, evaluateRequirementEvidence, extractExplicitPaths, isHarnessSeparatorAnchor } from '../src/agent/forge.ts';

test('resolveTargetBranch: explicit non-default branch wins', () => {
  assert.equal(resolveTargetBranch('release/2.0', 'main'), 'release/2.0');
});

test('resolveTargetBranch: default branch falls back to itself', () => {
  assert.equal(resolveTargetBranch('main', 'main'), 'main');
});

test('resolveTargetBranch: undefined or empty falls back to default', () => {
  assert.equal(resolveTargetBranch(undefined, 'main'), 'main');
  assert.equal(resolveTargetBranch('', 'main'), 'main');
  assert.equal(resolveTargetBranch('   ', 'main'), 'main');
});

test('resolveTargetBranch: surrounding whitespace is trimmed', () => {
  assert.equal(resolveTargetBranch('  develop  ', 'main'), 'develop');
});

const passing = { command: 'npm run lint', status: 'PASSED', exitCode: 0 };
const failing = { command: 'npm run lint', status: 'FAILED', exitCode: 1 };

test('evidence: PASS only when the criterion names a passing check', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'npm run lint exits with code 0' },
    [passing]
  );
  assert.equal(result.status, 'PASS');
  assert.match(result.evidence, /npm run lint=0/);
});

test('evidence: unrelated passing checks cannot produce a false PASS', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the new endpoint returns HTTP 200 for valid input' },
    [passing]
  );
  assert.equal(result.status, 'PENDING');
  assert.match(result.evidence, /No criterion-specific passing check/);
});

test('evidence: a named but failing check yields FAIL, never PASS', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'npm run lint must pass' },
    [failing]
  );
  assert.equal(result.status, 'FAIL');
  assert.match(result.evidence, /Criterion-named check failed/);
});

test('evidence: explicit checkCommands bind evidence even when prose does not name it', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the health endpoint responds', checkCommands: ['npm run build'] },
    [{ command: 'npm run build', status: 'PASSED', exitCode: 0 }]
  );
  assert.equal(result.status, 'PASS');
});

test('evidence: a manualReviewNote is surfaced when no check applies', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the wording reads clearly', manualReviewNote: 'requires human proofreading' },
    [passing]
  );
  assert.equal(result.status, 'PENDING');
  assert.match(result.evidence, /requires human proofreading/);
});

test('evidence: criterion in description is also honored', () => {
  const result = evaluateRequirementEvidence(
    { description: 'ensure npm run build succeeds' },
    [{ command: 'npm run build', status: 'PASSED', exitCode: 0 }]
  );
  assert.equal(result.status, 'PASS');
});

test('evidence: missing acceptance criteria yields PENDING', () => {
  const result = evaluateRequirementEvidence({}, [passing]);
  assert.equal(result.status, 'PENDING');
});

test('evidence: generic words like "test" do not bind an unrelated passing command', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'the feature should be tested thoroughly' },
    [{ command: 'npm test', status: 'PASSED', exitCode: 0 }]
  );
  assert.equal(result.status, 'PENDING');
});

test('evidence: bare script names do not count as a full command reference', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'lint quality should remain high' },
    [passing]
  );
  assert.equal(result.status, 'PENDING');
});

test('evidence: full command references remain case-insensitive', () => {
  const result = evaluateRequirementEvidence(
    { acceptanceCriteria: 'Run NPM RUN LINT and require exit code 0' },
    [passing]
  );
  assert.equal(result.status, 'PASS');
});

test('extractExplicitPaths: recognizes root-level files named in the task', () => {
  const repo = ['README.md', 'package.json', 'src/agent/forge.ts', 'docs/EXHAUSTION_TESTING.md'];
  assert.deepEqual(
    extractExplicitPaths('Modify README.md by adding a section at the end.', repo),
    ['README.md']
  );
  assert.deepEqual(
    extractExplicitPaths('Update src/agent/forge.ts and docs/EXHAUSTION_TESTING.md.', repo),
    ['src/agent/forge.ts', 'docs/EXHAUSTION_TESTING.md']
  );
});

test('extractExplicitPaths: ignores non-repo names and de-duplicates', () => {
  const repo = ['README.md'];
  // A basename absent from the repo tree must not become an authoritative target.
  assert.deepEqual(extractExplicitPaths('Edit README.md and then README.md again.', repo), ['README.md']);
  assert.deepEqual(extractExplicitPaths('Edit CHANGELOG.md.', repo), []);
});

test('extractExplicitPaths: still recognizes nested paths', () => {
  const repo = ['src/exhaust-add.ts', 'tests/exhaust-add.test.ts'];
  assert.deepEqual(
    extractExplicitPaths('Create src/exhaust-add.ts and tests/exhaust-add.test.ts.', repo),
    ['src/exhaust-add.ts', 'tests/exhaust-add.test.ts']
  );
});

test('isHarnessSeparatorAnchor: flags harness separators but not real content', () => {
  // Exhaustion run: models anchored on the harness context separator.
  assert.equal(isHarnessSeparatorAnchor('--- END FILE ---'), true);
  assert.equal(isHarnessSeparatorAnchor('text\n--- END FILE ---'), true);
  assert.equal(isHarnessSeparatorAnchor('<<<FORGE_CONTEXT_FILE path="README.md">>>'), true);
  assert.equal(isHarnessSeparatorAnchor('<<<FORGE_END_CONTEXT_FILE>>>'), true);
  // Real file content is never flagged.
  assert.equal(isHarnessSeparatorAnchor('# Firstborn / Forge'), false);
  assert.equal(isHarnessSeparatorAnchor(''), false);
});
