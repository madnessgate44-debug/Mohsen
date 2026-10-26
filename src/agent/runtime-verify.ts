/**
 * Isolated runtime verification for untrusted target repositories.
 *
 * Safety contract (must hold for every call):
 * - No model API keys, no repository write tokens, no deployment credentials
 *   may be present in the process environment passed to target commands.
 * - Only explicitly allow-listed commands may run.
 * - Target is cloned/pinned to an exact commit SHA; path injection is rejected.
 * - Lifecycle scripts are disabled on install (npm ci --ignore-scripts).
 * - Timeouts and output size limits are enforced; logs are redacted.
 * - Never run npm start, deploy scripts, or any target workflow.
 *
 * This module is intentionally separate from the model-backed audit path so
 * secrets never share a process with untrusted target code.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Commands that are always allowed. Anything else is refused. */
export const ALLOWED_COMMANDS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: 'install', args: ['npm', 'ci', '--ignore-scripts'] },
  { name: 'lint', args: ['npm', 'run', 'lint', '--if-present'] },
  { name: 'test', args: ['npm', 'test', '--if-present'] },
  { name: 'build', args: ['npm', 'run', 'build', '--if-present'] },
];

export type RuntimeCheckStatus = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'BLOCKED' | 'TIMEOUT';

export interface RuntimeCheckResult {
  name: string;
  command: string;
  status: RuntimeCheckStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  reason?: string;
}

export interface RuntimeVerifyReport {
  target: string;
  commitSha: string;
  workDir: string;
  generatedAt: string;
  checks: RuntimeCheckResult[];
  overall: 'PASSED' | 'FAILED' | 'BLOCKED';
  guarantees: string[];
}

const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Strip common secret patterns from captured output. */
function redact(text: string): string {
  return text
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/gho_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']+/gi, '[REDACTED_SECRET]')
    .slice(0, MAX_OUTPUT_CHARS);
}

/** Build a minimal environment with no secrets and no write credentials. */
export function buildSafeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    PATH: base.PATH,
    HOME: base.HOME,
    TMPDIR: base.TMPDIR ?? os.tmpdir(),
    LANG: base.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
    // Explicitly prevent npm lifecycle scripts from seeing anything sensitive
    npm_config_ignore_scripts: 'true',
  };
  // Never forward known secret names
  const blocked = [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'FORGE_DELIVER_TOKEN',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'SSH_AUTH_SOCK',
  ];
  for (const key of blocked) {
    delete safe[key];
  }
  return safe;
}

export function validateTarget(target: string): { ok: true; owner: string; repo: string } | { ok: false; reason: string } {
  const trimmed = target.trim();
  if (!REPO_PATTERN.test(trimmed) || trimmed.includes('..')) {
    return { ok: false, reason: 'Target must be an explicit owner/repo with no path traversal.' };
  }
  const [owner, repo] = trimmed.split('/');
  return { ok: true, owner, repo };
}

async function runOne(
  workDir: string,
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<RuntimeCheckResult> {
  const started = Date.now();
  const command = [cmd, ...args].join(' ');
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: workDir,
      env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    });
    return {
      name,
      command,
      status: 'PASSED',
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: redact(String(stdout ?? '')),
      stderr: redact(String(stderr ?? '')),
    };
  } catch (err: any) {
    const timedOut = err?.killed === true || /ETIMEDOUT|timed out/i.test(String(err?.message ?? ''));
    const exitCode = typeof err?.code === 'number' ? err.code : null;
    return {
      name,
      command,
      status: timedOut ? 'TIMEOUT' : 'FAILED',
      exitCode,
      durationMs: Date.now() - started,
      stdout: redact(String(err?.stdout ?? '')),
      stderr: redact(String(err?.stderr ?? err?.message ?? '')),
      reason: timedOut ? `Timed out after ${timeoutMs}ms` : undefined,
    };
  }
}

/**
 * Clone the target at the given commit into a temporary directory and run the
 * allow-listed checks. Caller is responsible for cleaning up the returned
 * workDir if desired (it is under os.tmpdir()).
 */
export async function runIsolatedRuntimeVerify(options: {
  target: string;
  commitSha: string;
  /** Override allow-list for tests. */
  commands?: typeof ALLOWED_COMMANDS;
  timeoutMs?: number;
  /** Injected for tests; defaults to real git + npm. */
  exec?: typeof execFileAsync;
}): Promise<RuntimeVerifyReport> {
  const validated = validateTarget(options.target);
  if (!validated.ok) {
    return {
      target: options.target,
      commitSha: options.commitSha,
      workDir: '',
      generatedAt: new Date().toISOString(),
      checks: [{
        name: 'validate-target',
        command: '(none)',
        status: 'BLOCKED',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        reason: validated.reason,
      }],
      overall: 'BLOCKED',
      guarantees: [
        'No target code executed',
        'No secrets present in environment',
        'Target validation failed closed',
      ],
    };
  }

  const { owner, repo } = validated;
  const commit = options.commitSha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return {
      target: options.target,
      commitSha: options.commitSha,
      workDir: '',
      generatedAt: new Date().toISOString(),
      checks: [{
        name: 'validate-commit',
        command: '(none)',
        status: 'BLOCKED',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        reason: 'commitSha must be a hex SHA',
      }],
      overall: 'BLOCKED',
      guarantees: ['No target code executed', 'Commit validation failed closed'],
    };
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `forge-runtime-${owner}-${repo}-`));
  const env = buildSafeEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks: RuntimeCheckResult[] = [];

  // Shallow clone then pin to exact commit. No credentials.
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--no-tags', cloneUrl, workDir], {
      env,
      timeout: timeoutMs,
      shell: false,
    });
    // Fetch the specific commit if depth-1 missed it
    try {
      await execFileAsync('git', ['fetch', '--depth', '1', 'origin', commit], {
        cwd: workDir,
        env,
        timeout: timeoutMs,
        shell: false,
      });
    } catch {
      // depth-1 may already have it on default branch
    }
    await execFileAsync('git', ['checkout', '--force', commit], {
      cwd: workDir,
      env,
      timeout: 30_000,
      shell: false,
    });
    checks.push({
      name: 'clone-and-pin',
      command: `git clone + checkout ${commit}`,
      status: 'PASSED',
      exitCode: 0,
      durationMs: 0,
      stdout: '',
      stderr: '',
    });
  } catch (err: any) {
    checks.push({
      name: 'clone-and-pin',
      command: `git clone ${cloneUrl}`,
      status: 'BLOCKED',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: redact(String(err?.message ?? err)),
      reason: 'Could not clone or pin target commit',
    });
    return {
      target: options.target,
      commitSha: commit,
      workDir,
      generatedAt: new Date().toISOString(),
      checks,
      overall: 'BLOCKED',
      guarantees: [
        'No model keys or write tokens in environment',
        'Clone failed closed; no further commands run',
      ],
    };
  }

  const commands = options.commands ?? ALLOWED_COMMANDS;
  for (const entry of commands) {
    const [cmd, ...args] = entry.args;
    const result = await runOne(workDir, entry.name, cmd, args, env, timeoutMs);
    checks.push(result);
    // Fail-closed: if install fails, do not run subsequent checks
    if (entry.name === 'install' && result.status !== 'PASSED') {
      for (const later of commands.slice(commands.indexOf(entry) + 1)) {
        checks.push({
          name: later.name,
          command: later.args.join(' '),
          status: 'NOT_RUN',
          exitCode: null,
          durationMs: 0,
          stdout: '',
          stderr: '',
          reason: 'Skipped because install did not pass',
        });
      }
      break;
    }
  }

  const failed = checks.some((c) => c.status === 'FAILED' || c.status === 'TIMEOUT');
  const blocked = checks.some((c) => c.status === 'BLOCKED');
  const overall = blocked ? 'BLOCKED' : failed ? 'FAILED' : 'PASSED';

  return {
    target: options.target,
    commitSha: commit,
    workDir,
    generatedAt: new Date().toISOString(),
    checks,
    overall,
    guarantees: [
      'No model API keys or repository write tokens in the runtime environment',
      'Only allow-listed commands executed (install with --ignore-scripts, lint, test, build)',
      'npm start, deploy scripts, and target workflows were never invoked',
      'Output redacted and size-limited',
      `Pinned to commit ${commit}`,
    ],
  };
}
