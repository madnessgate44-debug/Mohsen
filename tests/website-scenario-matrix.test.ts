import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildBrowserTools } from '../src/agent/tools.ts';
import type { AgentTool } from '../src/agent/loop.ts';

// Scenario-specific website test: redirects, client-rendered content, query
// strings, and navigation are represented by a deterministic local HTTP site.
// This is deliberately not a claim that every arbitrary internet site works.

const INDEX = `<!doctype html><html><head><title>Multi-Page Scenario</title></head><body>
<h1>Start page</h1><a href="/redirect?from=start">Follow redirect</a>
<a href="/dynamic?mode=client">Open dynamic page</a>
</body></html>`;
const DESTINATION = `<!doctype html><html><head><title>Redirect Destination</title></head><body>
<h1>Redirect completed</h1><p>Server-side redirect preserved navigation.</p>
</body></html>`;
const DYNAMIC = `<!doctype html><html><head><title>Dynamic Shell</title></head><body>
<h1>Loading client content</h1><div id="app">loading</div>
<script>setTimeout(() => { document.title = 'Client Rendered Report'; document.getElementById('app').innerHTML = '<h2>Report ready</h2><p data-status="ready">42 records loaded</p><a href="/detail?id=42">Open record 42</a>'; }, 150);</script>
</body></html>`;
const DETAIL = `<!doctype html><html><head><title>Record Detail</title></head><body>
<h1>Record 42</h1><p>Record identifier: 42</p><p>Status: verified</p>
</body></html>`;

let server: Server;
let base = '';
function start(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/destination?source=redirect' }); res.end(); return;
    }
    const pages: Record<string, string> = {
      '/': INDEX, '/destination': DESTINATION, '/dynamic': DYNAMIC, '/detail': DETAIL,
    };
    const page = pages[url.pathname];
    if (!page) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
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
const ctx = { goal: 'test website scenario variations', workspace: 'website-scenario', step: 1 };
function toolsByName(): Map<string, AgentTool> {
  return new Map(buildBrowserTools().map((tool) => [tool.name, tool]));
}
function elementIndex(output: string, label: string): number {
  const line = output.split('\n').find((entry) => entry.includes(label));
  assert.ok(line, `interactive element not found: ${label}\n${output}`);
  const match = line.match(/^\[(\d+)\]/);
  assert.ok(match, `interactive element has no index: ${line}`);
  return Number(match[1]);
}

test('website scenario: click follows a server redirect and reports the final URL', async () => {
  const tools = toolsByName();
  try {
    const opened = await tools.get('browser_open')!.run({ url: base }, ctx);
    assert.equal(opened.ok, true, opened.output);
    assert.match(opened.output, /Multi-Page Scenario/);
    const clicked = await tools.get('browser_click')!.run({ index: elementIndex(opened.output, 'Follow redirect') }, ctx);
    assert.equal(clicked.ok, true, clicked.output);
    assert.match(clicked.output, /Redirect Destination/);
    assert.match(clicked.output, /\/destination\?source=redirect/);
    assert.match(clicked.output, /Redirect completed/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('website scenario: client-rendered page settles, then navigates to a query-string record', async () => {
  const tools = toolsByName();
  try {
    const opened = await tools.get('browser_open')!.run({ url: `${base}/dynamic?mode=client` }, ctx);
    assert.equal(opened.ok, true, opened.output);
    // browser_view takes a fresh snapshot after client-side rendering has had time to settle.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const viewed = await tools.get('browser_view')!.run({}, ctx);
    assert.equal(viewed.ok, true, viewed.output);
    assert.match(viewed.output, /Client Rendered Report/);
    assert.match(viewed.output, /42 records loaded/);
    const clicked = await tools.get('browser_click')!.run({ index: elementIndex(viewed.output, 'Open record 42') }, ctx);
    assert.equal(clicked.ok, true, clicked.output);
    assert.match(clicked.output, /Record Detail/);
    assert.match(clicked.output, /Record identifier: 42/);
    assert.match(clicked.output, /\/detail\?id=42/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});

test('website scenario: missing page fails cleanly and browser remains reusable', async () => {
  const tools = toolsByName();
  try {
    const missing = await tools.get('browser_open')!.run({ url: `${base}/does-not-exist` }, ctx);
    // A 404 page is still a valid navigable response; its status and content must remain observable.
    assert.equal(missing.ok, true, missing.output);
    assert.match(missing.output, /404|Not found|Not Found/i);
    const reopened = await tools.get('browser_open')!.run({ url: base }, ctx);
    assert.equal(reopened.ok, true, reopened.output);
    assert.match(reopened.output, /Start page/);
  } finally {
    await tools.get('browser_close')!.run({}, ctx);
  }
});
