import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runAgentLoop, type AgentTool, type LoopStep } from '../src/agent/loop.ts';
import { buildForgeTools } from '../src/agent/tools.ts';

// Adversarial regression tests. Each one first reproduced a real defect in the
// loop or the tool path guard, then locks the fix in place. No mocks: real
// promises, a real temp filesystem, real symlinks.

const ctx = { goal: 'g', workspace: 'ws', step: 1 };

// --- Runtime limits: a hanging model or tool must not defeat the ceiling -----

test('a hanging tool cannot defeat the runtime ceiling', async () => {
  const hang: AgentTool = { name: 'hang', description: 'never resolves', run: () => new Promise(() => {}) };
  const started = Date.now();
  const result = await runAgentLoop({
    goal: 'hang',
    tools: [hang],
    brain: async () => ({ tool: 'hang' }),
    limits: { maxSteps: 5, maxRuntimeMs: 120 },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /Runtime ceiling/);
  assert.ok(elapsed < 3000, `loop should stop promptly, took ${elapsed}ms`);
});

test('a hanging brain cannot defeat the runtime ceiling', async () => {
  const started = Date.now();
  const result = await runAgentLoop({
    goal: 'hang',
    tools: [{ name: 'read_file', description: 'r', run: async () => ({ ok: true, output: 'x' }) }],
    brain: () => new Promise(() => {}),
    limits: { maxSteps: 5, maxRuntimeMs: 120 },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /Runtime ceiling/);
  assert.ok(elapsed < 3000, `loop should stop promptly, took ${elapsed}ms`);
});

test('a slow-but-finite tool within budget still succeeds', async () => {
  const slow: AgentTool = {
    name: 'slow',
    description: 'resolves after 20ms',
    run: () => new Promise((res) => setTimeout(() => res({ ok: true, output: 'done' }), 20)),
  };
  const result = await runAgentLoop({
    goal: 'slow',
    tools: [slow, { name: 'finish', description: 'f', run: async () => ({ ok: true, output: 'f' }) }],
    brain: (() => {
      const script = [{ tool: 'slow' }, { tool: 'finish', input: { summary: 'ok' } }];
      let i = 0;
      return async () => script[Math.min(i++, script.length - 1)];
    })(),
    limits: { maxSteps: 5, maxRuntimeMs: 5000 },
  });
  assert.equal(result.status, 'COMPLETED');
});

// --- Completion integrity: finish must be able to be refused ----------------

test('by default finish completes, but a verifier can refuse it', async () => {
  const tools: AgentTool[] = [{ name: 'finish', description: 'f', run: async () => ({ ok: true, output: 'f' }) }];
  const brain = async () => ({ tool: 'finish', input: { summary: 'nothing done' } });

  const unverified = await runAgentLoop({ goal: 'g', tools, brain, limits: { maxSteps: 3, maxRuntimeMs: 5000 } });
  assert.equal(unverified.status, 'COMPLETED');

  const verified = await runAgentLoop({
    goal: 'g',
    tools,
    brain,
    limits: { maxSteps: 2, maxRuntimeMs: 5000 },
    verifyCompletion: () => ({ ok: false, reason: 'no evidence the goal was met' }),
  });
  assert.equal(verified.status, 'BLOCKED');
  assert.match(verified.reason, /Step ceiling/);
  const refused = verified.steps.find((s) => s.action.tool === 'finish');
  assert.equal(refused?.observation.ok, false);
  assert.match(refused!.observation.output, /no evidence the goal was met/);
});

test('a verifier that accepts lets the loop complete with its summary', async () => {
  let sawSummary = '';
  const result = await runAgentLoop({
    goal: 'g',
    tools: [{ name: 'finish', description: 'f', run: async () => ({ ok: true, output: 'f' }) }],
    brain: async () => ({ tool: 'finish', input: { summary: 'did the work' } }),
    limits: { maxSteps: 3, maxRuntimeMs: 5000 },
    verifyCompletion: (state) => {
      sawSummary = state.summary;
      return { ok: true };
    },
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.reason, 'did the work');
  assert.equal(sawSummary, 'did the work');
});

// --- Workspace isolation: symlinks must not escape the workspace ------------

function workspaceWithEscape(): { ws: string; outside: string } {
  const ws = mkdtempSync(path.join(tmpdir(), 'forge-adv-ws-'));
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  const outside = mkdtempSync(path.join(tmpdir(), 'forge-adv-out-'));
  symlinkSync(outside, path.join(ws, 'escape'), 'dir');
  writeFileSync(path.join(ws, 'src', 'app.ts'), 'export const A = 1;\n');
  return { ws, outside };
}

function toolsFor(ws: string): Map<string, AgentTool> {
  return new Map(buildForgeTools({ owner: 'o', repo: 'r', ref: 'main', workspace: ws, allowMutation: true }).map((t) => [t.name, t]));
}

test('write_file refuses to write through a symlink that leaves the workspace', async () => {
  const { ws, outside } = workspaceWithEscape();
  const t = toolsFor(ws);
  const obs = await t.get('write_file')!.run({ path: 'escape/pwned.txt', content: 'escaped' }, ctx);
  assert.equal(obs.ok, false);
  assert.match(obs.output, /outside the workspace/);
  assert.equal(existsSync(path.join(outside, 'pwned.txt')), false, 'nothing may land outside the workspace');
});

test('edit_file refuses to write through a symlink that leaves the workspace', async () => {
  const { ws, outside } = workspaceWithEscape();
  writeFileSync(path.join(outside, 'target.ts'), 'export const A = 1;\n');
  const t = toolsFor(ws);
  const obs = await t.get('edit_file')!.run(
    { path: 'escape/target.ts', edits: [{ find: 'A = 1', replace: 'A = 2' }] },
    ctx
  );
  assert.equal(obs.ok, false);
  assert.match(obs.output, /outside the workspace/);
  assert.match(readFileSync(path.join(outside, 'target.ts'), 'utf8'), /A = 1/, 'the outside file must be untouched');
});

test('a symlink that stays inside the workspace is still allowed', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'forge-adv-ok-'));
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'src', 'real.ts'), 'export const A = 1;\n');
  symlinkSync(path.join(ws, 'src'), path.join(ws, 'alias'), 'dir');
  const t = toolsFor(ws);
  const obs = await t.get('write_file')!.run({ path: 'alias/inside.ts', content: 'ok' }, ctx);
  assert.equal(obs.ok, true);
  assert.equal(existsSync(path.join(ws, 'src', 'inside.ts')), true);
});

test('ordinary ../ traversal is still refused (no regression)', async () => {
  const { ws } = workspaceWithEscape();
  const t = toolsFor(ws);
  const obs = await t.get('write_file')!.run({ path: '../escape.txt', content: 'x' }, ctx);
  assert.equal(obs.ok, false);
  assert.match(obs.output, /outside the workspace/);
});
