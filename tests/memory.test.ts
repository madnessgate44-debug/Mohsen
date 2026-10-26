import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopPrompt } from '../src/services/model.ts';
import { runAgentLoop, type AgentTool } from '../src/agent/loop.ts';

// The loop loads repository guidance (AGENTS.md) once and hands it to the brain
// on every step. These tests are pure: no model or network call.

const BASE = {
  goal: 'add a test',
  history: [],
  tools: [{ name: 'search', description: 'grep' }],
};

test('buildLoopPrompt fences repository guidance and marks it untrusted', () => {
  const prompt = buildLoopPrompt({ ...BASE, memory: 'Use tabs, never spaces.' });
  assert.match(prompt, /<<<AGENTS\nUse tabs, never spaces\.\nAGENTS>>>/);
  assert.match(prompt, /UNTRUSTED/);
});

test('buildLoopPrompt omits the guidance block when there is no memory', () => {
  const prompt = buildLoopPrompt(BASE);
  assert.doesNotMatch(prompt, /<<<AGENTS/);
  assert.match(prompt, /Available tools:/);
});

test('buildLoopPrompt caps very large guidance so it cannot flood the prompt', () => {
  const prompt = buildLoopPrompt({ ...BASE, memory: 'x'.repeat(20000) });
  assert.match(prompt, /<<<AGENTS/);
  assert.ok(prompt.length < 20000, 'guidance should be truncated');
});

test('the loop passes memory through to the brain on each step', async () => {
  const seen: (string | undefined)[] = [];
  const tools: AgentTool[] = [
    { name: 'noop', description: 'no-op', run: async () => ({ ok: true, output: 'ok' }) },
  ];
  const result = await runAgentLoop({
    goal: 'g',
    tools,
    memory: 'Conventions: keep changes minimal.',
    brain: async (state) => {
      seen.push(state.memory);
      return { tool: 'finish', input: { summary: 'done' } };
    },
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(seen, ['Conventions: keep changes minimal.']);
});
