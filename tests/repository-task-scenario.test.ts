import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildForgeTools } from '../src/agent/tools.ts';
import { runAgentLoop, type AgentAction } from '../src/agent/loop.ts';

// Scenario-specific repository task: inspect -> locate -> make one exact edit ->
// execute the repository's own test command -> verify the result. All mutations
// are confined to a disposable temporary fixture, never this repository.

test('repository task: Forge completes a bounded inspect-edit-test-verify mission', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'forge-repo-scenario-'));
  try {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    mkdirSync(path.join(workspace, 'tests'), { recursive: true });
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'forge-scenario-fixture', private: true, type: 'module',
      scripts: { test: 'node --test tests/*.test.js' },
    }, null, 2) + '\n');
    writeFileSync(path.join(workspace, 'src', 'message.js'), "export const message = 'old-message';\n");
    writeFileSync(path.join(workspace, 'tests', 'message.test.js'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { message } from '../src/message.js'; test('message is updated', () => assert.equal(message, 'new-message'));\n");

    const tools = buildForgeTools({
      owner: 'fixture', repo: 'fixture', allowMutation: true, allowBrowser: false, workspace,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const actions: AgentAction[] = [
      { tool: 'list_files' },
      { tool: 'read_file', input: { path: 'src/message.js' } },
      { tool: 'search', input: { pattern: 'old-message', glob: '**/*.js' } },
      { tool: 'edit_file', input: { path: 'src/message.js', edits: [{ find: 'old-message', replace: 'new-message' }] } },
      { tool: 'run_check', input: { command: 'npm test' } },
      { tool: 'read_file', input: { path: 'src/message.js' } },
      { tool: 'finish', input: { summary: 'Updated the message and verified the repository test command.' } },
    ];
    const observations: { tool: string; ok: boolean; output: string }[] = [];
    let cursor = 0;
    const result = await runAgentLoop({
      goal: 'Update the message constant and ensure the project test passes.',
      tools,
      workspace,
      limits: { maxSteps: 10, maxRuntimeMs: 60_000 },
      authorize: () => ({ allowed: true }),
      brain: async () => actions[cursor++] ?? { tool: 'finish', input: { summary: 'Fallback finish' } },
      onStep: (step) => observations.push({ tool: step.action.tool, ok: step.observation.ok, output: step.observation.output }),
    });

    assert.equal(result.status, 'COMPLETED', result.reason);
    assert.deepEqual(result.steps.map((step) => step.action.tool), actions.map((action) => action.tool));
    assert.deepEqual(observations.map((step) => step.tool), actions.slice(0, -1).map((action) => action.tool));
    assert.ok(observations.every((step) => step.ok), JSON.stringify(observations.filter((step) => !step.ok)));
    assert.match(observations[0].output, /src\/message\.js/);
    assert.match(observations[2].output, /old-message/);
    assert.match(observations[3].output, /Applied 1 edit/);
    assert.match(observations[4].output, /exit=0 status=PASSED/);
    assert.match(observations[4].output, /pass 1\b/);
    assert.match(observations[5].output, /new-message/);
    assert.equal(readFileSync(path.join(workspace, 'src', 'message.js'), 'utf8'), "export const message = 'new-message';\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
