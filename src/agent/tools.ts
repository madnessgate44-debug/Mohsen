/**
 * M2 — Tools for the agent loop.
 *
 * Thin adapters over Forge's existing services (GitHubService, TestRunnerService)
 * plus a bounded local workspace. The loop kernel never knows about GitHub or npm;
 * it only calls these tools by name.
 *
 * Capability tiers:
 *  - read-only tools (list_files, read_file, search, find_files, think, fetch_url)
 *    are always available;
 *  - mutating tools (edit_file, write_file, run_check) are only registered when the
 *    permission profile permits branch writes, so the brain cannot even see a
 *    state-changing capability it is not permitted to use.
 *
 * File tools prefer the mission workspace when one exists (so edits can be made and
 * then verified), and fall back to reading the repository through GitHub.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { GitHubService } from '../services/github.ts';
import { TestRunnerService, AUTHORIZED_COMMANDS } from '../services/test-runner.ts';
import { BrowserService } from '../services/browser.ts';
import { renderQueryResult } from '../services/query.ts';
import { applyExactEdits } from './stages.ts';
import type { AgentTool, LoopContext, ToolObservation } from './loop.ts';

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

const MAX_FILE_BYTES = 200_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SCAN_FILES = 2_000;

/** Resolve a real workspace directory, or null when the loop has none. */
function workspaceDir(ws: string | undefined): string | null {
  if (!ws) return null;
  try {
    if (existsSync(ws) && statSync(ws).isDirectory()) return ws;
  } catch {
    /* ignore */
  }
  return null;
}

/** Reject paths that escape the workspace (absolute or `..` traversal). */
function safeRelative(rel: string): string | null {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  const normalized = path.normalize(rel);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return null;
  return normalized;
}

/**
 * Resolve `rel` under `ws` and confirm the result stays inside the workspace.
 * Lexical checks alone cannot catch a symlink inside the workspace that points
 * outside it, so the parent directory is resolved through the real filesystem.
 * Returns the absolute path, or null when the target escapes or cannot be
 * resolved safely.
 */
function resolveInWorkspace(ws: string, rel: string): string | null {
  const safe = safeRelative(rel);
  if (!safe) return null;
  let root: string;
  try {
    root = realpathSync(ws);
  } catch {
    return null;
  }
  const abs = path.join(root, safe);

  const inside = (real: string) => real === root || real.startsWith(root + path.sep);

  // The deepest existing ancestor is the only part that can contain a symlink;
  // realpath resolves every symlinked component along the way. Any components
  // below it do not exist yet, so they can only be plain names.
  let probe = path.dirname(abs);
  while (!existsSync(probe)) {
    const next = path.dirname(probe);
    if (next === probe) break;
    probe = next;
  }
  try {
    if (!inside(realpathSync(probe))) return null;
  } catch {
    return null;
  }

  // If the target itself already exists, it may be a symlink pointing outside.
  if (existsSync(abs)) {
    try {
      if (!inside(realpathSync(abs))) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < MAX_SCAN_FILES) {
    const rel = stack.pop() as string;
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel.split(path.sep).join('/'));
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${pattern}$`);
}

/** Common "everything" shorthands (star, double-star, double-star-slash-star) mean all files. */
function matchesAll(glob: string): boolean {
  const g = glob.trim();
  return g === '' || g === '*' || g === '**' || g === '**/*';
}

/**
 * Build the Forge toolset. Mutating tools are enabled only when `allowMutation` is
 * true; otherwise they are omitted so the brain cannot even see a state-changing
 * capability it is not permitted to use.
 */
export function buildForgeTools(options: {
  owner: string;
  repo: string;
  ref?: string;
  token?: string;
  allowMutation?: boolean;
  /** Absolute path to the mission workspace, when one exists. */
  workspace?: string;
  /** Include the real-browser tools (open/view/click/type/scroll/extract/close). */
  allowBrowser?: boolean;
}): AgentTool[] {
  const github = new GitHubService(options.token);
  const runner = new TestRunnerService();
  const ref = options.ref ?? 'main';
  const ws = workspaceDir(options.workspace);

  const readRepoFile = async (rel: string): Promise<string | null> => {
    if (ws) {
      const abs = resolveInWorkspace(ws, rel);
      if (!abs) return null;
      try {
        if (existsSync(abs) && statSync(abs).isFile()) return readFileSync(abs, 'utf8');
      } catch {
        /* fall through to GitHub */
      }
    }
    const file = await github.fetchFile(options.owner, options.repo, rel, ref);
    return file ? file.content : null;
  };

  const listPaths = async (): Promise<string[]> => {
    if (ws) return walkFiles(ws);
    return github.listRepositoryFiles(options.owner, options.repo, ref);
  };

  const tools: AgentTool[] = [
    {
      name: 'list_files',
      description: 'List repository file paths (recursive). Read-only.',
      run: async (): Promise<ToolObservation> => {
        const files = await listPaths();
        if (files.length === 0) return { ok: false, output: 'No files found.' };
        const shown = files.slice(0, 80);
        return { ok: true, output: `${files.length} files total. First ${shown.length}:\n${shown.join('\n')}` };
      },
    },
    {
      name: 'read_file',
      description: 'Read one file by exact repository path. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const rel = str(input, 'path');
        if (!rel) return { ok: false, output: 'read_file requires a "path".' };
        const content = await readRepoFile(rel);
        if (content === null) return { ok: false, output: `File not found: ${rel}` };
        return { ok: true, output: content.slice(0, MAX_FILE_BYTES) };
      },
    },
    {
      name: 'search',
      description:
        'Search file contents by regular expression (like grep). Input: {"pattern":"...", "glob":"*.ts" (optional)}. Returns matching file:line: text. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const pattern = str(input, 'pattern');
        if (!pattern) return { ok: false, output: 'search requires a "pattern" (regular expression).' };
        let re: RegExp;
        try {
          re = new RegExp(pattern, 'i');
        } catch (error) {
          return { ok: false, output: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}` };
        }
        const glob = str(input, 'glob');
        const matcher = glob && !matchesAll(glob) ? globToRegExp(glob) : null;
        const allPaths = (await listPaths()).filter((p) => (matcher ? matcher.test(p) : true));
        // Without a local workspace each file is one GitHub API call; cap to protect the rate limit.
        const paths = ws ? allPaths : allPaths.slice(0, 40);
        const matches: string[] = [];
        let scanned = 0;
        for (const rel of paths) {
          if (matches.length >= MAX_SEARCH_MATCHES || scanned >= MAX_SCAN_FILES) break;
          scanned += 1;
          const content = await readRepoFile(rel);
          if (content === null) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i += 1) {
            if (re.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
        if (matches.length === 0) return { ok: true, output: `No matches for /${pattern}/ in ${paths.length} file(s).` };
        return {
          ok: true,
          output: `${matches.length} match(es)${matches.length >= MAX_SEARCH_MATCHES ? ' (capped)' : ''}:\n${matches.join('\n')}`,
        };
      },
    },
    {
      name: 'find_files',
      description:
        'Find files by glob pattern, e.g. {"glob":"src/**/*.ts"} or {"glob":"*.json"}. Returns matching paths. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const glob = str(input, 'glob');
        if (!glob) return { ok: false, output: 'find_files requires a "glob".' };
        const matcher = matchesAll(glob) ? null : globToRegExp(glob);
        const matches = (await listPaths()).filter((p) => (matcher ? matcher.test(p) : true));
        if (matches.length === 0) return { ok: true, output: `No files match ${glob}.` };
        return { ok: true, output: `${matches.length} file(s):\n${matches.slice(0, 100).join('\n')}` };
      },
    },
    {
      name: 'think',
      description:
        'Record a reasoning step without changing anything (use to plan before acting). Input: {"thought":"..."}. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const thought = str(input, 'thought');
        if (!thought) return { ok: false, output: 'think requires a "thought".' };
        return { ok: true, output: `Noted: ${thought.slice(0, 1000)}` };
      },
    },
    {
      name: 'fetch_url',
      description:
        'Fetch the text of an http(s) URL (e.g. docs, a raw file). Input: {"url":"https://..."}. Read-only.',
      run: async (input): Promise<ToolObservation> => {
        const url = str(input, 'url');
        if (!/^https?:\/\//i.test(url)) return { ok: false, output: 'fetch_url requires an http(s) "url".' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'forge-agent' } });
          const text = await res.text();
          return { ok: res.ok, output: `HTTP ${res.status}\n${text.slice(0, 20_000)}` };
        } catch (error) {
          return { ok: false, output: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
          clearTimeout(timer);
        }
      },
    },
  ];

  if (options.allowMutation) {
    tools.push({
      name: 'edit_file',
      description:
        'Apply exact-anchor edits to a file. Each "find" must occur exactly once. Input: {"path":"...","edits":[{"find":"...","replace":"..."}]}. Mutating.',
      mutating: true,
      run: async (input, ctx: LoopContext): Promise<ToolObservation> => {
        const rel = str(input, 'path');
        const rawEdits = Array.isArray(input.edits) ? input.edits : [];
        const edits = rawEdits.filter(
          (e): e is { find: string; replace: string } =>
            Boolean(e) && typeof (e as any).find === 'string' && typeof (e as any).replace === 'string'
        );
        if (!rel || edits.length === 0) {
          return { ok: false, output: 'edit_file requires "path" and a non-empty "edits" array of {find, replace}.' };
        }
        // Reject an escaping path up front so a symlink escape reads as a refusal,
        // not as a confusing "missing file".
        const target = ws ? resolveInWorkspace(ws, rel) : null;
        if (ws && !target) return { ok: false, output: `Refusing to write outside the workspace: ${rel}` };
        const content = await readRepoFile(rel);
        if (content === null) return { ok: false, output: `Cannot edit missing file: ${rel}` };
        const result = applyExactEdits(content, edits);
        if (!result.ok) return { ok: false, output: `Edit rejected: ${result.error}` };
        if (ws) {
          const abs = target as string;
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, result.content);
          return { ok: true, output: `Applied ${edits.length} edit(s) to ${rel} in ${ctx.workspace}.` };
        }
        // No workspace: nothing can be persisted, so do not claim success.
        return { ok: false, output: 'No workspace available; edit_file cannot save changes.' };
      },
    });
    tools.push({
      name: 'write_file',
      description: 'Create a NEW file in the workspace. Input: {"path":"...","content":"..."}. Refuses to overwrite an existing file — use edit_file for that. Mutating.',
      mutating: true,
      run: async (input, ctx: LoopContext): Promise<ToolObservation> => {
        const rel = str(input, 'path');
        const content = typeof input.content === 'string' ? input.content : '';
        if (!rel) return { ok: false, output: 'write_file requires a "path".' };
        if (!ws) return { ok: false, output: 'No workspace available; cannot write files.' };
        const abs = resolveInWorkspace(ws, rel);
        if (!abs) return { ok: false, output: `Refusing to write outside the workspace: ${rel}` };
        if (existsSync(abs)) return { ok: false, output: 'File exists. Use edit_file.' };
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        return { ok: true, output: `Wrote ${content.length} byte(s) to ${rel} in ${ctx.workspace}.` };
      },
    });
    tools.push({
      name: 'run_check',
      description: `Run an authorized verification command. Allowed commands: ${Object.keys(AUTHORIZED_COMMANDS).join(
        ', '
      )}. Mutating (may install/build).`,
      mutating: true,
      run: async (input, ctx: LoopContext): Promise<ToolObservation> => {
        const command = str(input, 'command');
        if (!command) return { ok: false, output: 'run_check requires a "command".' };
        const cwd = ws ?? ctx.workspace ?? process.cwd();
        const result = await runner.runCheck(command, cwd);
        return {
          ok: result.status === 'PASSED',
          output: `exit=${result.exitCode} status=${result.status}\n${result.stdout}\n${result.stderr}`.slice(0, 4000),
        };
      },
    });
  }

  if (options.allowBrowser) {
    tools.push(...buildBrowserTools());
  }

  return tools;
}

/** Render a browser snapshot as compact text the brain can act on. */
export function renderSnapshot(snap: { url: string; title: string; elements: { i: number; tag: string; type?: string; text: string; href?: string }[]; text: string }): string {
  const lines = snap.elements.map((e) => `[${e.i}] ${e.tag}${e.type ? `(${e.type})` : ''} ${e.text}${e.href ? ` -> ${e.href}` : ''}`.trimEnd());
  return `url: ${snap.url}\ntitle: ${snap.title}\nelements:\n${lines.join('\n')}\ntext: ${snap.text}`.slice(0, 6000);
}

/**
 * Real-browser tools. A single BrowserService is shared across the toolset so a
 * page opened by `browser_open` stays open for later `browser_click`/`browser_view`
 * calls — the brain navigates the way a person would.
 */
export function buildBrowserTools(executablePath?: string): AgentTool[] {
  const browser = new BrowserService(executablePath);
  return [
    {
      name: 'browser_open',
      description:
        'Open a real web page in a browser and return its interactive elements and text. Input: {"url":"https://..."}. Use the [i] index of an element with browser_click/browser_type.',
      run: async (input): Promise<ToolObservation> => {
        const url = str(input, 'url');
        if (!url) return { ok: false, output: 'browser_open requires a "url".' };
        try {
          return { ok: true, output: renderSnapshot(await browser.open(url)) };
        } catch (err) {
          return { ok: false, output: `browser_open failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_view',
      description: 'Re-read the current page: url, title, interactive elements (with [i] indices) and visible text. Input: {}.',
      run: async (): Promise<ToolObservation> => {
        try {
          return { ok: true, output: renderSnapshot(await browser.view()) };
        } catch (err) {
          return { ok: false, output: `browser_view failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_click',
      description: 'Click the interactive element at an index from the latest view. Input: {"index":3}.',
      run: async (input): Promise<ToolObservation> => {
        const index = Number(input.index);
        if (!Number.isInteger(index) || index < 0) return { ok: false, output: 'browser_click requires an integer "index".' };
        try {
          return { ok: true, output: renderSnapshot(await browser.click(index)) };
        } catch (err) {
          return { ok: false, output: `browser_click failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into the element at an index from the latest view. Input: {"index":2,"text":"hello"}.',
      run: async (input): Promise<ToolObservation> => {
        const index = Number(input.index);
        const text = str(input, 'text');
        if (!Number.isInteger(index) || index < 0) return { ok: false, output: 'browser_type requires an integer "index".' };
        try {
          return { ok: true, output: renderSnapshot(await browser.type(index, text)) };
        } catch (err) {
          return { ok: false, output: `browser_type failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_press',
      description: 'Press a keyboard key on the focused element, e.g. {"key":"Enter"}.',
      run: async (input): Promise<ToolObservation> => {
        const key = str(input, 'key') || 'Enter';
        try {
          return { ok: true, output: renderSnapshot(await browser.press(key)) };
        } catch (err) {
          return { ok: false, output: `browser_press failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page one screen. Input: {"direction":"down"} or {"direction":"up"}.',
      run: async (input): Promise<ToolObservation> => {
        const direction = str(input, 'direction') === 'up' ? 'up' : 'down';
        try {
          return { ok: true, output: renderSnapshot(await browser.scroll(direction)) };
        } catch (err) {
          return { ok: false, output: `browser_scroll failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_extract',
      description: 'Return the visible text of the current page, optionally only sentences matching a regex. Input: {"pattern":"price"}.',
      run: async (input): Promise<ToolObservation> => {
        try {
          return { ok: true, output: await browser.extract(str(input, 'pattern') || undefined) };
        } catch (err) {
          return { ok: false, output: `browser_extract failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_query',
      description:
        'Answer a plain-English question about the current page with structured data (no regex). Input: {"question":"what is the price"}. Handles title, headings, links, emails, phones, prices, table rows, counts, labelled values.',
      run: async (input): Promise<ToolObservation> => {
        try {
          return { ok: true, output: renderQueryResult(await browser.query(str(input, 'question'))) };
        } catch (err) {
          return { ok: false, output: `browser_query failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'browser_close',
      description: 'Close the browser session and free the resources. Input: {}.',
      run: async (): Promise<ToolObservation> => {
        await browser.close();
        return { ok: true, output: 'Browser closed.' };
      },
    },
  ];
}
