import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelService, isKeylessOnly, CREDENTIAL_ENV_NAMES, extractJson, routeAliasesFor, type ChatMessage } from '../src/company/model.ts';
import { guardRepeatedReadOnly, buildRolePrompt, modelBrain } from '../src/company/brains.ts';
import type { AgentBrainState } from '../src/kernel/loop.ts';

// The model is a network service, so the *pure* logic around it is what we prove
// here: which keys are honoured, keyless-only stripping, the repeated-read-only
// guard, prompt construction, and the brain's safe fallback. No network is hit.

test('the company reads the same provider keys as Forge', () => {
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'KILO_API_KEY', 'FREELM_GROQ_KEYS']) {
    assert.ok(CREDENTIAL_ENV_NAMES.includes(name), `expected ${name} to be honoured`);
  }
});

test('keyless-only mode is recognized case-insensitively (GitHub capitalizes)', () => {
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'True' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'TRUE' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'false' }), false);
  assert.equal(isKeylessOnly({}), false);
});

test('keyless-only strips provider keys and disables the Gemini fallback', () => {
  const env: NodeJS.ProcessEnv = { FIRSTBORN_KEYLESS_ONLY: 'true', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  const model = new ModelService({ env });
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.FREELM_KEYLESS, '1');
  assert.equal(model.getProviderInfo().fallbackConfigured, false);
});

test('with a Gemini key present (not keyless-only) the fallback is configured', () => {
  const model = new ModelService({ env: { GEMINI_API_KEY: 'real-key' } });
  assert.equal(model.getProviderInfo().fallbackConfigured, true);
});

test('the repeated read-only guard replaces an identical repeat with a think nudge', () => {
  const action = { tool: 'read_file', input: { path: 'a.ts' } };
  const history = [{ action: { tool: 'read_file', input: { path: 'a.ts' } } }];
  assert.equal(guardRepeatedReadOnly(action, history).tool, 'think');
  // A first-time read is left alone; a mutating repeat is never altered.
  assert.equal(guardRepeatedReadOnly(action, []).tool, 'read_file');
  assert.equal(guardRepeatedReadOnly({ tool: 'write_file', input: { path: 'a.ts' } }, history).tool, 'write_file');
});

test('the role prompt carries the mandate, the goal, and upstream artifacts', () => {
  const state: AgentBrainState = { goal: 'ship it', history: [], tools: [{ name: 'finish', description: 'done' }], memory: '[{"kind":"design"}]' };
  const prompt = buildRolePrompt({ role: 'QA Engineer', mandate: 'Run the real checks.', artifactHint: 'Emit checks.' }, state);
  assert.match(prompt, /QA Engineer/);
  assert.match(prompt, /Run the real checks\./);
  assert.match(prompt, /ship it/);
  assert.match(prompt, /design/);
});

test('a model brain falls back to finish when the model returns nothing usable', async () => {
  // Structural double at the network boundary: the brain's own parse/fallback
  // logic is the code under test, and it must never leave the loop spinning.
  const stub = { completeJson: async () => ({ value: null, result: { text: '', model: 'x', provider: 'x', success: false } }) };
  const brain = modelBrain(stub as unknown as ModelService, { role: 'Implementer', mandate: 'write code', artifactHint: 'Emit files.' });
  const action = await brain({ goal: 'g', history: [], tools: [] });
  assert.equal(action.tool, 'finish');
});

test('a model brain parses a valid action and guards repeats', async () => {
  const stub = { completeJson: async () => ({ value: { tool: 'read_file', input: { path: 'a.ts' } }, result: { text: '{}', model: 'x', provider: 'x', success: true } }) };
  const brain = modelBrain(stub as unknown as ModelService, { role: 'Reviewer', mandate: 'review', artifactHint: 'Emit findings.' });
  const first = await brain({ goal: 'g', history: [], tools: [] });
  assert.equal(first.tool, 'read_file');
  const again = await brain({ goal: 'g', history: [{ index: 1, action: { tool: 'read_file', input: { path: 'a.ts' } }, observation: { ok: true, output: 'x' } }], tools: [] });
  assert.equal(again.tool, 'think'); // repeat replaced
});

test('ChatMessage type is usable for a system+user pair', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  assert.equal(messages.length, 2);
});

test('easy work is routed to the cheap keyless aliases first, hard work to the strong ones', () => {
  const easy = routeAliasesFor('easy');
  const hard = routeAliasesFor('hard');
  // Easy work should try a fast/small (keyless) route before any large model.
  assert.ok(easy.indexOf('chat:fast') < easy.indexOf('chat:large'));
  assert.ok(easy.indexOf('chat:small') < easy.indexOf('chat:large'));
  // Hard work should still try the strongest route first.
  assert.equal(hard[0], 'chat:large');
  // Both tiers keep every alias as a fallback, so a route can always be reached.
  assert.deepEqual([...easy].sort(), [...hard].sort());
});

test('extractJson parses fenced and prose-wrapped JSON, and returns null on garbage', () => {
  assert.deepEqual(extractJson<{ a: number }>('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson<{ a: number }>('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson<{ a: number }>('Here is my answer: {"a":3} — done.'), { a: 3 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});
