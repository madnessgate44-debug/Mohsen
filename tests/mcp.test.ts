import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// This test spawns the real Forreyra MCP server and talks to it over stdio with
// real JSON-RPC, then has it drive a real headless Chromium against a real local
// HTTP server. Nothing is mocked.

const PAGE = `<!doctype html><html><head><title>MCP Browser Page</title></head>
<body><h1>Hello from MCP</h1><a href="/next">next</a></body></html>`;

let http: Server;
let base = '';
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
let buffer = '';

function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Chromium's first launch on a contended CI runner can exceed the old 30s
    // budget (a following call took 12s). The timeout must not be the thing
    // that fails a correct run, so give cold start generous headroom.
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 90_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method: string, params: unknown = {}): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

test.before(async () => {
  http = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/next' ? '<html><title>Next</title><body>next page</body></html>' : PAGE);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const addr = http.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  child = spawn('npx', ['tsx', 'src/mcp/forreyra-server.ts'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* ignore non-JSON noise on stdout */
      }
    }
  });
  child.stderr.on('data', () => { /* server logs; ignored */ });
});

test.after(() => {
  // Kill the whole process group, not just `npx`: tsx and the Chromium it
  // launched are grandchildren. If any survives, it holds this process's stdio
  // pipe open and the test runner never exits — the intermittent CI hang where
  // `Run Tests` stalls forever. The group kill (as startup.test.ts does) reaps
  // every descendant.
  try {
    if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, 'SIGKILL');
    else child?.kill('SIGKILL');
  } catch {
    /* already exited */
  }
  http?.close();
});

test('MCP initialize handshake identifies the forreyra server', async () => {
  const res = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'forge-test', version: '1.0.0' },
  });
  assert.equal(res.result.serverInfo.name, 'forreyra');
  notify('notifications/initialized');
});

test('MCP tools/list advertises the browser tools', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    'browser_click',
    'browser_close',
    'browser_extract',
    'browser_open',
    'browser_press',
    'browser_query',
    'browser_screenshot',
    'browser_scroll',
    'browser_type',
    'browser_view',
  ]);
});

test('MCP tools/call browser_query answers in plain English', async () => {
  await rpc('tools/call', { name: 'browser_open', arguments: { url: base } });
  const res = await rpc('tools/call', { name: 'browser_query', arguments: { question: 'what is the title' } });
  assert.notEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /kind: title/);
  assert.match(res.result.content[0].text, /MCP Browser Page/);
});

test('MCP tools/call browser_open drives a real page', async () => {
  const res = await rpc('tools/call', { name: 'browser_open', arguments: { url: base } });
  assert.notEqual(res.result.isError, true);
  const text = res.result.content[0].text as string;
  assert.match(text, /title: MCP Browser Page/);
  assert.match(text, /Hello from MCP/);
  assert.match(text, /\[0\] a next -> \/next/);
});

test('MCP tools/call browser_extract returns page text', async () => {
  const res = await rpc('tools/call', { name: 'browser_extract', arguments: { pattern: 'Hello' } });
  assert.match(res.result.content[0].text, /Hello from MCP/);
});

test('MCP tools/call browser_screenshot returns a PNG image', async () => {
  const res = await rpc('tools/call', { name: 'browser_screenshot', arguments: {} });
  const part = res.result.content[0];
  assert.equal(part.type, 'image');
  assert.equal(part.mimeType, 'image/png');
  assert.ok(part.data.length > 100, 'expected base64 PNG data');
});

test('MCP tools/call browser_close closes the session', async () => {
  const res = await rpc('tools/call', { name: 'browser_close', arguments: {} });
  assert.match(res.result.content[0].text, /closed/i);
});
