import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildBrowserTools } from '../src/agent/tools.ts';

// These tests drive a REAL headless Chromium against a REAL local HTTP server.
// No mocks: the page is served over the network and rendered by the browser.

const PAGE = `<!doctype html>
<html><head><title>Forge Browser Test</title></head>
<body>
  <h1>Welcome to the test page</h1>
  <p id="out">nothing yet</p>
  <a href="/second">Go to second page</a>
  <form onsubmit="document.getElementById('out').textContent = document.getElementById('name').value; return false;">
    <input id="name" name="name" placeholder="Your name" />
    <button type="submit">Submit</button>
  </form>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><title>Second</title></head><body><h1>Second page reached</h1></body></html>`;

const SHOP = `<!doctype html><html><head><title>Shop</title></head><body>
  <h1>Plans</h1>
  <p>Starter costs $9.99 and Pro costs $19.99. Email sales@example.com.</p>
  <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Starter</td><td>$9.99</td></tr><tr><td>Pro</td><td>$19.99</td></tr></table>
</body></html>`;

let server: Server;
let base = '';

function start(): Promise<void> {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/second') return res.end(PAGE2);
    if (req.url === '/shop') return res.end(SHOP);
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
      resolve();
    });
  });
}

test.before(async () => { await start(); });
test.after(() => { server?.close(); });

const ctx = { goal: 'g', workspace: 'ws', step: 1 };
const byName = () => {
  const tools = buildBrowserTools();
  return new Map(tools.map((t) => [t.name, t]));
};

test('browser_open returns a real snapshot with title, elements and text', async () => {
  const t = byName();
  const obs = await t.get('browser_open')!.run({ url: base }, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /title: Forge Browser Test/);
  assert.match(obs.output, /Welcome to the test page/);
  assert.match(obs.output, /\[0\] a .*-> \/second/);
  await t.get('browser_close')!.run({}, ctx);
});

test('browser_type fills an input and browser_click triggers the page script', async () => {
  const t = byName();
  const opened = await t.get('browser_open')!.run({ url: base }, ctx);
  // Locate the input by its index in the rendered element list.
  const inputLine = opened.output.split('\n').find((l) => l.includes('Your name'));
  const buttonLine = opened.output.split('\n').find((l) => l.includes('Submit'));
  assert.ok(inputLine && buttonLine, 'expected an input and a submit button');
  const inputIndex = Number(inputLine!.match(/^\[(\d+)\]/)![1]);
  const buttonIndex = Number(buttonLine!.match(/^\[(\d+)\]/)![1]);

  const typed = await t.get('browser_type')!.run({ index: inputIndex, text: 'Ahmed' }, ctx);
  assert.equal(typed.ok, true);
  const clicked = await t.get('browser_click')!.run({ index: buttonIndex }, ctx);
  assert.equal(clicked.ok, true);
  assert.match(clicked.output, /Ahmed/);
  await t.get('browser_close')!.run({}, ctx);
});

test('browser_click follows a link to a new page', async () => {
  const t = byName();
  const opened = await t.get('browser_open')!.run({ url: base }, ctx);
  const linkLine = opened.output.split('\n').find((l) => l.includes('-> /second'));
  const linkIndex = Number(linkLine!.match(/^\[(\d+)\]/)![1]);
  const clicked = await t.get('browser_click')!.run({ index: linkIndex }, ctx);
  assert.equal(clicked.ok, true);
  assert.match(clicked.output, /Second page reached/);
  await t.get('browser_close')!.run({}, ctx);
});

test('browser_extract returns only sentences matching a pattern', async () => {
  const t = byName();
  await t.get('browser_open')!.run({ url: base }, ctx);
  const obs = await t.get('browser_extract')!.run({ pattern: 'Welcome' }, ctx);
  assert.equal(obs.ok, true);
  assert.match(obs.output, /Welcome to the test page/);
  await t.get('browser_close')!.run({}, ctx);
});

test('browser tools reject bad input without throwing', async () => {
  const t = byName();
  assert.equal((await t.get('browser_open')!.run({}, ctx)).ok, false);
  assert.equal((await t.get('browser_click')!.run({ index: -1 }, ctx)).ok, false);
});

test('browser_query answers a plain-English question against the real page', async () => {
  const t = byName();
  await t.get('browser_open')!.run({ url: `${base}/shop` }, ctx);

  const prices = await t.get('browser_query')!.run({ question: 'what is the price' }, ctx);
  assert.equal(prices.ok, true);
  assert.match(prices.output, /kind: prices/);
  assert.match(prices.output, /\$19\.99/);

  const email = await t.get('browser_query')!.run({ question: 'what is the email address' }, ctx);
  assert.match(email.output, /sales@example\.com/);

  const rows = await t.get('browser_query')!.run({ question: 'how many rows are in the table' }, ctx);
  assert.match(rows.output, /matches: 1\n- 3/);

  const title = await t.get('browser_query')!.run({ question: 'what is the title' }, ctx);
  assert.match(title.output, /- Shop/);

  await t.get('browser_close')!.run({}, ctx);
});

