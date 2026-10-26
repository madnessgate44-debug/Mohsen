/**
 * The company's kernel: a bounded, hardened agent loop plus a workspace-safe
 * tool registry. It is self-contained on purpose so Forge-the-company carries
 * its own engine and never depends on the Firstborn repository.
 *
 * Hardening carried over from the Firstborn review (PR #83):
 * - a per-call deadline, so a hung brain or tool cannot defeat the ceiling;
 * - an optional completion verifier, so `finish` is not automatically success;
 * - symlink-aware workspace containment for every file read and write.
 */
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export interface ToolObservation {
  ok: boolean;
  output: string;
}

export interface LoopContext {
  goal: string;
  workspace: string;
  step: number;
  deadlineMs?: number;
}

export interface AgentTool {
  name: string;
  description: string;
  mutating?: boolean;
  run(input: Record<string, unknown>, ctx: LoopContext): Promise<ToolObservation>;
}

export interface AgentAction {
  tool: string;
  input?: Record<string, unknown>;
}

export interface LoopStep {
  index: number;
  action: AgentAction;
  observation: ToolObservation;
}

export interface AgentBrainState {
  goal: string;
  history: LoopStep[];
  tools: { name: string; description: string }[];
  memory?: string;
}

export type AgentBrain = (state: AgentBrainState) => Promise<AgentAction>;

export interface LoopLimits {
  maxSteps: number;
  maxRuntimeMs: number;
  /** Ceiling (ms) for a single brain or tool call. Defaults to maxRuntimeMs. */
  maxCallMs?: number;
}

export type Authorization = (action: AgentAction, ctx: LoopContext) => { allowed: boolean; reason?: string };

export interface LoopResult {
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  steps: LoopStep[];
  reason: string;
}

export const FINISH_TOOL = 'finish';

export function loadLoopLimits(env: NodeJS.ProcessEnv = process.env): LoopLimits {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(env[name] ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    maxSteps: int('FORGE_LOOP_MAX_STEPS', 12, 1, 100),
    maxRuntimeMs: int('FORGE_LOOP_MAX_RUNTIME_MS', 10 * 60 * 1000, 10_000, 60 * 60 * 1000),
    maxCallMs: int('FORGE_LOOP_MAX_CALL_MS', 2 * 60 * 1000, 1_000, 60 * 60 * 1000),
  };
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RunLoopOptions {
  goal: string;
  tools: AgentTool[];
  brain: AgentBrain;
  limits?: LoopLimits;
  authorize?: Authorization;
  workspace?: string;
  memory?: string;
  now?: () => number;
  onStep?: (step: LoopStep) => void;
  verifyCompletion?: (state: { goal: string; summary: string; history: LoopStep[] }) => { ok: boolean; reason?: string };
}

export async function runAgentLoop(options: RunLoopOptions): Promise<LoopResult> {
  const { goal, tools, brain, authorize, workspace = 'loop', memory } = options;
  const limits = options.limits ?? loadLoopLimits();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const maxCallMs = limits.maxCallMs ?? limits.maxRuntimeMs;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const catalog = tools.map((t) => ({ name: t.name, description: t.description }));
  const steps: LoopStep[] = [];

  for (let step = 1; step <= limits.maxSteps; step += 1) {
    if (now() - startedAt > limits.maxRuntimeMs) {
      return { status: 'BLOCKED', steps, reason: `Runtime ceiling reached (${limits.maxRuntimeMs}ms); stopping safely.` };
    }
    const remaining = Math.max(1, limits.maxRuntimeMs - (now() - startedAt));
    const deadlineMs = Math.min(maxCallMs, remaining);

    let action: AgentAction;
    try {
      action = await withDeadline(brain({ goal, history: steps, tools: catalog, memory }), deadlineMs, 'Brain call');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/deadline/.test(message)) {
        return { status: 'BLOCKED', steps, reason: `Runtime ceiling reached: ${message}; stopping safely.` };
      }
      return { status: 'FAILED', steps, reason: `Brain failed: ${message}` };
    }

    if (!action || typeof action.tool !== 'string') {
      return { status: 'FAILED', steps, reason: 'Brain returned no usable action.' };
    }

    const ctx: LoopContext = { goal, workspace, step, deadlineMs };

    if (action.tool === FINISH_TOOL) {
      const summary = typeof action.input?.summary === 'string' ? action.input.summary : 'Goal reported complete.';
      const verdict = options.verifyCompletion ? options.verifyCompletion({ goal, summary, history: steps }) : { ok: true };
      if (verdict.ok) {
        steps.push({ index: step, action, observation: { ok: true, output: summary } });
        return { status: 'COMPLETED', steps, reason: summary };
      }
      const refused: LoopStep = { index: step, action, observation: { ok: false, output: `Completion refused: ${verdict.reason ?? 'acceptance criteria not met'}` } };
      steps.push(refused);
      options.onStep?.(refused);
      continue;
    }

    const tool = byName.get(action.tool);
    if (!tool) {
      const s: LoopStep = { index: step, action, observation: { ok: false, output: `Unknown tool "${action.tool}". Available: ${catalog.map((t) => t.name).join(', ')}.` } };
      steps.push(s);
      options.onStep?.(s);
      continue;
    }

    if (tool.mutating && authorize) {
      const verdict = authorize(action, ctx);
      if (!verdict.allowed) {
        const s: LoopStep = { index: step, action, observation: { ok: false, output: `Action blocked by policy: ${verdict.reason ?? 'not permitted'}` } };
        steps.push(s);
        options.onStep?.(s);
        continue;
      }
    }

    let observation: ToolObservation;
    try {
      observation = await withDeadline(tool.run(action.input ?? {}, ctx), deadlineMs, `Tool "${action.tool}"`);
    } catch (err) {
      observation = { ok: false, output: `Tool "${action.tool}" threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    const s: LoopStep = { index: step, action, observation };
    steps.push(s);
    options.onStep?.(s);
  }

  return { status: 'BLOCKED', steps, reason: `Step ceiling reached (${limits.maxSteps}); stopping safely.` };
}

// --- Workspace-safe file tools ------------------------------------------------

/** Reject paths that escape the workspace (absolute or `..` traversal). */
export function safeRelative(rel: string): string | null {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return null;
  const normalized = path.normalize(rel);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return null;
  return normalized;
}

/**
 * Resolve `rel` under `ws` and confirm the real path stays inside the workspace.
 * Lexical checks miss a symlink inside the workspace that points outside it, so
 * the target and its deepest existing ancestor are resolved through the real FS.
 */
export function resolveInWorkspace(ws: string, rel: string): string | null {
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
  if (existsSync(abs)) {
    try {
      if (!inside(realpathSync(abs))) return null;
    } catch {
      return null;
    }
  }
  return abs;
}

/**
 * A minimal, real, workspace-contained toolset every employee shares. Reads and
 * writes go through the symlink-aware resolver; `run_check` is a bounded shell
 * runner restricted to an allowlist.
 */
export interface WorkspaceToolsOptions {
  workspace: string;
  allowMutation?: boolean;
  authorizedCommands?: Record<string, string>;
  runner?: (command: string, cwd: string) => Promise<{ status: 'PASSED' | 'FAILED'; output: string }>;
}

const DEFAULT_AUTHORIZED: Record<string, string> = {
  test: 'npm test',
  lint: 'npm run lint',
};

export function buildWorkspaceTools(options: WorkspaceToolsOptions): AgentTool[] {
  const { workspace, allowMutation = false } = options;
  const authorized = options.authorizedCommands ?? DEFAULT_AUTHORIZED;

  const tools: AgentTool[] = [
    {
      name: 'read_file',
      description: 'Read a file inside the workspace. Input: {"path":"..."}. Read-only.',
      run: async (input) => {
        const rel = typeof input.path === 'string' ? input.path : '';
        const abs = resolveInWorkspace(workspace, rel);
        if (!abs) return { ok: false, output: `Refusing to read outside the workspace: ${rel}` };
        try {
          if (!existsSync(abs)) return { ok: false, output: `No such file: ${rel}` };
          return { ok: true, output: readFileSync(abs, 'utf8') };
        } catch (err) {
          return { ok: false, output: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: 'think',
      description: 'Record a reasoning step without changing anything. Input: {"thought":"..."}. Read-only.',
      run: async (input) => ({ ok: true, output: `Noted: ${typeof input.thought === 'string' ? input.thought : '(empty)'}` }),
    },
  ];

  if (allowMutation) {
    tools.push({
      name: 'write_file',
      description: 'Create a NEW file in the workspace. Input: {"path":"...","content":"..."}. Refuses to overwrite an existing file — use edit_file for that. Mutating.',
      mutating: true,
      run: async (input) => {
        const rel = typeof input.path === 'string' ? input.path : '';
        const content = typeof input.content === 'string' ? input.content : '';
        if (!rel) return { ok: false, output: 'write_file requires a "path".' };
        const abs = resolveInWorkspace(workspace, rel);
        if (!abs) return { ok: false, output: `Refusing to write outside the workspace: ${rel}` };
        if (existsSync(abs)) return { ok: false, output: `File exists. Use edit_file.` };
        try {
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content);
          return { ok: true, output: `Wrote ${content.length} byte(s) to ${rel}.` };
        } catch (err) {
          return { ok: false, output: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
    tools.push({
      name: 'edit_file',
      description: 'Replace a unique snippet in an existing file. Input: {"path":"...","old_str":"...","new_str":"..."}. Prefer this over write_file for existing files. Mutating.',
      mutating: true,
      run: async (input) => {
        const rel = typeof input.path === 'string' ? input.path : '';
        // Accept both spellings: `old_str`/`new_str` (the tool's own schema) and
        // `old_string`/`new_string`, so a model that has seen either form works.
        const oldStr = typeof input.old_str === 'string' ? input.old_str : typeof input.old_string === 'string' ? input.old_string : '';
        const newStr = typeof input.new_str === 'string' ? input.new_str : typeof input.new_string === 'string' ? input.new_string : '';
        if (!rel) return { ok: false, output: 'edit_file requires a "path".' };
        if (!oldStr) return { ok: false, output: 'edit_file requires a non-empty "old_str".' };
        const abs = resolveInWorkspace(workspace, rel);
        if (!abs) return { ok: false, output: `Refusing to edit outside the workspace: ${rel}` };
        try {
          if (!existsSync(abs)) return { ok: false, output: `No such file: ${rel} (use write_file to create a new file)` };
          const current = readFileSync(abs, 'utf8');
          const first = current.indexOf(oldStr);
          if (first === -1) return { ok: false, output: `old_str not found in ${rel}. Read the file and copy the exact text.` };
          if (current.indexOf(oldStr, first + oldStr.length) !== -1) return { ok: false, output: `old_str is not unique in ${rel}; include more surrounding context.` };
          const updated = current.slice(0, first) + newStr + current.slice(first + oldStr.length);
          writeFileSync(abs, updated);
          const count = (s: string) => (s.match(/\n/g)?.length ?? 0) + (s.endsWith('\n') ? 0 : 1);
          const removed = count(oldStr);
          const added = count(newStr);
          return { ok: true, output: `Edited ${rel}: -${removed} line(s), +${added} line(s).` };
        } catch (err) {
          return { ok: false, output: `Edit failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
    tools.push({
      name: 'run_check',
      description: `Run an authorized verification command (${Object.keys(authorized).join(', ')}). Mutating.`,
      mutating: true,
      run: async (input) => {
        const command = typeof input.command === 'string' ? input.command : '';
        if (!(command in authorized)) return { ok: false, output: `Command "${command}" is not authorized. Allowed: ${Object.keys(authorized).join(', ')}.` };
        if (!options.runner) return { ok: false, output: 'No runner configured.' };
        const result = await options.runner(authorized[command], workspace);
        return { ok: result.status === 'PASSED', output: `[${command}] ${result.status}: ${result.output}` };
      },
    });
  }

  return tools;
}
