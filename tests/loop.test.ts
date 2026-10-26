import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, loadLoopLimits, type AgentAction, type AgentTool } from '../src/agent/loop.ts';

// M2 — the agent loop. A scripted brain drives the real kernel deterministically,
// so these tests prove the loop's guarantees without any network or real model.

function tool(name: string, opts: { mutating?: boolean; onRun?: () => void } = {}): AgentTool {
  return {
    name,
    description: `${name} tool`,
    mutating: opts.mutating,
    run: async () => {
      opts.onRun?.();
      return { ok: true, output: `${name} done` };
    },
  };
}

// A brain that follows a fixed script, then calls finish.
function scripted(actions: AgentAction[]) {
  let i = 0;
  return async (): Promise<AgentAction> => actions[Math.min(i++, actions.length - 1)];
}

test('loop completes when the brain reaches finish', async () => {
  let edits = 0;
  const result = await runAgentLoop({
    goal: 'do a thing',
    tools: [tool('read_file'), tool('edit_file', { mutating: true, onRun: () => (edits += 1) }), tool('finish')],
    brain: scripted([
      { tool: 'read_file' },
      { tool: 'edit_file' },
      { tool: 'finish', input: { summary: 'all done' } },
    ]),
    limits: { maxSteps: 10, maxRuntimeMs: 100000 },
    authorize: () => ({ allowed: true }),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.reason, 'all done');
  assert.equal(edits, 1);
  // 2 real actions + the finish step are all recorded.
  assert.equal(result.steps.length, 3);
});

test('loop stops safely at the step ceiling (bounded, never infinite)', async () => {
  let runs = 0;
  const result = await runAgentLoop({
    goal: 'loop forever',
    tools: [tool('read_file', { onRun: () => (runs += 1) })],
    brain: scripted([{ tool: 'read_file' }]), // never finishes
    limits: { maxSteps: 3, maxRuntimeMs: 100000 },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /Step ceiling/);
  assert.equal(runs, 3);
});

test('loop stops at the runtime ceiling using the injected clock', async () => {
  let t = 0;
  const result = await runAgentLoop({
    goal: 'slow',
    tools: [tool('read_file')],
    brain: scripted([{ tool: 'read_file' }]),
    limits: { maxSteps: 100, maxRuntimeMs: 10 },
    now: () => (t += 100), // every check jumps 100ms past the ceiling
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /Runtime ceiling/);
});

test('a disallowed mutating action is refused, not executed, and the loop continues', async () => {
  let edits = 0;
  const result = await runAgentLoop({
    goal: 'edit',
    tools: [tool('edit_file', { mutating: true, onRun: () => (edits += 1) }), tool('finish')],
    brain: scripted([{ tool: 'edit_file' }, { tool: 'finish', input: { summary: 'held' } }]),
    limits: { maxSteps: 5, maxRuntimeMs: 100000 },
    authorize: () => ({ allowed: false, reason: 'readonly profile' }),
  });
  assert.equal(edits, 0); // the mutation never ran
  assert.equal(result.steps[0].observation.ok, false);
  assert.match(result.steps[0].observation.output, /blocked by policy/i);
  assert.equal(result.status, 'COMPLETED'); // the loop kept going and finished
});

test('an unknown tool is reported back so the brain can self-correct', async () => {
  const result = await runAgentLoop({
    goal: 'typo',
    tools: [tool('read_file'), tool('finish')],
    brain: scripted([{ tool: 'read_fil' }, { tool: 'finish', input: { summary: 'corrected' } }]),
    limits: { maxSteps: 5, maxRuntimeMs: 100000 },
  });
  assert.match(result.steps[0].observation.output, /Unknown tool/);
  assert.equal(result.status, 'COMPLETED');
});

test('a throwing tool becomes a failed observation, never crashes the loop', async () => {
  const boom: AgentTool = { name: 'boom', description: 'throws', run: async () => { throw new Error('kaboom'); } };
  const result = await runAgentLoop({
    goal: 'survive',
    tools: [boom, tool('finish')],
    brain: scripted([{ tool: 'boom' }, { tool: 'finish', input: { summary: 'recovered' } }]),
    limits: { maxSteps: 5, maxRuntimeMs: 100000 },
  });
  assert.equal(result.steps[0].observation.ok, false);
  assert.match(result.steps[0].observation.output, /kaboom/);
  assert.equal(result.status, 'COMPLETED');
});

test('a brain that throws fails the loop cleanly', async () => {
  const result = await runAgentLoop({
    goal: 'bad brain',
    tools: [tool('finish')],
    brain: async () => { throw new Error('brain offline'); },
    limits: { maxSteps: 5, maxRuntimeMs: 100000 },
  });
  assert.equal(result.status, 'FAILED');
  assert.match(result.reason, /Brain failed.*brain offline/);
});

test('loop limits are bounded and default conservatively', () => {
  const limits = loadLoopLimits({} as NodeJS.ProcessEnv);
  assert.equal(limits.maxSteps, 12);
  assert.ok(limits.maxSteps >= 1 && limits.maxSteps <= 100);
});
