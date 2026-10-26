/**
 * Forreyra MCP server.
 *
 * Exposes the Forreyra browser over the Model Context Protocol, so any MCP
 * client (Claude Desktop, Cursor, VS Code, the OpenHands agent) can drive a real
 * Chromium session with the same look-then-act model as the CLI and the agent
 * tools. Transport is stdio: the client spawns this process and talks JSON-RPC
 * over stdin/stdout.
 *
 * Run:  npm run forreyra:mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserService } from '../services/browser.ts';
import { renderSnapshot } from '../agent/tools.ts';
import { renderQueryResult } from '../services/query.ts';

const browser = new BrowserService();

const server = new McpServer({ name: 'forreyra', version: '1.0.0' });

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): Result => ({
  content: [{ type: 'text', text: `Forreyra error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

server.registerTool(
  'browser_open',
  {
    title: 'Open a URL',
    description:
      'Open a URL in a real browser and return the page title, its interactive elements (numbered [i]) and visible text. Use the [i] index with browser_click / browser_type.',
    inputSchema: { url: z.string().describe('The URL to open, e.g. https://example.com') },
  },
  async ({ url }): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.open(url)));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_view',
  {
    title: 'View the current page',
    description: 'Re-read the current page: url, title, interactive elements (with [i] indices) and visible text.',
    inputSchema: {},
  },
  async (): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.view()));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_click',
  {
    title: 'Click an element',
    description: 'Click the interactive element at an index from the latest view.',
    inputSchema: { index: z.number().int().nonnegative().describe('Element index [i] from the latest view') },
  },
  async ({ index }): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.click(index)));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_type',
  {
    title: 'Type into an element',
    description: 'Type text into the element at an index from the latest view.',
    inputSchema: {
      index: z.number().int().nonnegative().describe('Element index [i] from the latest view'),
      text: z.string().describe('The text to type'),
    },
  },
  async ({ index, text }): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.type(index, text)));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_press',
  {
    title: 'Press a key',
    description: 'Press a keyboard key on the focused element, e.g. Enter.',
    inputSchema: { key: z.string().default('Enter').describe('Key name, e.g. Enter, Tab, Escape') },
  },
  async ({ key }): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.press(key || 'Enter')));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_scroll',
  {
    title: 'Scroll the page',
    description: 'Scroll the page by one screen.',
    inputSchema: { direction: z.enum(['up', 'down']).default('down').describe('Scroll direction') },
  },
  async ({ direction }): Promise<Result> => {
    try {
      return ok(renderSnapshot(await browser.scroll(direction === 'up' ? 'up' : 'down')));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_extract',
  {
    title: 'Extract page text',
    description: 'Return the visible text of the current page, optionally only sentences matching a regular expression.',
    inputSchema: { pattern: z.string().optional().describe('Optional regex; only matching sentences are returned') },
  },
  async ({ pattern }): Promise<Result> => {
    try {
      return ok(await browser.extract(pattern || undefined));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_query',
  {
    title: 'Query the page in plain English',
    description:
      'Answer a plain-English question about the current page with structured data, without a regex. Handles titles, headings, links, emails, phone numbers, prices, table rows, counts, and labelled values. Examples: "what is the title", "list the links about docs", "how many rows are in the table", "what is the price".',
    inputSchema: { question: z.string().describe('The plain-English question, e.g. "what is the price"') },
  },
  async ({ question }): Promise<Result> => {
    try {
      return ok(renderQueryResult(await browser.query(question)));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_screenshot',
  {
    title: 'Screenshot the page',
    description: 'Capture a PNG screenshot of the current viewport and return it as an image.',
    inputSchema: {},
  },
  async () => {
    try {
      const png = await browser.capture();
      return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'browser_close',
  {
    title: 'Close the browser',
    description: 'Close the browser session and free its resources.',
    inputSchema: {},
  },
  async (): Promise<Result> => {
    await browser.close();
    return ok('Browser closed.');
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`Forreyra MCP failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
