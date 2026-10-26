# Forreyra — the browser

**Forreyra** is Forge's real browser. It drives an actual Chromium session, so the
agent can open pages, look at them, click, type, scroll, and read the text — the
same way a person uses a browser. It is named for Foryra, the missions repo.

There are three ways to use it, from simplest to most integrated.

---

## 1. One-command CLI

No code. One command opens a page, prints its interactive elements, and can run a
chain of actions left to right against that one open page.

```bash
npm run forreyra -- https://example.com
```

```
url:   https://example.com/
title: Example Domain
elements:
  [0] a Learn more -> https://iana.org/help/example-domains
```

### Actions

| Action | Meaning |
| --- | --- |
| `click:<n>` | click element `[n]` from the last view |
| `type:<n>=<text>` | type text into element `[n]` |
| `press:<key>` | press a key, e.g. `press:Enter` |
| `scroll:up` / `scroll:down` | scroll one screen |
| `extract[:<regex>]` | print the page text (optionally only matching sentences) |
| `query:<question>` | answer a plain-English question, e.g. `query:what is the price` |
| `view` | re-print the element list |

### Examples

```bash
# read the top story headline from Hacker News
npm run forreyra -- https://news.ycombinator.com extract:Apple

# click a link, then read the page it lands on
npm run forreyra -- https://example.com click:0 extract:IANA

# search: type into the search box, press Enter, read the results
npm run forreyra -- https://duckduckgo.com type:1=playwright press:Enter

# ask a question in plain English — no regex
npm run forreyra -- https://example.com query:what is the title
npm run forreyra -- https://books.toscrape.com query:what is the price
```

Elements are numbered in document order. A `view` (or `open`) is always followed
by a fresh element list, so the `[n]` you click is exactly the element you saw.

---

## 2. As agent tools (Forge uses it like a person)

When the loop runs with the browser enabled, Forge gets eight tools:

`browser_open`, `browser_view`, `browser_click`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_extract`, `browser_query`,
`browser_screenshot`, `browser_close`.

A goal like *"open news.ycombinator.com and report the top story"* makes Forge
call `browser_open`, read the numbered elements, and finish with the answer.

Enable it by setting `FORGE_ALLOW_BROWSER` (default on; set to `false` to remove
the tools entirely):

```bash
FORGE_ALLOW_BROWSER=true \
FORGE_LOOP_GOAL="Open https://example.com and report the title." \
npx tsx src/agent/loop-runner.ts
```

The tools are opt-in so the read-only tool list stays unchanged. The anti-repeat
guard also covers `browser_view`, `browser_extract`, and `browser_scroll`, so a
repeated identical read can never burn the step budget.

---

## 3. As a library

```ts
import { BrowserService } from './src/services/browser.ts';

const browser = new BrowserService();
const snap = await browser.open('https://example.com');
console.log(snap.title, snap.elements);

await browser.click(0);          // click element [0]
await browser.type(1, 'hello');  // type into element [1]
await browser.press('Enter');
await browser.scroll('down');
console.log(await browser.extract('price'));
await browser.close();
```

`BrowserSnapshot` = `{ url, title, elements, text }`, where each element is
`{ i, tag, type?, text, href? }`.

---

## 4. As an MCP server

Forreyra runs as a **Model Context Protocol** server over stdio, so any MCP client
(Claude Desktop, Cursor, VS Code, the OpenHands agent) can drive the browser with
the same look-then-act model.

```bash
npm run forreyra:mcp
```

It exposes ten tools: `browser_open`, `browser_view`, `browser_click`,
`browser_type`, `browser_press`, `browser_scroll`, `browser_extract`,
`browser_query`, `browser_screenshot` (returns a PNG image), `browser_close`.

`browser_query` takes a plain-English question and returns structured data — no
regex. It handles titles, headings, links (optionally filtered by keyword),
emails, phone numbers, prices, table rows, counts, and labelled values:

```
browser_query { "question": "what is the price" }
→ query: what is the price
  kind: prices
  matches: 2
  - $9.99
  - $19.99
```

### Client configuration

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "forreyra": {
      "command": "npx",
      "args": ["tsx", "src/mcp/forreyra-server.ts"],
      "cwd": "/absolute/path/to/Firstborn"
    }
  }
}
```

Cursor / VS Code use the same `command` + `args` + `cwd` shape.

### Verify the connection

```bash
node scripts/mcp-client-smoke.mjs
```

This uses the official MCP client SDK to connect, list the tools, open
`https://example.com`, and close.

---

## Setup

- Chromium is auto-detected at `/usr/bin/chromium`, `/usr/bin/chromium-browser`,
  or `/usr/bin/google-chrome`. To point at a specific binary, set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`.
- Installed with the repo: `npm install` (the `playwright` package).
- Headless by default. Runs with `--no-sandbox` and `--disable-dev-shm-usage` so
  it works in CI containers.

## How it behaves

- **One browser per session.** A page opened once stays open for later actions.
- **Look, then act.** Every action returns a fresh snapshot, mirroring how a
  person re-reads a page after each step.
- **Basic stealth.** A real Chrome user agent and the `navigator.webdriver` flag
  hidden at start.

## Limits

- Interactive elements are the standard clickable/typable set (`a`, `button`,
  `input`, `select`, `textarea`, `[role=button]`, `[onclick]`, `[contenteditable]`),
  capped at 120 per view.
- Page text is capped at 4000 characters per snapshot.
- No persistent profile or cookie jar across runs yet — each run starts clean.

## Tests

`tests/browser.test.ts` drives a real headless Chromium against a real local HTTP
server (no mocks) and covers open, type-then-submit, click-through navigation, and
regex extract.

```bash
npm test
```
