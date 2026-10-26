import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildForgeTools } from '../src/agent/tools.ts';
import type { AgentTool, LoopContext } from '../src/agent/loop.ts';

// Tool tests run against a real temp workspace, so they exercise the real
// filesystem code paths (no mocks, no network). GitHub is only a fallback for
// reads and is never hit here because every path exists in the workspace.

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-tools-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "demo",\n  "scripts": { "test": "tsx --test" }\n}\n');
  writeFileSync(path.join(dir, 'src', 'app.ts'), 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n');
  writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const VERSION = "1.2.3";\n');
  return dir;
}

function tools(workspace: string, allowMutation = false): AgentTool[] {
  return buildForgeTools({ owner: 'o', repo: 'r', ref: 'main', workspace, allowMutation });
}

function byName(list: AgentTool[]): Map<string, AgentTool> {
  return new Map(list.map((t) => [t.name, t]));
}

const ctx: LoopContext = { goal: 'test', workspace: 'ws', step: 1 };

test('read-only toolset exposes the discovery tools and hides mutating ones', () => {
  const names = tools(makeWorkspace()).map((t) => t.name).sort();
  assert.deepEqual(names, ['fetch_url', 'find_files', 'list_files', 'read_file', 'search', 'think']);
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('run_check'));
});

test('allowMutation adds the mutating tools', () => {
  const names = tools(makeWorkspace(), true).map((t) => t.name).sort();
  assert.ok(names.includes('edit_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('run_check'));
});

test('list_files lists real workspace files', async () => {
  const t = byName(tools(makeWorkspace()));
  const obs = await t.get('list_files')!.run({}, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /package\.json/);
  assert.match(obs.output, /src\/app\.ts/);
});

test('read_file returns content, and reports a missing file', async () => {
  const t = byName(tools(makeWorkspace()));
  const found = await t.get('read_file')!.run({ path: 'src/util.ts' }, ctx);
  assert.equal(found.ok, true);
  assert.match(found.output, /VERSION/);
  const missing = await t.get('read_file')!.run({ path: 'nope.ts' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /not found/i);
});

test('search finds matches with file:line and honours a glob', async () => {
  const t = byName(tools(makeWorkspace()));
  const all = await t.get('search')!.run({ pattern: 'VERSION' }, ctx);
  assert.equal(all.ok, true);
  assert.match(all.output, /src\/util\.ts:1:/);
  const scoped = await t.get('search')!.run({ pattern: 'greet', glob: '*.json' }, ctx);
  assert.equal(scoped.ok, true);
  assert.match(scoped.output, /No matches/);
});

test('search treats a bare "*" glob as all files, not just top level', async () => {
  const t = byName(tools(makeWorkspace()));
  const obs = await t.get('search')!.run({ pattern: 'VERSION', glob: '*' }, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /src\/util\.ts:1:/);
});

test('search rejects an invalid regular expression without throwing', async () => {
  const t = byName(tools(makeWorkspace()));
  const obs = await t.get('search')!.run({ pattern: '(' }, ctx);
  assert.equal(obs.ok, false);
  assert.match(obs.output, /Invalid pattern/);
});

test('find_files matches by glob', async () => {
  const t = byName(tools(makeWorkspace()));
  const obs = await t.get('find_files')!.run({ glob: 'src/**/*.ts' }, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /src\/app\.ts/);
  assert.match(obs.output, /src\/util\.ts/);
});

test('think records a thought without changing anything', async () => {
  const t = byName(tools(makeWorkspace()));
  const obs = await t.get('think')!.run({ thought: 'plan the change' }, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /plan the change/);
});

test('write_file creates a real file that read_file can read back', async () => {
  const ws = makeWorkspace();
  const t = byName(tools(ws, true));
  const obs = await t.get('write_file')!.run({ path: 'docs/new.md', content: '# hello' }, ctx);
  assert.equal(obs.ok, true);
  assert.ok(existsSync(path.join(ws, 'docs', 'new.md')));
  const back = await t.get('read_file')!.run({ path: 'docs/new.md' }, ctx);
  assert.equal(back.output, '# hello');
});

test('edit_file applies an exact-anchor edit to disk', async () => {
  const ws = makeWorkspace();
  const t = byName(tools(ws, true));
  const obs = await t.get('edit_file')!.run(
    { path: 'src/util.ts', edits: [{ find: '1.2.3', replace: '2.0.0' }] },
    ctx
  );
  assert.equal(obs.ok, true);
  assert.match(readFileSync(path.join(ws, 'src', 'util.ts'), 'utf8'), /2\.0\.0/);
});

test('edit_file refuses an edit whose anchor is not unique', async () => {
  const ws = makeWorkspace();
  const t = byName(tools(ws, true));
  const obs = await t.get('edit_file')!.run(
    { path: 'src/app.ts', edits: [{ find: 'name', replace: 'X' }] },
    ctx
  );
  assert.equal(obs.ok, false);
  assert.match(obs.output, /Edit rejected/);
});

test('write_file refuses to escape the workspace', async () => {
  const ws = makeWorkspace();
  const t = byName(tools(ws, true));
  const obs = await t.get('write_file')!.run({ path: '../escape.txt', content: 'x' }, ctx);
  assert.equal(obs.ok, false);
  assert.match(obs.output, /outside the workspace/);
});

test('run_check refuses a command outside the allowlist', async () => {
  const t = byName(tools(makeWorkspace(), true));
  const obs = await t.get('run_check')!.run({ command: 'rm -rf /' }, ctx);
  assert.equal(obs.ok, false);
  assert.match(obs.output, /exit=126/);
});
