import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ArtifactBus } from '../src/company/bus.ts';
import { runTeam } from '../src/company/team.ts';
import { scoreAttempt, judgeCompetition, DEFAULT_RUBRIC } from '../src/company/judge.ts';
import { runCompany } from '../src/company/company.ts';
import type { Role } from '../src/company/roles.ts';
import type { AgentAction, AgentBrain, AgentTool } from '../src/kernel/loop.ts';
import { runAgentLoop, buildWorkspaceTools, resolveInWorkspace } from '../src/kernel/loop.ts';

// The company kernel is proven with scripted employees: deterministic brains that
// emit real actions. No model, no network. The judging and competition logic is
// the part most likely to be wrong, so it is tested hardest.

const noTools: AgentTool[] = [{ name: 'think', description: 'noop', run: async () => ({ ok: true, output: 'ok' }) }];

function brainThat(...actions: AgentAction[]): AgentBrain {
  let i = 0;
  return async () => actions[Math.min(i++, actions.length - 1)];
}

function finish(data: Record<string, unknown>, summary: string): AgentAction {
  return { tool: 'finish', input: { summary, data } };
}

/** A role that just emits its artifact via finish. */
function role(id: string, produces: Role['produces'], data: Record<string, unknown>, opts: { summary?: string; ok?: boolean } = {}): Role {
  return {
    id,
    title: id,
    mandate: `${id} mandate`,
    authority: 'read-only',
    produces,
    tools: noTools,
    brain: brainThat(finish(data, opts.summary ?? `${id} done`)),
  };
}

// --- Team: roles hand artifacts forward --------------------------------------

test('a team runs its roster and every role posts an artifact', async () => {
  const bus = new ArtifactBus();
  const roster: Role[] = [
    role('pm', 'requirements', { items: ['r1'] }),
    role('implementer', 'change', { files: { 'src/a.ts': 'export const a = 1;\n' } }),
  ];
  const run = await runTeam({ goal: 'g', workItem: 'w', scope: 'w#1', roster, bus });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.results.length, 2);
  assert.equal(bus.forScope('w#1').length, 2);
  // The mutating role's file change is carried on the run.
  assert.equal(run.changes['src/a.ts'], 'export const a = 1;\n');
});

test('a role that edits an existing file (write_file is refused) still counts as a change', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-team-edit-'));
  writeFileSync(path.join(dir, 'index.js'), "module.exports = { version: '0.0.0' };\n");

  const bus = new ArtifactBus();
  const editRole: Role = {
    id: 'implementer',
    title: 'Implementer',
    mandate: 'change the file',
    authority: 'branch-write',
    produces: 'change',
    tools: buildWorkspaceTools({ workspace: dir, allowMutation: true }),
    // The prompt requires edit_file for existing files; write_file is refused.
    brain: brainThat(
      { tool: 'read_file', input: { path: 'index.js' } },
      { tool: 'write_file', input: { path: 'index.js', content: "module.exports = { version: '1.0.0' };\n" } },
      { tool: 'edit_file', input: { path: 'index.js', old_str: "version: '0.0.0'", new_str: "version: '1.0.0'" } },
      finish({ summary: 'bumped the version' }, 'done'),
    ),
  };

  const run = await runTeam({ goal: 'g', workItem: 'w', scope: 'w#1', roster: [editRole], bus, workspaceDir: dir });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.changes['index.js'], "module.exports = { version: '1.0.0' };\n");
});

test('a team stops early when a role fails', async () => {
  const bus = new ArtifactBus();
  let secondRan = false;
  const first: Role = {
    ...role('pm', 'requirements', {}),
    brain: async () => ({ tool: 'think' }), // never finishes -> step ceiling
    limits: { maxSteps: 1, maxRuntimeMs: 1000 },
  };
  const second: Role = { ...role('implementer', 'change', {}), brain: async () => { secondRan = true; return finish({}, 'x'); } };
  const run = await runTeam({ goal: 'g', workItem: 'w', scope: 'w#1', roster: [first, second], bus });
  assert.equal(run.status, 'BLOCKED');
  assert.equal(secondRan, false);
});

// --- Judges: evidence only ---------------------------------------------------

function runWith(overrides: Partial<Parameters<typeof scoreAttempt>[1]> = {}) {
  return { workItem: 'w', status: 'COMPLETED' as const, reason: '', results: [], changes: {}, ...overrides };
}

function busWithEvidence(scope: string, checks: { name: string; status: string }[], securityClean = true, blockers = 0) {
  const bus = new ArtifactBus();
  bus.post({ kind: 'evidence', author: 'qa', scope, summary: 'evidence', data: { checks } });
  bus.post({ kind: 'security', author: 'security', scope, summary: 'sec', data: { clean: securityClean } });
  bus.post({ kind: 'review', author: 'reviewer', scope, summary: 'rev', data: { blockers } });
  return bus;
}

test('a confident claim with no passing test is ineligible', async () => {
  const bus = new ArtifactBus();
  const card = scoreAttempt('a#1', runWith(), bus);
  assert.equal(card.eligible, false);
  assert.match(card.notes.join(' '), /tests-pass/);
});

test('evidence earns points; a clean, tested attempt is eligible', async () => {
  const bus = busWithEvidence('a#1', [{ name: 'test', status: 'PASSED' }, { name: 'lint', status: 'PASSED' }]);
  const card = scoreAttempt('a#1', runWith({ changes: { 'x.ts': 'y' } }), bus);
  assert.equal(card.eligible, true);
  assert.equal(card.total, 3 + 5 + 2 + 2 + 3 + 1); // completed, tests, lint, review, security, change
});

test('a failing security check makes an attempt ineligible even if tests pass', async () => {
  const bus = busWithEvidence('a#1', [{ name: 'test', status: 'PASSED' }], false);
  const card = scoreAttempt('a#1', runWith(), bus);
  assert.equal(card.eligible, false);
  assert.match(card.notes.join(' '), /security-clean/);
});

// --- Competition: deterministic ranking --------------------------------------

test('the competition picks the eligible attempt with the most evidence', async () => {
  const bus = new ArtifactBus();
  bus.post({ kind: 'evidence', author: 'qa', scope: 'a#1', summary: 'e', data: { checks: [{ name: 'test', status: 'PASSED' }] } });
  bus.post({ kind: 'security', author: 'security', scope: 'a#1', summary: 's', data: { clean: true } });
  bus.post({ kind: 'review', author: 'reviewer', scope: 'a#1', summary: 'r', data: { blockers: 0 } });
  bus.post({ kind: 'evidence', author: 'qa', scope: 'a#2', summary: 'e', data: { checks: [{ name: 'test', status: 'PASSED' }, { name: 'lint', status: 'PASSED' }] } });
  bus.post({ kind: 'security', author: 'security', scope: 'a#2', summary: 's', data: { clean: true } });
  bus.post({ kind: 'review', author: 'reviewer', scope: 'a#2', summary: 'r', data: { blockers: 0 } });

  const competition = judgeCompetition(
    'w',
    [
      { attempt: 'a#1', run: runWith() },
      { attempt: 'a#2', run: runWith() },
    ],
    bus
  );
  assert.equal(competition.winner, 'a#2'); // lint adds 2 points
});

test('an ineligible attempt never wins, even with a higher raw score', async () => {
  const bus = new ArtifactBus();
  bus.post({ kind: 'evidence', author: 'qa', scope: 'a#1', summary: 'e', data: { checks: [{ name: 'test', status: 'FAILED' }, { name: 'lint', status: 'PASSED' }] } });
  bus.post({ kind: 'security', author: 'security', scope: 'a#1', summary: 's', data: { clean: true } });
  bus.post({ kind: 'evidence', author: 'qa', scope: 'a#2', summary: 'e', data: { checks: [{ name: 'test', status: 'PASSED' }] } });
  bus.post({ kind: 'security', author: 'security', scope: 'a#2', summary: 's', data: { clean: true } });
  bus.post({ kind: 'review', author: 'reviewer', scope: 'a#2', summary: 'r', data: { blockers: 0 } });
  const competition = judgeCompetition('w', [{ attempt: 'a#1', run: runWith() }, { attempt: 'a#2', run: runWith() }], bus);
  assert.equal(competition.winner, 'a#2');
});

test('a tie is broken deterministically by attempt id', async () => {
  const bus = new ArtifactBus();
  for (const s of ['a#1', 'a#2']) {
    bus.post({ kind: 'evidence', author: 'qa', scope: s, summary: 'e', data: { checks: [{ name: 'test', status: 'PASSED' }] } });
    bus.post({ kind: 'security', author: 'security', scope: s, summary: 's', data: { clean: true } });
    bus.post({ kind: 'review', author: 'reviewer', scope: s, summary: 'r', data: { blockers: 0 } });
  }
  const competition = judgeCompetition('w', [{ attempt: 'a#2', run: runWith() }, { attempt: 'a#1', run: runWith() }], bus);
  assert.equal(competition.winner, 'a#1');
  assert.equal(competition.scorecards.length, 2);
});

test('an attempt cannot score on another attempt\'s evidence', async () => {
  const bus = new ArtifactBus();
  // Only a#1 has evidence. a#2 must not borrow it.
  bus.post({ kind: 'evidence', author: 'qa', scope: 'a#1', summary: 'e', data: { checks: [{ name: 'test', status: 'PASSED' }, { name: 'lint', status: 'PASSED' }] } });
  bus.post({ kind: 'security', author: 'security', scope: 'a#1', summary: 's', data: { clean: true } });
  bus.post({ kind: 'review', author: 'reviewer', scope: 'a#1', summary: 'r', data: { blockers: 0 } });

  const card1 = scoreAttempt('a#1', runWith(), bus);
  const card2 = scoreAttempt('a#2', runWith(), bus);
  assert.equal(card1.eligible, true);
  assert.equal(card2.eligible, false);
  assert.equal(card2.total, 3); // only "completed"; no tests/lint/security borrowed
});

function fullTeam(attempt: number, passTest: boolean): Role[] {
  const tag = passTest ? 'PASSED' : 'FAILED';
  return [
    role('pm', 'requirements', { items: ['r'] }),
    role('architect', 'design', { files: ['src/a.ts'] }),
    role('implementer', 'change', { files: { [`src/a${attempt}.ts`]: `export const v = ${attempt};\n` } }),
    role('reviewer', 'review', { blockers: 0 }),
    role('qa', 'evidence', { checks: [{ name: 'test', status: tag }, { name: 'lint', status: 'PASSED' }] }),
    role('security', 'security', { clean: true }),
  ];
}

test('the supervisor runs a competition per work item and integrates the winner', async () => {
  const result = await runCompany({
    goal: 'ship two things',
    plan: () => [{ id: 'w1', title: 'first' }],
    // attempt 1 fails its test; attempt 2 passes.
    rosterFor: (_item, attempt) => fullTeam(attempt, attempt === 2),
    attemptsPerItem: 2,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.winners, ['w1#2']);
  // Only the winner's change is integrated.
  assert.deepEqual(Object.keys(result.integratedChanges), ['src/a2.ts']);
  const decision = result.bus.all().find((a) => a.kind === 'decision');
  assert.ok(decision, 'a decision artifact records the choice');
});

test('the supervisor decomposes a goal into multiple work items', async () => {
  const result = await runCompany({
    goal: 'g',
    plan: () => [{ id: 'w1', title: 'first' }, { id: 'w2', title: 'second' }],
    rosterFor: () => fullTeam(1, true),
    attemptsPerItem: 1,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.winners, ['w1#1', 'w2#1']);
});

test('the company stops when nobody is eligible', async () => {
  const result = await runCompany({
    goal: 'g',
    plan: () => [{ id: 'w1', title: 'first' }],
    rosterFor: () => fullTeam(1, false), // every attempt fails its test
    attemptsPerItem: 2,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.winners.length, 0);
  assert.match(result.reason, /no eligible attempt/);
});

test('the company budget bounds total role-runs', async () => {
  const result = await runCompany({
    goal: 'g',
    plan: () => [{ id: 'w1', title: 'first' }, { id: 'w2', title: 'second' }],
    rosterFor: () => fullTeam(1, true),
    attemptsPerItem: 2,
    maxRoleRuns: 6, // one team is 6 roles, so the second item cannot start
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /budget exhausted/);
});

test('the integration gate can refuse the final result', async () => {
  const result = await runCompany({
    goal: 'g',
    plan: () => [{ id: 'w1', title: 'first' }],
    rosterFor: () => fullTeam(1, true),
    attemptsPerItem: 1,
    integrate: () => ({ ok: false, reason: 'whole-repo regression check failed' }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /regression/);
});

// --- Vendored kernel hardening (carried from the Firstborn review) -----------

test('a hanging tool cannot defeat the runtime ceiling', async () => {
  const hang: AgentTool = { name: 'hang', description: 'never resolves', run: () => new Promise(() => {}) };
  const started = Date.now();
  const result = await runAgentLoop({
    goal: 'hang',
    tools: [hang],
    brain: async () => ({ tool: 'hang' }),
    limits: { maxSteps: 3, maxRuntimeMs: 100, maxCallMs: 100 },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /Runtime ceiling/);
  assert.ok(Date.now() - started < 3000);
});

test('write through a symlink that leaves the workspace is refused', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'company-ws-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'company-out-'));
  symlinkSync(outside, path.join(ws, 'escape'), 'dir');
  const tools = new Map(buildWorkspaceTools({ workspace: ws, allowMutation: true }).map((t) => [t.name, t]));
  const obs = await tools.get('write_file')!.run({ path: 'escape/pwned.txt', content: 'x' }, { goal: 'g', workspace: ws, step: 1 });
  assert.equal(obs.ok, false);
  assert.equal(existsSync(path.join(outside, 'pwned.txt')), false);
});

test('resolveInWorkspace allows an inside symlink and blocks an outside one', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'company-ws2-'));
  mkdirSync(path.join(ws, 'src'));
  writeFileSync(path.join(ws, 'src', 'a.ts'), 'x');
  symlinkSync(path.join(ws, 'src'), path.join(ws, 'alias'), 'dir');
  assert.ok(resolveInWorkspace(ws, 'alias/a.ts'));
  const outside = mkdtempSync(path.join(tmpdir(), 'company-out2-'));
  symlinkSync(outside, path.join(ws, 'bad'), 'dir');
  assert.equal(resolveInWorkspace(ws, 'bad/x.ts'), null);
});

test('the default rubric is non-empty and mandatory criteria are marked', () => {
  assert.ok(DEFAULT_RUBRIC.length > 0);
  assert.ok(DEFAULT_RUBRIC.some((r) => r.mandatory));
});
