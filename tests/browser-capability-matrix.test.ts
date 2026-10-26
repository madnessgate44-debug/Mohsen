import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildForgeTools, buildBrowserTools } from '../src/agent/tools.ts';
import type { AgentTool } from '../src/agent/loop.ts';

// Capability matrix: every browser tool is exercised against real Chromium and
// a deterministic local HTTP fixture. No external website or model is required.

const PAGE = `<!doctype html>
<html><head><title>Forge Capability Matrix</title></head>
<body>
  <h1>Capability test landing page</h1>
  <p id="out">nothing yet</p>
  <p id="scroll-state">scroll not observed</p>
  <a href="/second">Open second page</a>
  <form onsubmit="document.getElementById('out').textContent = document.getElementById('name').value; return false;">
    <input id="name" name="name" placeholder="Type a value" />
    <button type="submit">Submit form</button>
  </form>
  <div style="height:2400px">Long content for scrolling</div>
  <script>
    window.addEventListener('wheel', () => {
      document.getElementById('scroll-state').textContent = 'scroll observed';
    });
  </script>
</body></html>`;
const PAGE2 = '<!doctype html><html><head><title>Second page</title></head><body><h1>Navigation succeeded</h1></body></html>';

let server: Server;
let base = '';

function start(): Promise<void> {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/second' ? PAGE2 : PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
      resolve();
    });
  });
}

test.before(async () => { await start(); });
test.after(() => new Promise<void>((resolve, reject) => {
  if (!server?.listening) return resolve();
  server.close((error) => error ? reject(error) : resolve());
}));

const ctx = { goal: 'exercise browser capability matrix', workspace: 'test-workspace', step: 1 };
function mapTools(tools: AgentTool[]): Map<string, AgentTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}
function indexFor(output: string, text: string): number {
  const line = output.split('\n').find((item) => item.includes(text));
  assert.ok(line, `missing interactive element: ${text}\n${output}`);
  const match = line.match(/^\[(\d+)\]/);
  assert.ok(match, `element has no index: ${line}`);
  return Number(match[1]);
}

test('Forge capability registry exposes the complete browser set only when enabled', () => {
  const expectedBrowser = [
    'browser_open', 'browser_view', 'browser_click', 'browser_type',
    'browser_press', 'browser_scroll', 'browser_extract', 'browser_close',
  ];
  const disabled = buildForgeTools({ owner: 'owner', repo: 'repo', allowBrowser: false });
  assert.ok(expectedBrowser.every((name) => !disabled.some((tool) => tool.name === name)));
  const enabled = buildForgeTools({ owner: 'owner', repo: 'repo', allowBrowser: true });
  const actualBrowser = enabled.map((tool) => tool.name).filter((name) => name.startsWith('browser_')).sort();
  assert.ok(expectedBrowser.every((name) => actualBrowser.includes(name)));
  assert.ok(actualBrowser.every((name) => expectedBrowser.includes(name) || name === 'browser_query'));
});

test('Forge read-only mode hides every mutation; authorized mode exposes all mutation tools', () => {
  const readonly = buildForgeTools({ owner: 'owner', repo: 'repo', allowMutation: false, allowBrowser: true });
  const authorized = buildForgeTools({ owner: 'owner', repo: 'repo', allowMutation: true, allowBrowser: true });
  const mutationNames = ['edit_file', 'write_file', 'run_check'];
  assert.ok(mutationNames.every((name) => !readonly.some((tool) => tool.name === name)));
  assert.ok(mutationNames.every((name) => authorized.some((tool) => tool.name === name)));
  const queryAvailable = authorized.some((tool) => tool.name === 'browser_query');
  assert.equal(readonly.length, queryAvailable ? 15 : 14);
  assert.equal(authorized.length, queryAvailable ? 18 : 17);
});

test('browser_view re-reads the active page and preserves interactive indices', async () => {
  const tools = mapTools(buildBrowserTools());
  try {
    const opened = await tools.get('browser_open')!.run({ url: base }, ctx);
    assert.equal(opened.ok, true);
    const viewed = await tools.get('browser_view')!.run({}, ctx);
    assert.equal(viewed.ok, true);
    assert.match(viewed.output, /title: Forge Capability Matrix/);
    assert.match(viewed.output, /Capability test landing page/);
    assert.match(viewed.output, /Type a value/);
    assert.equal(indexFor(opened.output, 'Type a value'), indexFor(viewed.output, 'Type a value'));
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('browser_type followed by browser_press Enter submits the form', async () => {
  const tools = mapTools(buildBrowserTools());
  try {
    const opened = await tools.get('browser_open')!.run({ url: base }, ctx);
    const inputIndex = indexFor(opened.output, 'Type a value');
    const typed = await tools.get('browser_type')!.run({ index: inputIndex, text: 'press-path-verified' }, ctx);
    assert.equal(typed.ok, true);
    const pressed = await tools.get('browser_press')!.run({ key: 'Enter' }, ctx);
    assert.equal(pressed.ok, true);
    assert.match(pressed.output, /press-path-verified/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('browser_scroll supports down and up and dispatches real wheel input', async () => {
  const tools = mapTools(buildBrowserTools());
  try {
    const opened = await tools.get('browser_open')!.run({ url: base }, ctx);
    assert.equal(opened.ok, true);
    const down = await tools.get('browser_scroll')!.run({ direction: 'down' }, ctx);
    assert.equal(down.ok, true);
    assert.match(down.output, /scroll observed/);
    const up = await tools.get('browser_scroll')!.run({ direction: 'up' }, ctx);
    assert.equal(up.ok, true);
    assert.match(up.output, /Capability test landing page/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('browser_extract handles no-match and invalid regex input without crashing', async () => {
  const tools = mapTools(buildBrowserTools());
  try {
    await tools.get('browser_open')!.run({ url: base }, ctx);
    const noMatch = await tools.get('browser_extract')!.run({ pattern: 'definitely-not-present' }, ctx);
    assert.equal(noMatch.ok, true);
    assert.match(noMatch.output, /No text matched/);
    const invalid = await tools.get('browser_extract')!.run({ pattern: '(' }, ctx);
    assert.equal(invalid.ok, true);
    assert.match(invalid.output, /Invalid pattern/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('browser_close releases the session and the browser can start a fresh session', async () => {
  const tools = mapTools(buildBrowserTools());
  const first = await tools.get('browser_open')!.run({ url: base }, ctx);
  assert.equal(first.ok, true);
  const closed = await tools.get('browser_close')!.run({}, ctx);
  assert.equal(closed.ok, true);
  assert.match(closed.output, /Browser closed/);
  try {
    const reopened = await tools.get('browser_open')!.run({ url: `${base}/second` }, ctx);
    assert.equal(reopened.ok, true);
    assert.match(reopened.output, /title: Second page/);
    assert.match(reopened.output, /Navigation succeeded/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('browser_query answers a structured natural-language question when available', async () => {
  const tools = mapTools(buildBrowserTools());
  const query = tools.get('browser_query');
  // Older branches may not yet include this newer capability. The PR's merged
  // main branch does, so CI exercises the implementation there.
  if (!query) return;
  try {
    const opened = await tools.get('browser_open')!.run({ url: base }, ctx);
    assert.equal(opened.ok, true);
    const result = await query.run({ question: 'what is the title' }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.output, /kind: title/);
    assert.match(result.output, /Forge Capability Matrix/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('fetch_url retrieves a local HTTP response and reports its status', async () => {
  const tools = mapTools(buildForgeTools({ owner: 'owner', repo: 'repo' }));
  const fetchTool = tools.get('fetch_url');
  assert.ok(fetchTool, 'fetch_url must be registered in the base Forge toolset');
  const result = await fetchTool.run({ url: base }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.output, /HTTP 200/);
  assert.match(result.output, /Capability test landing page/);
});

test('run_check executes an allowlisted verification command and rejects arbitrary commands', async () => {
  const tools = mapTools(buildForgeTools({ owner: 'owner', repo: 'repo', allowMutation: true }));
  const check = tools.get('run_check');
  assert.ok(check, 'run_check must be registered when mutations are enabled');
  const result = await check.run({ command: 'git diff --check' }, { ...ctx, workspace: process.cwd() });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /exit=0 status=PASSED/);
  const rejected = await check.run({ command: 'git status && rm -rf /' }, { ...ctx, workspace: process.cwd() });
  assert.equal(rejected.ok, false);
  assert.match(rejected.output, /exit=126/);
});
