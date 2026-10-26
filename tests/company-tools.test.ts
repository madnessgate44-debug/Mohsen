import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSimpleCommand, runCommand } from '../src/company/runner.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';
import { runTeam } from '../src/company/team.ts';
import { ArtifactBus } from '../src/company/bus.ts';
import { runCompany } from '../src/company/company.ts';
import { buildRolePrompt } from '../src/company/brains.ts';
import type { Role } from '../src/company/roles.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fc-tools-'));
}

test('isSimpleCommand rejects chaining, substitution, and redirects', () => {
  for (const bad of ['a; b', 'a && b', 'a | b', 'a > f', 'a `x`', 'a $(x)', 'a \\ b']) {
    assert.equal(isSimpleCommand(bad), false, `expected ${bad} to be rejected`);
  }
  assert.equal(isSimpleCommand('node --test'), true);
  assert.equal(isSimpleCommand('npm run lint'), true);
});

test('runCommand executes a real command and reports its exit code', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ok.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(dir, 'bad.js'), 'process.exit(3);');
  const ok = await runCommand('node ok.js', dir);
  assert.equal(ok.status, 'PASSED');
  assert.equal(ok.exitCode, 0);
  const bad = await runCommand('node bad.js', dir);
  assert.equal(bad.status, 'FAILED');
  assert.equal(bad.exitCode, 3);
});

test('runCommand refuses an unsafe command without spawning it', async () => {
  const result = await runCommand('node ok.js; rm -rf /', tmp());
  assert.equal(result.status, 'FAILED');
  assert.match(result.output, /Refused unsafe command/);
  assert.equal(result.exitCode, null);
});

test('a read-only role gets no mutating tools; a branch-write role does', () => {
  const dir = tmp();
  const readOnly = buildRoleTools({ workspaceDir: dir, canMutate: false }).map((t) => t.name);
  assert.ok(!readOnly.includes('write_file'));
  assert.ok(!readOnly.includes('run_check'));
  const mutating = buildRoleTools({ workspaceDir: dir, canMutate: true }).map((t) => t.name);
  assert.ok(mutating.includes('write_file'));
  assert.ok(mutating.includes('run_check'));
});

test('write_file is confined to the allowed roots', async () => {
  const dir = tmp();
  const tools = buildRoleTools({ workspaceDir: dir, canMutate: true, allowedRoots: ['src'] });
  const write = tools.find((t) => t.name === 'write_file')!;
  const ctx = { goal: 'g', workspace: dir, step: 1 };
  const ok = await write.run({ path: 'src/a.ts', content: 'x' }, ctx);
  assert.equal(ok.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'src/a.ts')));
  const refused = await write.run({ path: 'outside.ts', content: 'x' }, ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.output, /Refusing to write outside the allowed roots/);
  assert.ok(!fs.existsSync(path.join(dir, 'outside.ts')));
});

test('run_check runs an authorized command for real and refuses an unknown one', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'lint.js'), 'process.exit(0);');
  const tools = buildRoleTools({ workspaceDir: dir, canMutate: true, authorizedCommands: { lint: 'node lint.js' } });
  const check = tools.find((t) => t.name === 'run_check')!;
  const ctx = { goal: 'g', workspace: dir, step: 1 };
  const passed = await check.run({ command: 'lint' }, ctx);
  assert.equal(passed.ok, true);
  assert.match(passed.output, /PASSED/);
  const unknown = await check.run({ command: 'rm' }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /not authorized/);
});

test('the team change map reflects files a role really wrote to disk', async () => {
  const dir = tmp();
  const bus = new ArtifactBus();
  const role: Role = {
    id: 'implementer',
    title: 'Implementer',
    mandate: 'write the change',
    authority: 'branch-write',
    produces: 'change',
    tools: buildRoleTools({ workspaceDir: dir, canMutate: true, allowedRoots: [''] }),
    brain: async (state) =>
      state.history.length === 0
        ? { tool: 'write_file', input: { path: 'feature.txt', content: 'hello world' } }
        : { tool: 'finish', input: { summary: 'wrote it', data: {} } },
  };
  const run = await runTeam({ goal: 'g', workItem: 'w', scope: 'w#1', roster: [role], bus, workspaceDir: dir });
  assert.equal(run.status, 'COMPLETED');
  assert.deepEqual(Object.keys(run.changes), ['feature.txt']);
  assert.equal(run.changes['feature.txt'], 'hello world');
});

test('the role prompt renders the required sequence', () => {
  const prompt = buildRolePrompt(
    { role: 'Implementer', mandate: 'write', artifactHint: 'Emit change.', sequence: ['read_file x', 'write_file y'] },
    { goal: 'g', history: [{ index: 1, action: { tool: 'read_file', input: { path: 'x' } }, observation: { ok: true, output: 'x' } }], tools: [] }
  );
  assert.match(prompt, /Required sequence for your role/);
  assert.match(prompt, /read_file x/);
  assert.match(prompt, /write_file y/);
});

test('a whole company run completes using real workspace tools and real checks', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'ok.js'), 'process.exit(0);');
  const commands = { test: 'node ok.js' };
  const mk = (id: Role['id'], produces: Role['produces'], brain: Role['brain'], canMutate = false): Role => ({
    id, title: id, mandate: id, authority: canMutate ? 'branch-write' : 'read-only', produces,
    tools: buildRoleTools({ workspaceDir: dir, canMutate, allowedRoots: [''], authorizedCommands: commands }),
    brain,
  });
  const finish = (data: Record<string, unknown>): Role['brain'] => async () => ({ tool: 'finish', input: { summary: 'done', data } });
  const implementer: Role['brain'] = async (state) =>
    state.history.length === 0
      ? { tool: 'write_file', input: { path: 'out.txt', content: 'done' } }
      : { tool: 'finish', input: { summary: 'wrote', data: {} } };
  const qa: Role['brain'] = async (state) =>
    state.history.some((h) => h.action.tool === 'run_check')
      ? { tool: 'finish', input: { summary: 'checked', data: {} } }
      : { tool: 'run_check', input: { command: 'test' } };

  const roster = [
    mk('pm', 'requirements', finish({ items: ['a'] })),
    mk('architect', 'design', finish({ design: 'd', files: ['out.txt'] })),
    mk('implementer', 'change', implementer, true),
    mk('reviewer', 'review', finish({ blockers: 0, notes: [] })),
    mk('qa', 'evidence', qa, true),
    mk('security', 'security', finish({ clean: true, findings: [] })),
    mk('release', 'decision', finish({ ship: true })),
  ];
  const bus = new ArtifactBus();
  const result = await runCompany({
    goal: 'g',
    bus,
    plan: () => [{ id: 'w1', title: 'work' }],
    rosterFor: () => roster,
    attemptsPerItem: 1,
    workspaceDir: dir,
    integrate: ({ changes }) => ({ ok: Object.keys(changes).length > 0, reason: 'ok' }),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(Object.keys(result.integratedChanges), ['out.txt']);
  // QA evidence came from the real check, not a claim.
  const evidence = bus.latest('w1#1', 'evidence')!;
  assert.deepEqual(evidence.data.checks, [{ name: 'test', status: 'PASSED' }]);
});
