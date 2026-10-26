/**
 * Delivery: turn an audit's findings into a real, verified change on a branch.
 *
 * This is the missing half of the company. Auditing produces findings; delivery
 * acts on them. It is the same discipline as the audit, only it writes:
 *
 *   1. clone the target at the *audited commit* (a pin, not "whatever is on main");
 *   2. run the company's implementation team inside that clone, with the target's
 *      own test/lint commands as the only authorized checks;
 *   3. refuse to continue unless there is a real, non-empty diff;
 *   4. run the target's real checks in the clone and refuse to push if any fails;
 *   5. commit, push a `forge/` branch, and open a pull request.
 *
 * It never merges, never pushes to the base branch, and never claims success it
 * cannot evidence. If any step cannot be done honestly, the run is BLOCKED.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runCompany, type WorkItem } from './company.ts';
import type { Role } from './roles.ts';
import type { LoopLimits, LoopStep } from '../kernel/loop.ts';
import { runCommand } from './runner.ts';
import type { AuditFinding } from './audit.ts';

/**
 * Shrink-guard thresholds. A partial read written back as a whole file shows up
 * as a large deletion count; these constants are what "large" means. They are
 * deliberately conservative so an honest edit never trips them.
 */
export const SHRINK_MIN_DELETIONS = 30; // a modified file must delete at least this many lines...
export const SHRINK_DELETION_RATIO = 0.3; // ...AND at least this fraction of its original lines...
export const SHRINK_ADDITION_MARGIN = 20; // ...AND more deletions than additions plus this margin.
export const TOTAL_MIN_DELETIONS = 50; // across the whole change, deletions must exceed...
export const TOTAL_DELETION_MULTIPLE = 5; // ...this multiple of total additions.

/**
 * An assertion the final diff must satisfy. This is what makes "success" mean
 * "the goal was met", not merely "it still builds".
 */
export interface DeliveryExpectation {
  /** Limit to one path, e.g. "README.md". Omit to consider every changed file. */
  file?: string;
  /** Added lines must contain this substring somewhere in the diff. */
  addedLinesContain?: string;
  /** Fail if any changed file deletes more than this many lines. */
  maxDeletions?: number;
  /** Fail if any changed file adds more than this many lines. */
  maxAdditions?: number;
  /** The diff must include at least one of these paths (the finding's files). */
  touchedAny?: string[];
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable so tests can drive a real bare repo without a network. */
export interface GitRunner {
  run(args: string[], cwd?: string): Promise<GitResult>;
}

export function realGit(): GitRunner {
  return {
    run: (args, cwd) =>
      new Promise((resolve) => {
        const child = spawn('git', args, { cwd, env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
        child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
        child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      }),
  };
}

export interface PullRequestOpener {
  (input: { target: string; head: string; base: string; title: string; body: string; token: string }): Promise<{ url: string; number: number }>;
}

export interface DeliveryOptions {
  /** owner/repo being changed. */
  target: string;
  /** What the team is asked to accomplish (usually derived from audit findings). */
  goal: string;
  /** The commit the audit looked at; the clone is pinned here. */
  commit: string;
  /** Branch to open the change against. Defaults to `main`. */
  baseBranch?: string;
  /** Destination branch. Must start with `forge/`. */
  branch: string;
  /** A real directory to clone into (created if missing). */
  workspaceDir: string;
  /** A token with `repo` scope, used for clone/push. Never logged. */
  token: string;
  /** Override the clone/push URL (tests point this at a local bare repo). */
  remoteUrl?: string;
  /** Build the roster for one attempt. Same shape as the audit's. */
  rosterFor: (item: WorkItem, attempt: number) => Role[];
  /** Decomposition. Defaults to a single work item = the goal. */
  plan?: (goal: string) => WorkItem[];
  attemptsPerItem?: number;
  maxRoleRuns?: number;
  limits?: LoopLimits;
  /** Override the target's checks. Defaults to its package.json test/lint scripts. */
  authorizedCommands?: Record<string, string>;
  /** Assertions the final diff must satisfy for the run to count as success. */
  expect?: DeliveryExpectation[];
  /** Override the shrink-guard thresholds (tests use this to force a trip). */
  thresholds?: {
    minDeletions?: number;
    deletionRatio?: number;
    additionMargin?: number;
    totalMinDeletions?: number;
    totalDeletionMultiple?: number;
  };
  /** Findings this run set out to fix (carried into the report and the PR body). */
  findings?: AuditFinding[];
  /**
   * True only when `findings` came from a real audit of this target. Governs
   * whether the report may say the target was audited. Defaults to false, so a
   * hand-typed goal is reported honestly as "not audited".
   */
  audited?: boolean;
  /** Injectable effects. */
  git?: GitRunner;
  openPr?: PullRequestOpener;
  /** Set false to build the branch and commit locally but not push (dry run). */
  push?: boolean;
}

export interface DeliveryResult {
  target: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  headCommit: string | null;
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  reason: string;
  changedFiles: string[];
  checks: { name: string; status: 'PASSED' | 'FAILED'; output: string }[];
  /** How each expectation was judged, so the report shows the goal was checked. */
  expected: { assertion: string; met: boolean; detail: string }[];
  /** Known limitations of this run that no check can cover. */
  gaps: string[];
  /** True when an audit produced the findings this run set out to fix. */
  audited: boolean;
  prUrl?: string;
  prNumber?: number;
  findings: AuditFinding[];
  markdown: string;
}

/** Read the target's own verification commands. Only what it declares is authorized. */
export function resolveAuthorizedCommands(dir: string): Record<string, string> {
  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const out: Record<string, string> = {};
    if (scripts.test) out.test = 'npm test';
    if (scripts.lint) out.lint = 'npm run lint';
    return out;
  } catch {
    return {};
  }
}

function authedUrl(target: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${target}.git`;
}

/** Redact any token that might appear in command output before it is recorded. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join('<redacted>') : text;
}

function renderDeliveryMarkdown(r: Omit<DeliveryResult, 'markdown'>): string {
  const lines = [
    `# Company Delivery: ${r.target}`,
    '',
    `- Base commit: ${r.baseCommit}`,
    `- Branch: ${r.branch}`,
    `- Head commit: ${r.headCommit ?? '(none)'}`,
    `- Status: ${r.status} — ${r.reason}`,
    '',
    '## What this set out to fix',
    ...(r.findings.length
      ? [
          `- Source: ${r.audited ? 'an audit of this target' : 'a goal supplied directly (NOT audited)'}`,
          ...r.findings.map((f) => `- ${f.severity} — ${f.title}`),
        ]
      : [r.audited ? '- Source: an audit of this target (it produced no findings)' : '- Source: a goal supplied directly (no audit was run)']),
    '',
    '## Files changed',
    ...(r.changedFiles.length ? r.changedFiles.map((f) => `- ${f}`) : ['- (none)']),
    '',
    '## Verification (the target\'s own checks)',
    ...(r.checks.length ? r.checks.map((c) => `- ${c.name}: ${c.status}`) : ['- (no checks were available to run)']),
    ...(r.expected.length
      ? [
          '',
          '## Goal assertions (what "success" required)',
          ...r.expected.map((e) => `- ${e.met ? 'MET' : 'NOT MET'} — ${e.assertion}: ${e.detail}`),
        ]
      : []),
    ...(r.gaps.length ? ['', '## Known gaps', ...r.gaps.map((g) => `- ${g}`)] : []),
    ...(r.prUrl ? ['', `## Pull request`, `- ${r.prUrl}`] : []),
    '',
    '## Guarantees',
    '- The change was committed to an isolated `forge/` branch, never to the base branch.',
    '- The pull request is opened, never merged.',
    '- The run is BLOCKED unless there was a real diff, the goal assertions were met, and every available check passed.',
  ];
  return lines.join('\n');
}

/**
 * Bind the implementer's "finish" to real evidence: it may only finish once it
 * actually mutated a file (edit_file or write_file) and the target's "test"
 * check passed *after* that mutation. A stub that merely claims completion is
 * refused, and the loop gives the role another turn instead.
 */
function withEvidenceGate(rosterFor: DeliveryOptions['rosterFor']): DeliveryOptions['rosterFor'] {
  return (item, attempt) =>
    rosterFor(item, attempt).map((role) => {
      if (role.id !== 'implementer' || role.verifyCompletion) return role;
      return {
        ...role,
        verifyCompletion: ({ history }: { history: LoopStep[] }) => {
          const mutations = history.filter((h) => (h.action.tool === 'edit_file' || h.action.tool === 'write_file') && h.observation.ok);
          if (!mutations.length) return { ok: false, reason: 'no file was actually changed yet; make the change before finishing' };
          const lastMutation = mutations[mutations.length - 1].index;
          const testAfter = history.some(
            (h) => h.action.tool === 'run_check' && h.action.input?.command === 'test' && h.observation.ok && h.index > lastMutation,
          );
          if (!testAfter) return { ok: false, reason: 'run the "test" check after your last change, then finish' };
          return { ok: true };
        },
      };
    });
}

export async function deliverChange(options: DeliveryOptions): Promise<DeliveryResult> {
  const git = options.git ?? realGit();
  const baseBranch = options.baseBranch ?? 'main';
  const push = options.push ?? true;
  const findings = options.findings ?? [];
  const expect = options.expect ?? [];
  const t = {
    minDeletions: options.thresholds?.minDeletions ?? SHRINK_MIN_DELETIONS,
    deletionRatio: options.thresholds?.deletionRatio ?? SHRINK_DELETION_RATIO,
    additionMargin: options.thresholds?.additionMargin ?? SHRINK_ADDITION_MARGIN,
    totalMinDeletions: options.thresholds?.totalMinDeletions ?? TOTAL_MIN_DELETIONS,
    totalDeletionMultiple: options.thresholds?.totalDeletionMultiple ?? TOTAL_DELETION_MULTIPLE,
  };

  const base: DeliveryResult = {
    target: options.target,
    baseBranch,
    baseCommit: options.commit,
    branch: options.branch,
    headCommit: null,
    status: 'BLOCKED',
    reason: '',
    changedFiles: [],
    checks: [],
    expected: [],
    gaps: [
      'Truncated model output cannot be detected: ModelResult exposes no finish reason or token-limit signal, so an output cut off at the token limit is treated as a complete action.',
    ],
    audited: options.audited ?? false,
    findings,
    markdown: '',
  };
  const finish = (partial: Partial<DeliveryResult>): DeliveryResult => {
    const merged = { ...base, ...partial };
    return { ...merged, markdown: renderDeliveryMarkdown(merged) };
  };

  if (!options.branch.startsWith('forge/')) {
    return finish({ reason: `refusing to use branch "${options.branch}"; delivery branches must start with "forge/"` });
  }
  if (options.branch === baseBranch) {
    return finish({ reason: `refusing to deliver to the base branch "${baseBranch}"` });
  }
  if (!options.token) {
    return finish({ reason: 'no token supplied; cannot clone, push, or open a pull request' });
  }

  // 1. Clone the target pinned at the audited commit.
  const dir = options.workspaceDir;
  const url = options.remoteUrl ?? authedUrl(options.target, options.token);
  const init = await git.run(['init', '-q', dir]);
  if (init.code !== 0) return finish({ reason: `git init failed: ${redact(init.stderr, options.token).trim()}` });
  await git.run(['remote', 'add', 'origin', url], dir);
  const fetch = await git.run(['fetch', '--depth', '1', 'origin', options.commit], dir);
  if (fetch.code !== 0) return finish({ reason: `could not fetch ${options.commit.slice(0, 8)}: ${redact(fetch.stderr, options.token).trim()}` });
  const checkout = await git.run(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
  if (checkout.code !== 0) return finish({ reason: `checkout of the audited commit failed: ${redact(checkout.stderr, options.token).trim()}` });
  await git.run(['checkout', '-q', '-b', options.branch], dir);

  // Commits need an identity; use the agent's, never the operator's.
  await git.run(['config', 'user.name', 'openhands'], dir);
  await git.run(['config', 'user.email', 'openhands@all-hands.dev'], dir);

  // 2. What checks may we run? Only the target's own.
  const authorized = options.authorizedCommands ?? resolveAuthorizedCommands(dir);
  if (!Object.keys(authorized).length) {
    return finish({ reason: 'the target declares no test or lint script, so no change can be verified; refusing to push unverified work' });
  }

  // Prepare dependencies before the team works, so QA can run the target's real
  // checks during the run. Only install when the target declares dependencies; a
  // lockfile-less install on a dependency-free target would add files to the diff.
  const checks: DeliveryResult['checks'] = [];
  const pkgPath = path.join(dir, 'package.json');
  let hasDeps = false;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0;
    } catch {
      hasDeps = false;
    }
  }
  if (hasDeps) {
    let installCmd = existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install';
    let installResult = await runCommand(installCmd, dir);
    // Some real projects have a peer-dependency conflict that only
    // `--legacy-peer-deps` resolves (Amina is one). Retry once and record which
    // command actually worked, rather than failing a target that its own team
    // can still test.
    if (installResult.status === 'FAILED' && /ERESOLVE|peer dep|Conflicting peer/i.test(installResult.output)) {
      installCmd = `${installCmd} --legacy-peer-deps`;
      installResult = await runCommand(installCmd, dir);
    }
    if (installResult.status === 'FAILED') {
      checks.push({ name: 'install', status: 'FAILED', output: redact(installResult.output, options.token).slice(0, 2000) });
      return finish({ status: 'BLOCKED', reason: `dependency install failed: ${installResult.output.split('\n')[0] ?? 'unknown'}`, checks });
    }
    checks.push({ name: installCmd === 'npm ci' || installCmd === 'npm install' ? 'install' : `install (${installCmd})`, status: 'PASSED', output: '' });
  }

  // Establish the baseline: if the target's checks already fail at the base
  // commit, a later failure cannot be attributed to the company's change, so
  // refuse up front rather than take blame (or credit) for a pre-existing break.
  for (const name of Object.keys(authorized)) {
    const base = await runCommand(authorized[name], dir);
    checks.push({ name: `baseline:${name}`, status: base.status, output: redact(base.output, options.token).slice(0, 2000) });
    if (base.status === 'FAILED') {
      return finish({ status: 'BLOCKED', reason: `the target's "${name}" check already fails at ${options.commit.slice(0, 8)}; cannot verify a change against a broken baseline`, checks });
    }
  }

  // 3. Run the implementation team inside the clone.
  const company = await runCompany({
    goal: options.goal,
    plan: options.plan ?? ((g) => [{ id: 'w1', title: g }]),
    rosterFor: withEvidenceGate(options.rosterFor),
    attemptsPerItem: options.attemptsPerItem ?? 2,
    maxRoleRuns: options.maxRoleRuns ?? 40,
    limits: options.limits,
    workspaceDir: dir,
    changes: {},
    integrate: ({ changes }) => ({
      ok: Object.keys(changes).length > 0,
      reason: Object.keys(changes).length ? `${Object.keys(changes).length} file(s) changed` : 'the team produced no change',
    }),
  });

  // 4. Refuse to continue without a real, non-empty diff against the base commit.
  //    Stage first: `git diff` ignores new files, so a change that adds a file
  //    would otherwise look empty. node_modules is excluded locally (via
  //    .git/info/exclude) so an install never leaks into the change even when the
  //    target has no .gitignore of its own.
  const excludeRel = (await git.run(['rev-parse', '--git-path', 'info/exclude'], dir)).stdout.trim();
  if (excludeRel) {
    const excludeAbs = path.isAbsolute(excludeRel) ? excludeRel : path.join(dir, excludeRel);
    try {
      const current = existsSync(excludeAbs) ? readFileSync(excludeAbs, 'utf8') : '';
      if (!/^node_modules\/?$/m.test(current)) {
        mkdirSync(path.dirname(excludeAbs), { recursive: true });
        appendFileSync(excludeAbs, `${current.endsWith('\n') || !current ? '' : '\n'}node_modules/\n`);
      }
    } catch {
      /* best effort; the commit step will surface a real failure */
    }
  }
  const add = await git.run(['add', '-A'], dir);
  if (add.code !== 0) return finish({ reason: `git add failed: ${redact(add.stderr, options.token).trim()}`, checks });
  const diff = await git.run(['diff', '--cached', '--name-only', options.commit], dir);
  const changedFiles = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!changedFiles.length) {
    return finish({ status: 'BLOCKED', reason: `no change was produced (company: ${company.reason})`, checks });
  }

  // A free model that reads a file and writes back only a fragment silently
  // deletes the rest. Tests and lint do not read a README or config, so a
  // "verified" run can still be destructive. This guard runs before the target's
  // checks and blocks any change that shrinks an existing file or the change as a
  // whole. Whole-file deletions (a clear intent) are left to the checks.
  const numstat = await git.run(['diff', '--cached', '--numstat', options.commit], dir);
  const stats: { file: string; added: number; deleted: number; originalLines: number }[] = [];
  for (const line of numstat.stdout.split('\n')) {
    const [addedRaw, deletedRaw, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file || addedRaw === '-' || deletedRaw === '-') continue;
    const abs = path.join(dir, file);
    if (!existsSync(abs)) continue; // a whole-file deletion; not a "modification"
    const original = await git.run(['show', `${options.commit}:${file}`], dir);
    const originalLines = original.code === 0 ? original.stdout.split('\n').length : 0;
    stats.push({ file, added: Number(addedRaw), deleted: Number(deletedRaw), originalLines });
  }

  const shrinkViolations: string[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const s of stats) {
    totalAdded += s.added;
    totalDeleted += s.deleted;
    if (s.deleted > s.added + t.additionMargin && s.deleted > t.deletionRatio * s.originalLines && s.deleted > t.minDeletions) {
      shrinkViolations.push(`${s.file} (+${s.added}/-${s.deleted} of ${s.originalLines} original line(s))`);
    }
  }
  const totalShrunk = totalDeleted > t.totalDeletionMultiple * totalAdded && totalDeleted > t.totalMinDeletions;
  if (shrinkViolations.length || totalShrunk) {
    const detail = shrinkViolations.length
      ? `files: ${shrinkViolations.join(', ')}`
      : `the change deletes ${totalDeleted} line(s) and adds ${totalAdded} in total`;
    checks.push({ name: 'shrink-guard', status: 'FAILED', output: detail });
    return finish({
      status: 'BLOCKED',
      reason: `refusing a change that destroys existing content (${detail}); a partial read can silently gut a file`,
      changedFiles,
      checks,
    });
  }
  checks.push({ name: 'shrink-guard', status: 'PASSED', output: `${stats.length} modified file(s); no file shrinks beyond the guard` });

  // 5. Judge the goal assertions against the real diff, before trusting the build.
  const expected: DeliveryResult['expected'] = [];
  const addedLinesFor = async (file?: string): Promise<string> => {
    const args = ['diff', '--cached', options.commit];
    if (file) args.push('--', file);
    const d = await git.run(args, dir);
    return d.stdout
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
  };
  for (const e of expect) {
    const label = [
      e.file ? `file=${e.file}` : 'any file',
      e.addedLinesContain ? `added~="${e.addedLinesContain}"` : '',
      e.maxDeletions !== undefined ? `maxDeletions=${e.maxDeletions}` : '',
      e.maxAdditions !== undefined ? `maxAdditions=${e.maxAdditions}` : '',
      e.touchedAny?.length ? `touchedAny=[${e.touchedAny.join(',')}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    let met = true;
    let detail = 'ok';
    if (e.addedLinesContain !== undefined) {
      const added = await addedLinesFor(e.file);
      met = added.includes(e.addedLinesContain);
      detail = met ? `added lines contain ${JSON.stringify(e.addedLinesContain)}` : `added lines do not contain ${JSON.stringify(e.addedLinesContain)}`;
    }
    if (met && e.maxDeletions !== undefined) {
      const considered = e.file ? stats.filter((s) => s.file === e.file) : stats;
      const worst = considered.reduce((m, s) => Math.max(m, s.deleted), 0);
      met = worst <= e.maxDeletions;
      detail = met ? `max deletions ${worst} <= ${e.maxDeletions}` : `deletes ${worst} line(s), over the allowed ${e.maxDeletions}`;
    }
    if (met && e.maxAdditions !== undefined) {
      const considered = e.file ? stats.filter((s) => s.file === e.file) : stats;
      const most = considered.reduce((m, s) => Math.max(m, s.added), 0);
      met = most <= e.maxAdditions;
      detail = met ? `max additions ${most} <= ${e.maxAdditions}` : `adds ${most} line(s), over the allowed ${e.maxAdditions}`;
    }
    if (met && e.touchedAny?.length) {
      const touched = changedFiles.filter((f) => e.touchedAny!.includes(f));
      met = touched.length > 0;
      detail = met ? `touched ${touched.join(', ')}` : `none of the finding's files were changed (${e.touchedAny.join(', ')}); a new file does not fix this`;
    }
    expected.push({ assertion: label, met, detail });
  }
  const unmet = expected.filter((e) => !e.met);
  // Carry the assertion record into every later outcome, so a run blocked by a
  // failing check still reports what it was trying to achieve and whether it did.
  base.expected = expected;
  if (unmet.length) {
    checks.push({ name: 'expect', status: 'FAILED', output: unmet.map((e) => `${e.assertion}: ${e.detail}`).join('; ') });
    return finish({
      status: 'BLOCKED',
      reason: `the change does not meet the goal assertion(s): ${unmet.map((e) => `${e.assertion} (${e.detail})`).join('; ')}`,
      changedFiles,
      checks,
      expected,
    });
  }
  if (expected.length) checks.push({ name: 'expect', status: 'PASSED', output: `${expected.length} assertion(s) met` });

  // 6. Run the target's real checks. A failing check stops delivery.
  for (const name of Object.keys(authorized)) {
    const res = await runCommand(authorized[name], dir);
    checks.push({ name, status: res.status, output: redact(res.output, options.token).slice(0, 2000) });
    if (res.status === 'FAILED') {
      return finish({ status: 'BLOCKED', reason: `check "${name}" failed; refusing to push a broken change`, changedFiles, checks });
    }
  }

  // 6. Commit and push an isolated branch.
  const message = `forge: ${options.goal}\n\nProposed by the Forge software company from an audit of ${options.target} at ${options.commit.slice(0, 8)}.\n\nCo-authored-by: openhands <openhands@all-hands.dev>`;
  const commit = await git.run(['commit', '-q', '-m', message], dir);
  if (commit.code !== 0) return finish({ reason: `git commit failed: ${redact(commit.stderr, options.token).trim()}`, changedFiles, checks });
  const head = await git.run(['rev-parse', 'HEAD'], dir);
  const headCommit = head.stdout.trim();

  if (!push) {
    return finish({ status: 'COMPLETED', reason: 'built and verified locally (push disabled)', headCommit, changedFiles, checks, expected });
  }

  const pushResult = await git.run(['push', 'origin', `HEAD:refs/heads/${options.branch}`], dir);
  if (pushResult.code !== 0) {
    return finish({ reason: `git push failed: ${redact(pushResult.stderr, options.token).trim()}`, headCommit, changedFiles, checks });
  }

  // 7. Open the pull request (never merge).
  const body = [
    options.audited
      ? `The Forge software company audited \`${options.target}\` at \`${options.commit.slice(0, 8)}\` and proposes this change to address its findings.`
      : `The Forge software company proposes this change to \`${options.target}\` at \`${options.commit.slice(0, 8)}\`. No audit was run; the goal below was supplied directly.`,
    '',
    '## What this addresses',
    ...(findings.length ? findings.map((f) => `- ${f.severity} — ${f.title}`) : ['- (no audit findings; the goal was supplied directly)']),
    '',
    '## Verification',
    ...checks.map((c) => `- ${c.name}: ${c.status}`),
    '',
    '_This pull request was opened by an AI agent (Forge / OpenHands) on behalf of the repository owner. It is not merged automatically._',
  ].join('\n');
  let pr: { url: string; number: number } | undefined;
  if (options.openPr) {
    try {
      pr = await options.openPr({ target: options.target, head: options.branch, base: baseBranch, title: `forge: ${options.goal}`, body, token: options.token });
    } catch (err) {
      return finish({ status: 'BLOCKED', reason: `branch pushed, but opening the pull request failed: ${err instanceof Error ? err.message : String(err)}`, headCommit, changedFiles, checks });
    }
  }

  return finish({ status: 'COMPLETED', reason: `pushed ${changedFiles.length} file(s) to ${options.branch}${pr ? ` and opened PR #${pr.number}` : ''}`, headCommit, changedFiles, checks, expected, prUrl: pr?.url, prNumber: pr?.number });
}
