import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyExactEdits, runStagedMission } from '../src/agent/stages.ts';

test('applyExactEdits: applies a unique anchor', () => {
  const result = applyExactEdits('const a = 1;\n', [{ find: 'const a = 1;', replace: 'const a = 2;' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'const a = 2;\n');
});

test('applyExactEdits: rejects a missing anchor', () => {
  const result = applyExactEdits('const a = 1;\n', [{ find: 'const b = 1;', replace: 'x' }]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not found/);
});

test('applyExactEdits: rejects an ambiguous anchor', () => {
  const result = applyExactEdits('x\nx\n', [{ find: 'x', replace: 'y' }]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /ambiguous/);
});

// Synthetic mission touching three related files across three stages. Stage 2
// fails, so stage 3 must be SKIPPED and the failing stage must never be
// reported as applied.
test('runStagedMission: applies staged multi-file edits and halts on a failed stage', async () => {
  const initial = {
    'src/a.ts': 'export const A = 1;\n',
    'src/b.ts': 'import { A } from "./a";\nexport const B = A;\n',
    'src/c.ts': 'export const C = 0;\n',
  };

  const stages = [
    { id: 'S1', changes: [{ path: 'src/a.ts', action: 'modify' as const, rationale: '', edits: [{ find: 'A = 1', replace: 'A = 2' }] }], check: 'npm run lint' },
    { id: 'S2', changes: [{ path: 'src/b.ts', action: 'modify' as const, rationale: '', edits: [{ find: 'MISSING_ANCHOR', replace: 'x' }] }] },
    { id: 'S3', changes: [{ path: 'src/c.ts', action: 'modify' as const, rationale: '', edits: [{ find: 'C = 0', replace: 'C = 3' }] }] },
  ];

  const checks: string[] = [];
  const result = await runStagedMission(stages, initial, async (stage) => {
    checks.push(stage.id);
    return true;
  });

  assert.equal(result.completed, false);
  assert.equal(result.appliedStages, 1);
  assert.deepEqual(checks, ['S1']);
  assert.equal(result.stages[0].status, 'APPLIED');
  assert.equal(result.stages[1].status, 'FAILED');
  assert.equal(result.stages[2].status, 'SKIPPED');
  // Final contents reflect only the validated first stage; the failed stage left
  // no partial edit behind.
  assert.equal(result.finalContents['src/a.ts'], 'export const A = 2;\n');
  assert.equal(result.finalContents['src/b.ts'], initial['src/b.ts']);
  assert.equal(result.finalContents['src/c.ts'], initial['src/c.ts']);
});

test('runStagedMission: a stage whose check fails halts later stages', async () => {
  const initial = { 'src/a.ts': 'A = 1;\n', 'src/b.ts': 'B = 1;\n' };
  const stages = [
    { id: 'S1', changes: [{ path: 'src/a.ts', action: 'modify' as const, rationale: '', edits: [{ find: 'A = 1', replace: 'A = 2' }] }], check: 'npm run lint' },
    { id: 'S2', changes: [{ path: 'src/b.ts', action: 'modify' as const, rationale: '', edits: [{ find: 'B = 1', replace: 'B = 2' }] }] },
  ];
  const result = await runStagedMission(stages, initial, async () => false);
  assert.equal(result.completed, false);
  assert.equal(result.stages[0].status, 'FAILED');
  assert.equal(result.stages[0].checkPassed, false);
  assert.equal(result.stages[1].status, 'SKIPPED');
  assert.equal(result.finalContents['src/b.ts'], 'B = 1;\n');
});

test('runStagedMission: all stages applied when every stage validates', async () => {
  const initial = { 'src/a.ts': 'A = 1;\n', 'src/b.ts': 'B = 1;\n', 'src/c.ts': 'C = 1;\n' };
  const mk = (path: string, from: string, to: string, id: string) => ({
    id,
    changes: [{ path, action: 'modify' as const, rationale: '', edits: [{ find: from, replace: to }] }],
  });
  const result = await runStagedMission(
    [mk('src/a.ts', 'A = 1', 'A = 2', 'S1'), mk('src/b.ts', 'B = 1', 'B = 2', 'S2'), mk('src/c.ts', 'C = 1', 'C = 2', 'S3')],
    initial
  );
  assert.equal(result.completed, true);
  assert.equal(result.appliedStages, 3);
  assert.deepEqual(result.stages.map((s) => s.status), ['APPLIED', 'APPLIED', 'APPLIED']);
});
