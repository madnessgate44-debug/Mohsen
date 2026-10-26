/**
 * Real browser service — the "our browser" capability.
 *
 * A thin, deterministic wrapper over Playwright + Chromium. It exposes the same
 * primitives a person uses: open a page, look at it, click, type, scroll, read
 * the text, and close. The agent loop drives these; it never touches Playwright
 * directly.
 *
 * Design notes:
 *  - The interactive-element list is produced in document order by a single
 *    selector, and actions address elements by their index in that list, so a
 *    `view` immediately followed by a `click(i)` targets the element the brain
 *    actually saw.
 *  - A snapshot is re-taken by `view` after every action, mirroring how a human
 *    re-reads a page after each step.
 *  - Basic stealth: a real user agent and the `webdriver` flag hidden at init.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { planQuery, runQuery, type PageData, type QueryResult } from './query.ts';

const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [onclick], [contenteditable="true"]';
const MAX_ELEMENTS = 120;
const MAX_TEXT = 4000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface BrowserElement {
  i: number;
  tag: string;
  type?: string;
  text: string;
  href?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserElement[];
  text: string;
}

/** Find a Chromium binary, preferring a bundled one then the system package. */
export function resolveChromiumPath(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p));
}

export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly executablePath?: string;

  constructor(executablePath?: string) {
    this.executablePath = resolveChromiumPath(executablePath);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({
      executablePath: this.executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  /** Navigate to a URL and return a snapshot of the resulting page. */
  async open(url: string): Promise<BrowserSnapshot> {
    const page = await this.ensurePage();
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const status = response?.status();
    const snap = await this.view();
    return status && status >= 400 ? { ...snap, text: `HTTP ${status}\n${snap.text}` } : snap;
  }

  /** Read the current page: url, title, interactive elements, visible text. */
  async view(): Promise<BrowserSnapshot> {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => '');
    const elements = await page
      .$$eval(INTERACTIVE, (els) =>
        els.slice(0, 120).map((el, i) => {
          const html = el as HTMLElement;
          const text = (
            html.innerText ||
            (html as HTMLInputElement).value ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
          return {
            i,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') ?? undefined,
            text,
            href: el.getAttribute('href') ?? undefined,
          };
        })
      )
      .catch(() => []);
    const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
    return {
      url: page.url(),
      title,
      elements: elements.slice(0, MAX_ELEMENTS),
      text: bodyText.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
    };
  }

  private locator(index: number) {
    const page = this.page;
    if (!page) throw new Error('browser not open');
    return page.locator(INTERACTIVE).nth(index);
  }

  /** Click the element at the index from the most recent `view`. */
  async click(index: number): Promise<BrowserSnapshot> {
    const target = this.locator(index);
    await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await target.click({ timeout: 10_000 });
    await this.page?.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return this.view();
  }

  /** Type into the element at the index from the most recent `view`. */
  async type(index: number, text: string): Promise<BrowserSnapshot> {
    const target = this.locator(index);
    await target.click({ timeout: 10_000 });
    await target.fill(text, { timeout: 10_000 }).catch(async () => target.type(text, { timeout: 10_000 }));
    return this.view();
  }

  /** Press a keyboard key on the focused element (e.g. Enter). */
  async press(key: string): Promise<BrowserSnapshot> {
    await this.ensurePage();
    await this.page!.keyboard.press(key);
    await this.page?.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return this.view();
  }

  /** Scroll the viewport by roughly one screen. */
  async scroll(direction: 'down' | 'up'): Promise<BrowserSnapshot> {
    await this.ensurePage();
    await this.page!.mouse.wheel(0, direction === 'up' ? -700 : 700);
    await this.page!.waitForTimeout(300);
    return this.view();
  }

  /** Extract the visible text of the page, optionally matching a regex. */
  async extract(pattern?: string): Promise<string> {
    const snap = await this.view();
    if (!pattern) return snap.text;
    try {
      const re = new RegExp(pattern, 'i');
      const lines = snap.text.split(/(?<=[.!?])\s+/).filter((s) => re.test(s));
      return lines.length ? lines.join('\n') : `No text matched /${pattern}/.`;
    } catch (err) {
      return `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Gather structured page data (headings, links, tables, labelled fields). */
  async gather(): Promise<PageData> {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => '');
    const text = ((await page.textContent('body').catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const headings = await page
      .$$eval('h1, h2, h3, h4, h5, h6', (els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
      .catch(() => []);
    const links = await page
      .$$eval('a[href]', (els) =>
        els.map((el) => ({ text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), href: (el as HTMLAnchorElement).href })).filter((l) => l.text || l.href)
      )
      .catch(() => []);
    const tables = await page
      .$$eval('table', (tables) =>
        tables.map((t) => Array.from(t.querySelectorAll('tr')).map((r) => Array.from(r.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim())))
      )
      .catch(() => []);
    const fields = await page
      .$$eval('dt, label', (els) =>
        els
          .map((el) => {
            const label = (el.textContent ?? '').replace(/\s+/g, ' ').replace(/[:*]\s*$/, '').trim();
            const next = el.nextElementSibling;
            const value = next ? (next.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
            return { label, value };
          })
          .filter((f) => f.label && f.value)
      )
      .catch(() => []);
    return { url: page.url(), title, text, headings, links, tables, fields };
  }

  /** Answer a plain-English question about the current page with structured data. */
  async query(question: string): Promise<QueryResult> {
    return runQuery(await this.gather(), planQuery(question));
  }

  async screenshot(path: string): Promise<string> {
    const page = await this.ensurePage();
    await page.screenshot({ path, fullPage: false });
    return path;
  }

  /** Capture a PNG of the viewport as bytes (for MCP image content). */
  async capture(): Promise<Buffer> {
    const page = await this.ensurePage();
    return page.screenshot({ fullPage: false });
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
