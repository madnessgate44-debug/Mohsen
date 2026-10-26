import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deliverChange, resolveAuthorizedCommands } from '../src/company/deliver.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import type { AgentAction, AgentBrain } from '../src/kernel/loop.ts';
import { buildWorkspaceTools } from '../src/kernel/loop.ts';
import type { WorkItem } from '../src/company/company.ts';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run real git and fail the test loudly if it does not succeed. */
function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * A real bare repository to push to, seeded with a real commit on `main`.
 * This is the target the company will change — no mocking of git or the FS.
 */
function seedRemote(opts: { testScript?: string } = {}): { remoteDir: string; commit: string } {
  const remoteDir = tmp('deliver-remote-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-');
  git(['init', '-q', '-b', 'main', seedDir]);
  const testScript = opts.testScript ?? 'node check.js';
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'sample-target', scripts: { test: testScript } }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'index.js'), "module.exports = { version: '1.0.0' };\n");
  // The check passes on the base commit and fails only if the version stops
  // being a string, so a bad change (a number) is unambiguously the cause.
  fs.writeFileSync(path.join(seedDir, 'check.js'), "const v = require('./index.js').version;\nif (typeof v !== 'string') { console.error('expected a string version, got ' + typeof v); process.exit(1); }\n");
  fs.writeFileSync(path.join(seedDir, 'pass.js'), 'process.exit(0);\n');
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);
  return { remoteDir, commit };
}

/**
 * A deterministic roster that behaves like the real one: it writes a file, then
 * QA records evidence from the checks it actually ran. `edits` maps a role to the
 * file it writes, so a test can make the change break or keep the target's tests.
 */
function rosterFor(attempt: number, opts: { bad?: boolean } = {}): Role[] {
  const goodContent = "module.exports = { version: '1.1.0' };\n";
  const badContent = 'module.exports = { version: 123 };\n';
  const runs: Record<string, AgentAction[]> = {
    implementer: [
      { tool: 'read_file', input: { path: 'index.js' } },
      // edit_file, not write_file: overwriting an existing file is refused now.
      { tool: 'edit_file', input: { path: 'index.js', old_str: "version: '1.0.0'", new_str: opts.bad ? 'version: 123' : "version: '1.1.0'" } },
      { tool: 'run_check', input: { command: 'test' } },
      { tool: 'finish', input: { summary: 'implemented the change', data: { files: { 'index.js': opts.bad ? badContent : goodContent } } } },
    ],
    qa: [
      { tool: 'run_check', input: { command: 'test' } },
      { tool: 'finish', input: { summary: 'ran the target tests', data: {} } },
    ],
    security: [{ tool: 'finish', input: { summary: 'no escapes found', data: { clean: true } } }],
    reviewer: [{ tool: 'finish', input: { summary: 'change is correct', data: { blockers: 0 } } }],
    pm: [{ tool: 'finish', input: { summary: 'requirement: bump the version', data: { items: ['version is bumped'] } } }],
    architect: [{ tool: 'finish', input: { summary: 'touch index.js', data: { files: ['index.js'] } } }],
    release: [{ tool: 'finish', input: { summary: 'may ship', data: { ship: true } } }],
  };
  const brain = (id: string): AgentBrain => {
    const script = runs[id] ?? [{ tool: 'finish', input: { summary: id, data: {} } }];
    let i = 0;
    return async () => script[Math.min(i++, script.length - 1)];
  };
  return DEFAULT_ROSTER.map((r) => ({
    id: r.id,
    title: r.title,
    mandate: r.mandate,
    authority: r.authority,
    consumes: r.consumes,
    produces: r.produces,
    tools: buildRoleTools({ workspaceDir: '', canMutate: r.authority === 'branch-write' }).map((t) => t),
    brain: brain(r.id),
  }));
}

/** buildRoleTools needs the real workspace; rebuild per run inside deliver via closure. */
function rosterForWorkspace(dir: string, opts: { bad?: boolean } = {}) {
  return (_item: WorkItem, attempt: number): Role[] => {
    const base = rosterFor(attempt, opts);
    return base.map((r) => ({ ...r, tools: buildRoleTools({ workspaceDir: dir, canMutate: r.authority === 'branch-write' }) }));
  };
}

test('resolveAuthorizedCommands reads only the target\'s declared scripts', () => {
  const dir = tmp('pkg-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'vite build' } }));
  assert.deepEqual(resolveAuthorizedCommands(dir), { test: 'npm test' });
  const empty = tmp('pkg-');
  assert.deepEqual(resolveAuthorizedCommands(empty), {});
});

test('delivery pushes a real, verified change to a real remote branch', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed',
    goal: 'bump the version',
    commit,
    branch: 'forge/deliver-test',
    workspaceDir: work,
    token: 'unused-in-local-test',
    remoteUrl: remoteDir,
    rosterFor: rosterForWorkspace(work),
    attemptsPerItem: 1,
    push: true,
    openPr: async () => ({ url: 'https://example.test/pr/1', number: 1 }),
  });

  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.deepEqual(result.changedFiles, ['index.js']);
  assert.equal(result.checks.find((c) => c.name === 'test')?.status, 'PASSED');
  assert.equal(result.prNumber, 1);

  // The branch is really on the remote, and the change is really in it.
  const remoteHead = git(['rev-parse', `refs/heads/forge/deliver-test`], remoteDir);
  assert.equal(remoteHead, result.headCommit);
  const show = git(['show', `refs/heads/forge/deliver-test:index.js`], remoteDir);
  assert.match(show, /1\.1\.0/);
  // The base branch was never touched.
  assert.equal(git(['rev-parse', 'refs/heads/main'], remoteDir), commit);
});

test('delivery refuses to push when the target\'s own check fails', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed',
    goal: 'break the version',
    commit,
    branch: 'forge/broken',
    workspaceDir: work,
    token: 'unused-in-local-test',
    remoteUrl: remoteDir,
    rosterFor: rosterForWorkspace(work, { bad: true }),
    attemptsPerItem: 1,
    push: true,
    // The bad change still touches index.js, so this assertion is met; the
    // target's failing test is what blocks the run.
    expect: [{ touchedAny: ['index.js'] }],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /check "test" failed/);
  // The assertion record survives the later failing check.
  assert.equal(result.expected.length, 1);
  assert.equal(result.expected[0].met, true);
  // No branch was created on the remote.
  const branches = git(['branch', '--list'], remoteDir);
  assert.doesNotMatch(branches, /forge\/broken/);
});

test('delivery detects a change that only adds a new file', async () => {
  const { remoteDir, commit } = seedRemote({ testScript: 'node pass.js' });
  const work = tmp('deliver-work-');
  const addFile = (_item: WorkItem, _attempt: number): Role[] => {
    return DEFAULT_ROSTER.map((r) => {
      const script: AgentAction[] =
        r.id === 'implementer'
          ? [
              { tool: 'write_file', input: { path: 'NEW.md', content: '# new\n' } },
              { tool: 'run_check', input: { command: 'test' } },
              { tool: 'finish', input: { summary: 'added a file', data: { files: { 'NEW.md': '# new\n' } } } },
            ]
          : r.id === 'qa'
            ? [
                { tool: 'run_check', input: { command: 'test' } },
                { tool: 'finish', input: { summary: 'ran the check', data: {} } },
              ]
            : [{ tool: 'finish', input: { summary: r.id, data: r.id === 'security' ? { clean: true } : r.id === 'reviewer' ? { blockers: 0 } : {} } }];
      let i = 0;
      return {
        ...r,
        tools: buildRoleTools({ workspaceDir: work, canMutate: r.authority === 'branch-write' }),
        brain: (async () => script[Math.min(i++, script.length - 1)]) as AgentBrain,
      };
    });
  };
  const result = await deliverChange({
    target: 'local/seed', goal: 'add a file', commit, branch: 'forge/add-only',
    workspaceDir: work, token: 'unused-in-local-test', remoteUrl: remoteDir,
    rosterFor: addFile, attemptsPerItem: 1, push: true,
    openPr: async () => ({ url: 'https://example.test/pr/2', number: 2 }),
  });
  // `git diff` alone would miss an untracked file; the run must still see it.
  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.deepEqual(result.changedFiles, ['NEW.md']);
  const remoteHead = git(['rev-parse', 'refs/heads/forge/add-only'], remoteDir);
  assert.equal(remoteHead, result.headCommit);
});

test('delivery refuses when the target\'s checks already fail at the base commit', async () => {
  // A repository whose own test script fails on main.
  const remoteDir = tmp('deliver-remote-fail-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-fail-');
  git(['init', '-q', '-b', 'main', seedDir]);
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'broken-target', scripts: { test: 'node check.js' } }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'index.js'), "module.exports = {};\n");
  fs.writeFileSync(path.join(seedDir, 'check.js'), 'console.error("already broken");\nprocess.exit(1);\n');
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'broken seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);

  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed', goal: 'x', commit, branch: 'forge/baseline',
    workspaceDir: work, token: 't', remoteUrl: remoteDir,
    rosterFor: rosterForWorkspace(work), push: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /already fails at/);
  // The company never even started; no branch was created.
  assert.doesNotMatch(git(['branch', '--list'], remoteDir), /forge\/baseline/);
});

/** A repository whose README is a real 242-line file (the #96 shape). */
function seedReadmeRepo(): { remoteDir: string; commit: string; body: string } {
  const remoteDir = tmp('deliver-remote-readme-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-readme-');
  git(['init', '-q', '-b', 'main', seedDir]);
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'readme-target', scripts: { test: 'node pass.js' } }, null, 2));
  fs.writeFileSync(path.join(seedDir, 'pass.js'), 'process.exit(0);\n');
  const readme = Array.from({ length: 242 }, (_, i) => `line ${i + 1} of the readme`).join('\n') + '\n';
  fs.writeFileSync(path.join(seedDir, 'README.md'), readme);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);
  return { remoteDir, commit, body: readme };
}

/** A roster whose implementer follows `script`; every other role finishes cleanly. */
function rosterScript(work: string, script: AgentAction[]) {
  return (_item: WorkItem, _attempt: number): Role[] =>
    DEFAULT_ROSTER.map((r) => {
      const actions: AgentAction[] =
        r.id === 'implementer'
          ? script
          : [{ tool: 'finish', input: { summary: r.id, data: r.id === 'security' ? { clean: true } : r.id === 'reviewer' ? { blockers: 0 } : {} } }];
      let i = 0;
      return {
        ...r,
        tools: buildRoleTools({ workspaceDir: work, canMutate: r.authority === 'branch-write' }),
        brain: (async () => actions[Math.min(i++, actions.length - 1)]) as AgentBrain,
      };
    });
}

test('REGRESSION #96: write_file cannot overwrite an existing file (the 400-char rewrite)', async () => {
  const { remoteDir, commit } = seedReadmeRepo();
  const work = tmp('deliver-work-');
  const tools = buildWorkspaceTools({ workspace: work, allowMutation: true });
  // Put a real README in the workspace first.
  fs.writeFileSync(path.join(work, 'README.md'), 'x\n'.repeat(242));
  const write = tools.find((t) => t.name === 'write_file')!;
  const ctx = { goal: 'g', workspace: work, step: 1 };
  const short = '> Verified by the Forge software company.\n';
  const res = await write.run({ path: 'README.md', content: short }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /File exists\. Use edit_file\./);
  // The file was not touched.
  assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8').split('\n').length, 243);
  void remoteDir;
  void commit;
});

test('REGRESSION #96: a shrink that gets past the tool is blocked, and no branch is pushed', async () => {
  const { remoteDir, commit, body } = seedReadmeRepo();
  const work = tmp('deliver-work-');
  // Get around write_file's guard by using edit_file to delete 240 of 242 lines.
  const script: AgentAction[] = [
    { tool: 'read_file', input: { path: 'README.md' } },
    { tool: 'edit_file', input: { path: 'README.md', old_str: body.split('\n').slice(1, 241).join('\n') + '\n', new_str: '> only a fragment\n' } },
    { tool: 'run_check', input: { command: 'test' } },
    { tool: 'finish', input: { summary: 'trimmed the readme', data: {} } },
  ];
  const result = await deliverChange({
    target: 'local/seed', goal: 'trim the readme', commit, branch: 'forge/shrink',
    workspaceDir: work, token: 't', remoteUrl: remoteDir, rosterFor: rosterScript(work, script),
    attemptsPerItem: 1, push: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /destroys existing content/);
  assert.match(result.reason, /README\.md/);
  assert.equal(result.checks.find((c) => c.name === 'shrink-guard')?.status, 'FAILED');
  assert.doesNotMatch(git(['branch', '--list'], remoteDir), /forge\/shrink/);
  // The README on the remote is still intact (git trims the trailing newline).
  assert.equal(git(['show', 'refs/heads/main:README.md'], remoteDir).split('\n').length, 242);
});

test('positive: an edit_file that adds one line is +1/-0 and meets the goal assertion', async () => {
  const { remoteDir, commit } = seedReadmeRepo();
  const work = tmp('deliver-work-');
  const script: AgentAction[] = [
    { tool: 'read_file', input: { path: 'README.md' } },
    {
      tool: 'edit_file',
      input: {
        path: 'README.md',
        old_str: 'line 1 of the readme\n',
        new_str: '> Verified by the Forge software company.\nline 1 of the readme\n',
      },
    },
    { tool: 'run_check', input: { command: 'test' } },
    { tool: 'finish', input: { summary: 'added the line', data: {} } },
  ];
  const result = await deliverChange({
    target: 'local/seed', goal: 'add one line', commit, branch: 'forge/one-line',
    workspaceDir: work, token: 't', remoteUrl: remoteDir, rosterFor: rosterScript(work, script),
    attemptsPerItem: 1, push: true,
    expect: [{ file: 'README.md', addedLinesContain: 'Verified by the Forge software company.', maxDeletions: 0 }],
    openPr: async () => ({ url: 'https://example.test/pr/9', number: 9 }),
  });
  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.deepEqual(result.changedFiles, ['README.md']);
  assert.equal(result.expected[0].met, true);
  // Exactly +1 / -0 on the pushed branch.
  const numstat = git(['diff', '--numstat', 'main', 'forge/one-line'], remoteDir);
  assert.equal(numstat, '1\t0\tREADME.md');
});

test('expect: a change that violates maxDeletions:0 is blocked', async () => {
  const { remoteDir, commit, body } = seedReadmeRepo();
  const work = tmp('deliver-work-');
  // Delete 5 lines — under the shrink guard (30), so only the expectation catches it.
  const script: AgentAction[] = [
    { tool: 'read_file', input: { path: 'README.md' } },
    { tool: 'edit_file', input: { path: 'README.md', old_str: body.split('\n').slice(0, 6).join('\n'), new_str: 'line 1 of the readme' } },
    { tool: 'run_check', input: { command: 'test' } },
    { tool: 'finish', input: { summary: 'removed some lines', data: {} } },
  ];
  const result = await deliverChange({
    target: 'local/seed', goal: 'remove lines', commit, branch: 'forge/expect-del',
    workspaceDir: work, token: 't', remoteUrl: remoteDir, rosterFor: rosterScript(work, script),
    attemptsPerItem: 1, push: true,
    expect: [{ file: 'README.md', maxDeletions: 0 }],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /goal assertion/);
  assert.equal(result.expected[0].met, false);
  assert.doesNotMatch(git(['branch', '--list'], remoteDir), /forge\/expect-del/);
});

test('expect: a change that violates maxAdditions:1 is blocked (the +2 blank line)', async () => {
  const { remoteDir, commit } = seedReadmeRepo();
  const work = tmp('deliver-work-');
  // Adds two lines where the goal asked for one.
  const script: AgentAction[] = [
    { tool: 'read_file', input: { path: 'README.md' } },
    {
      tool: 'edit_file',
      input: { path: 'README.md', old_str: 'line 1 of the readme\n', new_str: '> Verified by the Forge software company.\n\nline 1 of the readme\n' },
    },
    { tool: 'run_check', input: { command: 'test' } },
    { tool: 'finish', input: { summary: 'added a line and a blank', data: {} } },
  ];
  const result = await deliverChange({
    target: 'local/seed', goal: 'add one line', commit, branch: 'forge/expect-add',
    workspaceDir: work, token: 't', remoteUrl: remoteDir, rosterFor: rosterScript(work, script),
    attemptsPerItem: 1, push: true,
    expect: [{ file: 'README.md', addedLinesContain: 'Verified by the Forge software company.', maxDeletions: 0, maxAdditions: 1 }],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /adds 2 line/);
  assert.doesNotMatch(git(['branch', '--list'], remoteDir), /forge\/expect-add/);
});

test('edit_file: unique match edits; zero and multiple matches are rejected; outside the workspace is rejected', async () => {
  const work = tmp('tools-');
  fs.writeFileSync(path.join(work, 'a.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(work, 'dup.txt'), 'same\nsame\n');
  const tools = buildWorkspaceTools({ workspace: work, allowMutation: true });
  const edit = tools.find((t) => t.name === 'edit_file')!;
  const ctx = { goal: 'g', workspace: work, step: 1 };

  const ok = await edit.run({ path: 'a.txt', old_str: 'beta', new_str: 'BETA' }, ctx);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /\+1 line\(s\), -1 line\(s\)|-\d+ line/);
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');

  const missing = await edit.run({ path: 'a.txt', old_str: 'not-there', new_str: 'x' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /not found/);

  const multiple = await edit.run({ path: 'dup.txt', old_str: 'same', new_str: 'x' }, ctx);
  assert.equal(multiple.ok, false);
  assert.match(multiple.output, /not unique/);

  const outside = await edit.run({ path: '../escape.txt', old_str: 'a', new_str: 'b' }, ctx);
  assert.equal(outside.ok, false);
  assert.match(outside.output, /outside the workspace/);
});

test('write_file: creates a new file, refuses to overwrite an existing one', async () => {
  const work = tmp('tools-');
  const tools = buildWorkspaceTools({ workspace: work, allowMutation: true });
  const write = tools.find((t) => t.name === 'write_file')!;
  const ctx = { goal: 'g', workspace: work, step: 1 };

  const created = await write.run({ path: 'new.txt', content: 'hello\n' }, ctx);
  assert.equal(created.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'new.txt'), 'utf8'), 'hello\n');

  const overwrite = await write.run({ path: 'new.txt', content: 'goodbye\n' }, ctx);
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.output, /File exists\. Use edit_file\./);
  assert.equal(fs.readFileSync(path.join(work, 'new.txt'), 'utf8'), 'hello\n');
});

test('delivery refuses a branch that is not under forge/', async () => {
  const { remoteDir, commit } = seedRemote();
  const result = await deliverChange({
    target: 'local/seed', goal: 'x', commit, branch: 'main', workspaceDir: tmp('w-'),
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(tmp('w-')), push: false,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /must start with "forge\/"|base branch/);
});

test('delivery refuses to push a change it cannot verify (no checks declared)', async () => {
  const remoteDir = tmp('deliver-remote-');
  git(['init', '--bare', '-q', '-b', 'main', remoteDir]);
  const seedDir = tmp('deliver-seed-');
  git(['init', '-q', '-b', 'main', seedDir]);
  fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'no-scripts' }));
  fs.writeFileSync(path.join(seedDir, 'index.js'), 'module.exports = {};\n');
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'add', '-A'], seedDir);
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed'], seedDir);
  const commit = git(['rev-parse', 'HEAD'], seedDir);
  git(['push', '-q', remoteDir, 'HEAD:refs/heads/main'], seedDir);

  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed', goal: 'x', commit, branch: 'forge/nochecks', workspaceDir: work,
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(work), push: true,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /no test or lint script/);
});

test('honesty: a goal supplied directly is reported as NOT audited (report + PR body)', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  let body = '';
  const result = await deliverChange({
    target: 'local/seed', goal: 'bump the version', commit, branch: 'forge/no-audit', workspaceDir: work,
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(work), attemptsPerItem: 1, push: true,
    openPr: async ({ body: b }) => { body = b; return { url: 'https://example.test/pr/n', number: 7 }; },
  });
  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.equal(result.audited, false);
  // The report must not claim the target was audited.
  assert.doesNotMatch(result.markdown, /audited `local\/seed`/);
  assert.match(result.markdown, /NOT audited|no audit was run/);
  // The PR body must not claim an audit happened.
  assert.doesNotMatch(body, /audited `local\/seed`/);
  assert.match(body, /No audit was run/);
  assert.doesNotMatch(body, /no findings supplied/);
});

test('honesty: findings from a real audit let the report say the target was audited', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  let body = '';
  const result = await deliverChange({
    target: 'local/seed', goal: 'address the audit', commit, branch: 'forge/audited', workspaceDir: work,
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(work), attemptsPerItem: 1, push: true,
    audited: true,
    findings: [{ severity: 'MEDIUM', title: 'version is stale', paths: ['index.js'], basis: 'observed', evidence: 'index.js declares 1.0.0', recommendation: 'bump it', raisedBy: 'Quality Auditor' }],
    openPr: async ({ body: b }) => { body = b; return { url: 'https://example.test/pr/a', number: 8 }; },
  });
  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.equal(result.audited, true);
  assert.equal(result.findings.length, 1);
  assert.match(result.markdown, /Source: an audit of this target/);
  assert.match(body, /audited `local\/seed`/);
  assert.match(body, /MEDIUM — version is stale/);
});

test('a change that does not touch the finding\'s file is refused (touchedAny)', async () => {
  const { remoteDir, commit } = seedRemote();
  const work = tmp('deliver-work-');
  const result = await deliverChange({
    target: 'local/seed', goal: 'fix the coupling in server.ts', commit, branch: 'forge/touch', workspaceDir: work,
    token: 't', remoteUrl: remoteDir, rosterFor: rosterForWorkspace(work), attemptsPerItem: 1, push: false,
    audited: true,
    findings: [{ severity: 'HIGH', title: 'server.ts instantiates services directly', paths: ['server.ts'], basis: 'observed', evidence: 'new ForgeAgent() in a route handler', recommendation: 'inject the dependency', raisedBy: 'Architecture Auditor' }],
    // The roster changes index.js, never server.ts, so this must be blocked.
    expect: [{ touchedAny: ['server.ts'] }],
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /does not meet the goal assertion/);
  const assertion = result.expected.find((e) => e.assertion.includes('touchedAny'));
  assert.ok(assertion, 'the touchedAny assertion should be recorded');
  assert.equal(assertion!.met, false);
  assert.match(assertion!.detail, /none of the finding's files were changed/);
});