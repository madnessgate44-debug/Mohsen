/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskDefinition, TaskExecutionReport, FileChangePlan, RequirementEvidenceInput } from '../types/agent.ts';
import { GitHubService } from '../services/github.ts';
import { ModelService, isKeylessOnly } from '../services/model.ts';
import { TestRunnerService } from '../services/test-runner.ts';
import { loadForgeLimits } from './limits.ts';
import { evaluatePermissionPolicy, loadPermissionConfig } from './policy.ts';
import { traceEntry } from './mission-trace.ts';
import { diagnoseMission } from './diagnosis.ts';
import { applyExactEdits } from './stages.ts';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Sensitive / Protected repository paths that Forge is prohibited from altering
const PROTECTED_PATH_PATTERNS = [
  /^\.git\//i,
  /^\.env/i,
  /^\.github\//i,
  /^node_modules\//i,
  // Files executed by target checks must not be model-editable.
  /(^|\/)package(-lock)?\.json$/i,
  /(^|\/)npm-shrinkwrap\.json$/i,
  /(^|\/)\.npmrc$/i,
  /^vite\.config\.[cm]?[jt]s$/i,
  /^tsconfig[^/]*\.json$/i,
  /^scripts\//i,
];

// Keep the total source context bounded for anonymous models with small context windows.
const MAX_SOURCE_CONTEXT_CHARS = 24000;

// Preserved legacy projects and source-only workflow copies are archival evidence,
// not the active target application's code. Exclude them from inferred model context
// so a task does not fill the prompt with unrelated legacy files.
const CONTEXT_EXCLUDED_PREFIXES = ['legacy-mohsen/', 'replica-source/', '.firstborn/'];

export function isContextExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, '');
  return CONTEXT_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// Anonymous models sometimes wrap otherwise valid JSON in Markdown fences.
// Normalize only that wrapper; JSON.parse remains the strict structural validator.
function parseModelJson(text: string): any {
  let normalized = text.trim();
  if (normalized.startsWith('```')) {
    const firstLineEnd = normalized.indexOf('\n');
    if (firstLineEnd >= 0) normalized = normalized.slice(firstLineEnd + 1);
    const trimmedEnd = normalized.trimEnd();
    if (trimmedEnd.endsWith('```')) normalized = trimmedEnd.slice(0, -3);
    normalized = normalized.trim();
  }
  return JSON.parse(normalized);
}

// --- R6 resilience primitives -------------------------------------------------

export type FailureClass = 'RETRYABLE' | 'FATAL';

/**
 * Classify a runtime failure so callers can retry transient conditions and stop
 * on permanent ones. Deterministic and pure so it is unit-testable.
 */
export function classifyFailure(error: unknown): FailureClass {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const status = (error as { status?: number })?.status;
  if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return 'RETRYABLE';
  if (/abort|timeout|timed out|econnreset|enotfound|socket hang up|fetch failed|rate limit|429|5\d\d/.test(message)) {
    return 'RETRYABLE';
  }
  return 'FATAL';
}

export interface BoundedRetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected sleep so tests never wait on wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Run an async operation with bounded retries and exponential backoff. Never
 * loops unbounded, never retries a fatal classification, and reports the exact
 * number of attempts so the caller can log truthful evidence.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: BoundedRetryOptions
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryable = options.isRetryable ?? ((error: unknown) => classifyFailure(error) === 'RETRYABLE');

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: await operation(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryable(error)) {
        return { ok: false, error, attempts: attempt };
      }
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError, attempts };
}

export interface ModelPlanShapeCheck {
  ok: boolean;
  error?: string;
  requirements: { id: string; description: string; acceptanceCriteria: string; checkCommands?: string[]; manualReviewNote?: string }[];
  changes: FileChangePlan[];
}

/**
 * Deterministically validate and normalize a raw model plan. Malformed shapes
 * are reported as structured errors instead of throwing deep in the mapper, so
 * a single bad field cannot silently corrupt the report.
 */
export function validateModelPlanShape(raw: unknown): ModelPlanShapeCheck {
  const empty: ModelPlanShapeCheck = { ok: true, requirements: [], changes: [] };
  if (!raw || typeof raw !== 'object') {
    return { ...empty, ok: false, error: 'Model plan was not a JSON object.' };
  }
  const plan = raw as Record<string, unknown>;

  if (plan.requirements !== undefined && !Array.isArray(plan.requirements)) {
    return { ...empty, ok: false, error: 'Model plan "requirements" must be an array when present.' };
  }
  if (plan.changes !== undefined && !Array.isArray(plan.changes)) {
    return { ...empty, ok: false, error: 'Model plan "changes" must be an array when present.' };
  }

  const requirements = (plan.requirements ?? []).map((req, index) => {
    const item = (req ?? {}) as Record<string, unknown>;
    return {
      id: typeof item.id === 'string' && item.id ? item.id : `REQ-${index + 1}`,
      description: typeof item.description === 'string' ? item.description : '',
      acceptanceCriteria: typeof item.acceptanceCriteria === 'string' ? item.acceptanceCriteria : '',
      checkCommands: Array.isArray(item.checkCommands)
        ? item.checkCommands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : undefined,
      manualReviewNote: typeof item.manualReviewNote === 'string' ? item.manualReviewNote : undefined,
    };
  });

  const changes: FileChangePlan[] = [];
  for (const change of (plan.changes ?? []) as unknown[]) {
    const item = (change ?? {}) as Record<string, unknown>;
    if (typeof item.path !== 'string' || item.path.length === 0) {
      return { ...empty, ok: false, error: 'A change is missing a "path".' };
    }
    if (!['create', 'modify', 'delete'].includes(String(item.action))) {
      return { ...empty, ok: false, error: `Change "${item.path}" has an invalid action "${String(item.action)}".` };
    }
    if (item.edits !== undefined && !Array.isArray(item.edits)) {
      return { ...empty, ok: false, error: `Change "${item.path}" has non-array edits.` };
    }
    changes.push({
      path: item.path,
      action: item.action as FileChangePlan['action'],
      rationale: typeof item.rationale === 'string' ? item.rationale : '',
      content: typeof item.content === 'string' ? item.content : undefined,
      edits: Array.isArray(item.edits)
        ? (item.edits as { find: string; replace: string }[])
        : undefined,
    });
  }

  return { ok: true, requirements, changes };
}

// Requested branch wins only when it is explicit and not the default; invalid
// branches are resolved later (and fail closed) by the caller.
export function resolveTargetBranch(requested: string | undefined, defaultBranch: string): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== defaultBranch ? trimmed : defaultBranch;
}

// Extract repo file paths the task names explicitly. Root-level files (README.md,
// package.json, ...) count, not just src/docs/scripts/.github — otherwise a task
// like "modify README.md" loses its authoritative target and the model edits blind.
const EXPLICIT_PATH_RE = /(?<![\w./-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml))(?![\w/-])/g;

export function extractExplicitPaths(taskText: string, repoFilePaths: string[]): string[] {
  const repoSet = new Set(repoFilePaths);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of taskText.matchAll(EXPLICIT_PATH_RE)) {
    const candidate = match[1];
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (repoSet.has(candidate)) out.push(candidate);
  }
  return out;
}

// Exhaustion run: weak free models copied the harness's own context separator
// and used it as an edit anchor, which can never match real file content.
const HARNESS_SEPARATOR_ANCHOR_RE = /--- END FILE ---|<<<FORGE_(END_)?CONTEXT_FILE/;

export function isHarnessSeparatorAnchor(find: string): boolean {
  return HARNESS_SEPARATOR_ANCHOR_RE.test(find);
}

// A requirement is only PASS when a check named in its own acceptance criteria,
// description, or explicit checkCommands actually passed. Unrelated green checks
// cannot satisfy it, and a named-but-failing check yields FAIL, never PASS.
export function evaluateRequirementEvidence(
  requirement: RequirementEvidenceInput,
  results: { command: string; status: string; exitCode: number }[]
): { status: 'PASS' | 'PENDING' | 'FAIL'; evidence: string } {
  const attemptEvidence = results.map((result) => `${result.command}=${result.exitCode}`).join(', ');
  const criterion = `${requirement.acceptanceCriteria ?? ''} ${requirement.description ?? ''}`.toLowerCase();

  // Only a literal full command mention is criterion evidence. Matching a bare
  // script name (for example, "test" or "lint") creates false PASS results when
  // those words appear in ordinary prose unrelated to the verification method.
  const matchesCommand = (command: string): boolean => criterion.includes(command.toLowerCase());

  const explicit = (requirement.checkCommands ?? []).map((c) => c.toLowerCase());
  const referencedChecks = results.filter((result) => {
    const lower = result.command.toLowerCase();
    return explicit.includes(lower) || matchesCommand(result.command);
  });

  const failed = referencedChecks.filter((result) => result.status !== 'PASSED');
  if (failed.length > 0) {
    return {
      status: 'FAIL',
      evidence: `Criterion-named check failed: ${failed.map((result) => `${result.command}=${result.exitCode}`).join(', ')}.`,
    };
  }
  if (referencedChecks.length > 0) {
    return {
      status: 'PASS',
      evidence: `Criterion-matched checks passed: ${referencedChecks.map((result) => `${result.command}=${result.exitCode}`).join(', ')}.`,
    };
  }
  const manual = requirement.manualReviewNote ? ` Manual review: ${requirement.manualReviewNote}.` : ' Manual review required.';
  return {
    status: 'PENDING',
    evidence: `No criterion-specific passing check was identified. Latest target-check attempt: ${attemptEvidence}.${manual}`,
  };
}

export class ForgeAgent {
  private github: GitHubService;
  private model: ModelService;
  private testRunner: TestRunnerService;
  private githubToken?: string;

  constructor(githubToken?: string) {
    this.githubToken = githubToken?.trim();
    this.github = new GitHubService(githubToken);
    this.model = new ModelService();
    this.testRunner = new TestRunnerService();
  }

  /**
   * Strict validation of generated patch paths and contents (Fixes AUD-20261012-02 Patch Validation)
   */
  private validatePatch(changes: FileChangePlan[]): { valid: boolean; error?: string } {
    const limits = loadForgeLimits();
    if (!Array.isArray(changes) || changes.length === 0) {
      return { valid: false, error: 'Empty patch: No file changes proposed.' };
    }
    if (changes.length > limits.maxFilesPerMission) {
      return { valid: false, error: `Patch exceeds the configured file ceiling: ${changes.length} > ${limits.maxFilesPerMission}.` };
    }
    const totalEdits = changes.reduce((sum, change) => sum + (Array.isArray(change.edits) ? change.edits.length : 0), 0);
    if (totalEdits > limits.maxEditsPerMission) {
      return { valid: false, error: `Patch exceeds the configured edit ceiling: ${totalEdits} > ${limits.maxEditsPerMission}.` };
    }

    for (const change of changes) {
      // 1. Path format validation (must be relative, no traversal)
      if (!change.path || typeof change.path !== 'string') {
        return { valid: false, error: 'Malformed patch: Missing or non-string file path.' };
      }
      const portablePath = change.path.replace(/\\/g, '/');
      const normalizedPath = path.posix.normalize(portablePath).replace(/^(\.\/)+/, '');
      if (path.isAbsolute(change.path) || portablePath.startsWith('/') || normalizedPath === '..' || normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
        return { valid: false, error: `Security Boundary Violation: Directory traversal or absolute path detected: "${change.path}".` };
      }

      // 2. Protected files check
      if (PROTECTED_PATH_PATTERNS.some((pat) => pat.test(normalizedPath))) {
        return { valid: false, error: `Security Boundary Violation: Modification of protected file or path is forbidden: "${change.path}".` };
      }
      change.path = normalizedPath; // commit exactly the path that was tested

      // 3. Action and content check
      if (!['modify', 'create'].includes(change.action)) {
        return { valid: false, error: `Unsupported or dangerous patch action "${change.action}". Only create and modify are supported.` };
      }
      const hasContent = typeof change.content === 'string' && change.content.length > 0;
      const hasEdits = Array.isArray(change.edits) && change.edits.length > 0
        && change.edits.every((edit) => edit && typeof edit.find === 'string' && edit.find.length > 0 && typeof edit.replace === 'string');
      if ((change.action === 'create' && !hasContent) || (change.action === 'modify' && !hasContent && !hasEdits)) {
        return { valid: false, error: `Invalid patch: "${change.path}" needs complete content for create or valid exact edits for modify.` };
      }
      const patchSize = hasContent ? Buffer.byteLength(change.content as string, 'utf-8') : Buffer.byteLength(JSON.stringify(change.edits ?? []), 'utf-8');
      if (patchSize > loadForgeLimits().maxPatchBytes) {
        return { valid: false, error: `Patch size limit exceeded: "${change.path}" exceeds the configured per-file patch limit.` };
      }
    }

    return { valid: true };
  }

  private findEditAnchorProblems(
    changes: FileChangePlan[],
    contextFiles: { path: string; content: string }[]
  ): string[] {
    const sourceByPath = new Map(contextFiles.map((file) => [file.path, file.content]));
    const problems: string[] = [];

    for (const change of changes) {
      if (change.action !== 'modify' || !Array.isArray(change.edits) || change.edits.length === 0) continue;
      const source = sourceByPath.get(change.path);
      if (typeof source !== 'string') {
        problems.push(`${change.path}: source content was not supplied to validate the edit anchors.`);
        continue;
      }
      // Exhaustion run: weak free models copy the harness's own context separator
      // and use it as a "find" anchor, which can never match. Name it precisely so
      // the bounded repair can redirect them instead of looping on a vague failure.
      const markerAnchor = change.edits.find((edit) => isHarnessSeparatorAnchor(String(edit?.find ?? '')));
      if (markerAnchor) {
        problems.push(`${change.path}: edit anchor is a harness context separator, not file content: ${JSON.stringify(String(markerAnchor.find).slice(0, 60))}`);
        continue;
      }
      const result = applyExactEdits(source, change.edits);
      if (!result.ok) problems.push(`${change.path}: ${result.error}`);
    }
    return problems;
  }


  private async applyChangesToWorktree(worktree: string, changes: FileChangePlan[]): Promise<void> {
    for (const change of changes) {
      const portablePath = change.path.replace(/\\/g, '/');
      const normalizedPath = path.posix.normalize(portablePath).replace(/^(\.\/)+/, '');
      const absolutePath = path.resolve(worktree, normalizedPath);
      if (!absolutePath.startsWith(worktree + path.sep)) {
        throw new Error(`Patch path escaped the isolated worktree: ${change.path}`);
      }
      const worktreeRealPath = await fs.realpath(worktree);
      const relativeParent = path.relative(worktree, path.dirname(absolutePath));
      let checkedParent = worktreeRealPath;
      for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
        checkedParent = path.join(checkedParent, segment);
        let parentStat;
        try { parentStat = await fs.lstat(checkedParent); } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
        if (parentStat?.isSymbolicLink()) {
          throw new Error(`BLOCKED: patch target parent contains a symlink: ${change.path}`);
        }
        if (!parentStat) {
          await fs.mkdir(checkedParent);
          parentStat = await fs.lstat(checkedParent);
        }
        const resolvedParent = await fs.realpath(checkedParent);
        if (resolvedParent !== worktreeRealPath && !resolvedParent.startsWith(worktreeRealPath + path.sep)) {
          throw new Error(`BLOCKED: patch target parent resolves outside the worktree: ${change.path}`);
        }
      }
      const parentRealPath = await fs.realpath(path.dirname(absolutePath));
      if (parentRealPath !== worktreeRealPath && !parentRealPath.startsWith(worktreeRealPath + path.sep)) {
        throw new Error(`BLOCKED: patch target parent resolves outside the worktree: ${change.path}`);
      }
      let targetStat;
      try { targetStat = await fs.lstat(absolutePath); } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (targetStat?.isSymbolicLink()) throw new Error(`BLOCKED: refusing to patch symlink: ${change.path}`);
      if (targetStat) {
        const targetRealPath = await fs.realpath(absolutePath);
        if (targetRealPath !== worktreeRealPath && !targetRealPath.startsWith(worktreeRealPath + path.sep)) {
          throw new Error(`BLOCKED: patch target resolves outside the worktree: ${change.path}`);
        }
      }
      const exists = Boolean(targetStat);
      if (change.action === 'create' && exists) throw new Error(`Patch marked existing file as create: ${change.path}`);
      if (change.action === 'modify' && !exists) throw new Error(`Patch marked missing file as modify: ${change.path}`);
      if (change.action === 'modify' && Array.isArray(change.edits) && change.edits.length > 0) {
        const current = await fs.readFile(absolutePath, 'utf-8');
        const applied = applyExactEdits(current, change.edits);
        if (!applied.ok) throw new Error(`Exact edit rejected in ${change.path}: ${applied.error}`);
        await fs.writeFile(absolutePath, applied.content, 'utf-8');
        // The GitHub commit API receives the verified full file from the tested worktree.
        change.content = applied.content;
      } else {
        await fs.writeFile(absolutePath, change.content as string, 'utf-8');
      }
    }
  }

  async executeTask(task: TaskDefinition): Promise<TaskExecutionReport> {
    const report: TaskExecutionReport = {
      taskId: task.id,
      status: 'QUEUED',
      startTime: new Date().toISOString(),
      baseCommitSha: 'UNKNOWN',
      modelInvoked: {
        provider: isKeylessOnly() ? 'keyless router (not yet selected)' : 'not selected',
        model: 'not-selected',
        callsCount: 0,
        fallbackUsed: false,
        keylessRouteErrors: [],
      },
      requirements: [],
      plannedChanges: [],
      testResults: [],
      trace: [],
      logs: [],
    };

    const log = (level: 'info' | 'warn' | 'error', message: string) => {
      report.logs.push({ timestamp: new Date().toISOString(), level, message });
    };

    // M3: record each mission stage transition once. Deterministic, derived data.
    const traced = new Set<string>();
    const trace = (
      stage: import('./mission-trace.ts').MissionStageName,
      status: import('./mission-trace.ts').MissionStageStatus,
      detail?: string,
    ) => {
      const key = `${stage}:${status}`;
      if (traced.has(key)) return;
      traced.add(key);
      report.trace!.push(traceEntry(stage, status, 1, detail));
    };

    // M4: stamp the end time and, for any non-success outcome, a structured
    // root-cause diagnosis. Derived data only; it never alters mission control.
    const finalize = (): TaskExecutionReport => {
      report.endTime ||= new Date().toISOString();
      if (report.status !== 'PR_OPENED' && !report.diagnosis) {
        report.diagnosis = diagnoseMission({
          status: report.status,
          errorMessage: report.errorMessage,
          blockerReason: report.blockerReason,
          trace: report.trace,
          testResults: report.testResults,
          keylessRouteErrors: report.modelInvoked.keylessRouteErrors,
        });
        log('warn', `Diagnosis: ${report.diagnosis.category} — ${report.diagnosis.summary}`);
      }
      return report;
    };

    try {
      // 1. VALIDATING
      report.status = 'VALIDATING';
      log('info', `Validating task definition: ${task.id} (${task.title})`);

      if (!task.title || !task.description) {
        report.status = 'FAILED';
        report.errorMessage = 'Validation Failed: Task title and description cannot be empty.';
        log('error', report.errorMessage);
        return finalize();
      }

      const [owner, repo] = task.targetRepo.split('/');
      if (!owner || !repo) {
        report.status = 'FAILED';
        report.errorMessage = `Validation Failed: Invalid target repository format "${task.targetRepo}". Expected "owner/repo".`;
        log('error', report.errorMessage);
        return finalize();
      }

      // 2. INSPECTING
      report.status = 'INSPECTING';
      log('info', `Inspecting target repository: ${task.targetRepo}`);
      const repoInfo = await this.github.inspectRepository(owner, repo);

      if (!repoInfo.exists) {
        report.status = 'BLOCKED';
        report.blockerReason = `Repository inspection failed: ${repoInfo.errorMessage || 'Repository does not exist'}`;
        log('warn', report.blockerReason);
        return finalize();
      }

      const workflowRepository = (process.env.GITHUB_REPOSITORY ?? '').trim().toLowerCase();
      const targetRepository = task.targetRepo.trim().toLowerCase();
      if (workflowRepository && targetRepository !== workflowRepository && repoInfo.permissions?.push !== true) {
        report.status = 'BLOCKED';
        report.blockerReason = `Cross-repository write permission is not verified for ${task.targetRepo}; no branch or PR was created.`;
        log('warn', report.blockerReason);
        return finalize();
      }

      report.baseCommitSha = repoInfo.latestCommitSha;
      trace('INSPECT', 'PASSED', `base ${report.baseCommitSha}`);
      log('info', `Target repository verified. Base branch: ${repoInfo.defaultBranch}, Base SHA: ${report.baseCommitSha}`);

      // Honor an explicitly requested target branch; fall back to the repository default.
      const targetBranch = resolveTargetBranch(task.targetBranch, repoInfo.defaultBranch);
      if (targetBranch !== repoInfo.defaultBranch) {
        const branchSha = await this.github.fetchBranchHeadSha(owner, repo, targetBranch);
        if (!branchSha) {
          report.status = 'BLOCKED';
          report.blockerReason = `Requested target branch "${targetBranch}" could not be resolved in ${owner}/${repo}.`;
          log('warn', report.blockerReason);
          return finalize();
        }
        report.baseCommitSha = branchSha;
        log('info', `Using explicitly requested target branch "${targetBranch}" at SHA ${branchSha}.`);
      }

      // 3. READING PERSISTENT INSTRUCTIONS & TARGET CODE SCOPE
      log('info', 'Checking for persistent instructions in AGENTS.md');
      const agentsMdRemote = await this.github.fetchFile(owner, repo, 'AGENTS.md', targetBranch);
      let instructionText = '';
      if (agentsMdRemote) {
        instructionText = agentsMdRemote.content;
        log('info', 'Loaded remote AGENTS.md instructions.');
      } else {
        try {
          instructionText = await fs.readFile(path.resolve(process.cwd(), 'AGENTS.md'), 'utf-8');
          log('info', 'Loaded local AGENTS.md instructions.');
        } catch {
          instructionText = 'Standard engineering instructions: inspect before editing, keep changes minimal.';
        }
      }

      // Read target repository file inventory
      log('info', 'Gathering repository file inventory for grounding');
      const repoFilePaths = await this.github.listRepositoryFiles(owner, repo, targetBranch);
      log('info', `Found ${repoFilePaths.length} files in target repository tree.`);

      // Read the target repository's package manifest and bounded real source files.
      const packageJsonRemote = await this.github.fetchFile(owner, repo, 'package.json', targetBranch);
      const packageJsonContent = packageJsonRemote?.content || '{}';
      const taskText = `${task.title} ${task.description}`;
      const taskTerms = taskText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2);
      const explicitPaths = extractExplicitPaths(taskText, repoFilePaths);
      const eligibleSourcePaths = repoFilePaths
        .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(p))
        .filter((p) => !p.startsWith('node_modules/') && !p.startsWith('dist/') && !p.startsWith('.git/') && !isContextExcludedPath(p))
        .filter((p) => p !== 'package.json' && p !== 'AGENTS.md');
      // Exact user-named paths are authoritative. For inferred context, skip oversized files
      // and continue searching so an unrelated large file cannot block the whole mission.
      const sourceCandidates = (explicitPaths.length > 0 ? explicitPaths.slice(0, 5) : eligibleSourcePaths
        .sort((a, b) => {
          const score = (candidate: string) => {
            const lower = candidate.toLowerCase();
            return taskTerms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
          };
          return score(b) - score(a) || a.localeCompare(b);
        }));
      const targetSourceFiles: { path: string; content: string }[] = [];
      for (const candidate of sourceCandidates) {
        if (targetSourceFiles.length >= 5) break;
        const file = await this.github.fetchFile(owner, repo, candidate, targetBranch);
        if (!file) {
          log('warn', `Could not fetch candidate source file; skipping: ${candidate}`);
          continue;
        }
        if (file.content.length > 16000) {
          const reason = `source file exceeds 16000 characters: ${file.path}`;
          if (explicitPaths.length > 0) {
            report.status = 'BLOCKED';
            report.blockerReason = `Explicitly requested ${reason}; refusing to guess or patch an incomplete context.`;
            log('warn', report.blockerReason);
            return finalize();
          }
          log('warn', `Skipping inferred ${reason} and continuing source selection.`);
          continue;
        }
        const contextChars = targetSourceFiles.reduce((total, source) => total + source.content.length, 0);
        if (contextChars + file.content.length > MAX_SOURCE_CONTEXT_CHARS) {
          const reason = `adding ${file.path} would exceed the ${MAX_SOURCE_CONTEXT_CHARS}-character total source-context budget`;
          if (explicitPaths.length > 0) {
            report.status = 'BLOCKED';
            report.blockerReason = `Explicit source context is too large: ${reason}.`;
            log('warn', report.blockerReason);
            return finalize();
          }
          log('warn', `Skipping inferred source file because ${reason}.`);
          continue;
        }
        targetSourceFiles.push({ path: file.path, content: file.content });
      }
      if (targetSourceFiles.length === 0) {
        report.status = 'BLOCKED';
        report.blockerReason = explicitPaths.length > 0
          ? 'None of the explicitly requested source files could be safely loaded.'
          : 'No eligible source files under the 16000-character context limit could be loaded.';
        log('warn', report.blockerReason);
        return finalize();
      }

      // 4. PLANNING (MODEL INVOCATION)
      report.status = 'PLANNING';
      log('info', `Invoking model with target manifest and ${targetSourceFiles.length} actual target source files.`);

      const contextFiles = [
        { path: 'AGENTS.md', content: instructionText },
        { path: 'package.json', content: packageJsonContent },
        { path: 'FILE_TREE_INVENTORY.txt', content: repoFilePaths.filter((p) => !isContextExcludedPath(p)).slice(0, 100).join('\n') },
        ...targetSourceFiles,
      ];

      report.modelInvoked.callsCount += 1;
      let modelResult = await this.model.generatePlanAndPatch(
        `Task: ${task.title}\nDetails: ${task.description}`,
        contextFiles
      );
      // R6: retry transient anonymous-route failures with bounded backoff; a
      // fatal failure is never retried. The single bounded retry keeps total
      // model calls within the configured ceiling.
      if (!modelResult.success && classifyFailure(modelResult.error) === 'RETRYABLE') {
        log('warn', `Model route reported a retryable failure; one bounded retry. Detail: ${modelResult.error}`);
        const retry = await withBoundedRetry(
          () => this.model.generatePlanAndPatch(`Task: ${task.title}\nDetails: ${task.description}`, contextFiles),
          { attempts: loadForgeLimits().modelAttempts, baseDelayMs: 500 }
        );
        report.modelInvoked.callsCount += retry.attempts;
        if (retry.ok) modelResult = retry.value;
      }

      report.modelInvoked.provider = modelResult.provider;
      report.modelInvoked.model = modelResult.model;
      report.modelInvoked.fallbackUsed = modelResult.fallbackUsed ?? false;
      report.modelInvoked.keylessRouteErrors = [
          ...(report.modelInvoked.keylessRouteErrors ?? []),
          ...(modelResult.keylessRouteErrors ?? []),
        ];
      if (!modelResult.success) {
        report.status = 'FAILED';
        report.errorMessage = `Model Generation Failed: ${modelResult.error}`;
        log('error', report.errorMessage);
        return finalize();
      }

      const applyPlanToReport = (parsedPlan: any) => {
        // R6: validate shape deterministically so a malformed field cannot
        // silently corrupt the report.
        const shape = validateModelPlanShape(parsedPlan);
        if (!shape.ok) throw new Error(`Model plan shape rejected: ${shape.error}`);
        report.requirements = shape.requirements.map((req) => ({ ...req, status: 'PENDING' as const }));
        report.plannedChanges = shape.changes;
        trace('PLAN', 'PASSED', `${shape.requirements.length} requirements, ${shape.changes.length} file changes`);
      };

      const maxModelCalls = loadForgeLimits().maxModelCalls;
      const guardModelCall = (label: string): boolean => {
        if (Date.now() - Date.parse(report.startTime) > loadForgeLimits().maxRuntimeMs) {
          report.status = 'BLOCKED';
          report.blockerReason = `Mission runtime ceiling reached; stopping safely before ${label}.`;
          log('warn', report.blockerReason);
          return false;
        }
        if (report.modelInvoked.callsCount >= maxModelCalls) {
          report.status = 'BLOCKED';
          report.blockerReason = `Model-call ceiling reached (${maxModelCalls}); stopping safely before ${label}.`;
          log('warn', report.blockerReason);
          return false;
        }
        return true;
      };

      let parsedPlan: any;
      try {
        parsedPlan = parseModelJson(modelResult.text);
      } catch (err: any) {
        if (!guardModelCall('JSON repair attempt')) return finalize();
        log('warn', `Model output was not valid JSON; requesting one compact-format retry: ${err.message}`);
        report.modelInvoked.callsCount += 1;
        modelResult = await this.model.generatePlanAndPatch(
          `${task.title}\nDetails: ${task.description}\n\nOUTPUT REPAIR REQUIRED. The previous response was invalid or truncated JSON (${String(err.message).slice(0, 240)}). Return a much smaller valid JSON plan. Existing files MUST use compact exact-anchor edits only, never full file content. Use at most 2 files and 3 edits total. Copy every find string verbatim from the supplied source. Output JSON only; if you cannot safely fit the patch, return an empty changes array and state the blocker in summary.`,
          contextFiles
        );
        report.modelInvoked.provider = modelResult.provider;
        report.modelInvoked.model = modelResult.model;
        report.modelInvoked.fallbackUsed = modelResult.fallbackUsed ?? false;
        report.modelInvoked.keylessRouteErrors = [
          ...(report.modelInvoked.keylessRouteErrors ?? []),
          ...(modelResult.keylessRouteErrors ?? []),
        ];
        if (!modelResult.success) {
          report.status = 'FAILED';
          report.errorMessage = `Model JSON repair failed: ${modelResult.error}`;
          log('error', report.errorMessage);
          return finalize();
        }
        try {
          parsedPlan = parseModelJson(modelResult.text);
        } catch (repairErr: any) {
          report.status = 'FAILED';
          report.errorMessage = `Model output remained invalid JSON after one repair attempt: ${repairErr.message}`;
          log('error', report.errorMessage);
          return finalize();
        }
      }
      applyPlanToReport(parsedPlan);

      // A syntactically valid empty plan is still a failed plan when the task
      // requires a change. Retry once with a compact, relevant context instead
      // of treating a low-capability model's empty response as the final answer.
      if (report.plannedChanges.length === 0) {
        if (!guardModelCall('empty-patch repair')) return finalize();
        log('warn', 'Model returned a valid plan with zero changes; retrying once with compact context.');
        const compactContextFiles = contextFiles
          .filter((file) => ['AGENTS.md', 'package.json', 'FILE_TREE_INVENTORY.txt'].includes(file.path) || explicitPaths.includes(file.path))
          .map((file) => ({
            path: file.path,
            content: file.path === 'AGENTS.md'
              ? file.content.slice(0, 3500)
              : file.path === 'package.json'
                ? file.content.slice(0, 2200)
                : file.path === 'FILE_TREE_INVENTORY.txt'
                  ? file.content.split('\n').slice(0, 60).join('\n')
                  : file.content,
          }));
        report.modelInvoked.callsCount += 1;
        const compactRetry = await this.model.generatePlanAndPatch(
          `Task: ${task.title}\nDetails: ${task.description}\n\nEMPTY-PLAN RECOVERY REQUIRED. Your previous response was valid JSON but proposed zero file changes. Re-evaluate the task using only the compact context supplied. If the task asks to create a file, return exactly one create change at the requested new path with complete useful content. If it asks to modify an existing file, use exact unique anchors copied from that file. Do not return an empty changes array unless the task is genuinely impossible; if blocked, explain the concrete blocker in summary. Return compact valid JSON only and include numbered requirements with testable acceptance criteria.`,
          compactContextFiles
        );
        report.modelInvoked.provider = compactRetry.provider;
        report.modelInvoked.model = compactRetry.model;
        report.modelInvoked.fallbackUsed = compactRetry.fallbackUsed ?? false;
        report.modelInvoked.keylessRouteErrors = [
          ...(report.modelInvoked.keylessRouteErrors ?? []),
          ...(compactRetry.keylessRouteErrors ?? []),
        ];
        if (!compactRetry.success) {
          report.status = 'FAILED';
          report.errorMessage = `Compact empty-plan recovery failed: ${compactRetry.error}`;
          log('error', report.errorMessage);
          return finalize();
        }
        try {
          parsedPlan = parseModelJson(compactRetry.text);
          applyPlanToReport(parsedPlan);
        } catch (retryError: any) {
          report.status = 'FAILED';
          report.errorMessage = `Compact empty-plan recovery returned an invalid plan: ${String(retryError?.message || retryError)}`;
          log('error', report.errorMessage);
          return finalize();
        }
        if (report.plannedChanges.length === 0) {
          report.status = 'FAILED';
          report.errorMessage = 'Model returned an empty patch after one compact-context recovery attempt.';
          log('error', report.errorMessage);
          return finalize();
        }
        trace('PLAN', 'REPAIRED', `compact retry proposed ${report.plannedChanges.length} file changes`);
      }

      // Retry malformed exact anchors at most twice. Never relax matching or apply a guessed edit.
      let anchorProblems = this.findEditAnchorProblems(report.plannedChanges, contextFiles);
      let anchorRepairAttempts = 0;
      while (anchorProblems.length > 0 && anchorRepairAttempts < 2) {
        if (!guardModelCall('anchor repair')) return finalize();
        anchorRepairAttempts += 1;
        log('warn', `Model patch contains invalid exact anchors; requesting bounded repair ${anchorRepairAttempts}/2: ${anchorProblems.slice(0, 5).join(' | ')}`);
        report.modelInvoked.callsCount += 1;
        modelResult = await this.model.generatePlanAndPatch(
          `${task.title}\nDetails: ${task.description}\n\nPATCH REPAIR REQUIRED (attempt ${anchorRepairAttempts}/2). The previous patch was rejected before application because these patch preflight checks failed: ${JSON.stringify(anchorProblems.slice(0, 5))}. Re-read the supplied source files and regenerate the complete compact JSON plan. Every edit.find must be copied verbatim from the matching supplied file and must occur exactly once. Keep at most 3 files and 4 edits total. Do not guess anchors, do not weaken validation, and do not change unrelated files.`,
          contextFiles
        );
        report.modelInvoked.provider = modelResult.provider;
        report.modelInvoked.model = modelResult.model;
        report.modelInvoked.fallbackUsed = modelResult.fallbackUsed ?? false;
        report.modelInvoked.keylessRouteErrors = [
          ...(report.modelInvoked.keylessRouteErrors ?? []),
          ...(modelResult.keylessRouteErrors ?? []),
        ];
        if (!modelResult.success) {
          report.status = 'FAILED';
          report.errorMessage = `Model patch repair failed: ${modelResult.error}`;
          log('error', report.errorMessage);
          return finalize();
        }
        try {
          parsedPlan = parseModelJson(modelResult.text);
        } catch (err: any) {
          report.status = 'FAILED';
          report.errorMessage = `Failed to parse repaired model JSON: ${err.message}`;
          log('error', report.errorMessage);
          return finalize();
        }
        applyPlanToReport(parsedPlan);
        anchorProblems = this.findEditAnchorProblems(report.plannedChanges, contextFiles);
      }
      if (anchorProblems.length > 0) {
        report.status = 'FAILED';
        report.errorMessage = `Patch contains invalid exact anchors after two repair attempts: ${anchorProblems.slice(0, 5).join(' | ')}`;
        log('error', report.errorMessage);
        return finalize();
      }

      log('info', `Requirements matrix established with ${report.requirements.length} criteria.`);

      // 5. PATCH VALIDATION (Fix AUD-20261012-02 Patch Validation)
      const patchValidation = this.validatePatch(report.plannedChanges);
      if (!patchValidation.valid) {
        report.status = 'FAILED';
        report.errorMessage = `Patch Validation Rejected: ${patchValidation.error}`;
        log('error', report.errorMessage);
        return finalize();
      }
      log('info', `Patch validated successfully: ${report.plannedChanges.length} files pass security checks.`);
      trace('VALIDATE', 'PASSED', `${report.plannedChanges.length} file changes`);

      // 6. Apply the validated patch in an isolated checkout, then test that exact tree.
      report.status = 'TESTING';
      const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'firstborn-forge-'));
      const worktree = path.join(workRoot, 'target');
      try {
        const gitEnv: NodeJS.ProcessEnv = { ...process.env };
        delete gitEnv.GITHUB_TOKEN;
        delete gitEnv.GEMINI_API_KEY;
        delete gitEnv.GH_TOKEN;
        if (this.githubToken) {
          gitEnv.GIT_CONFIG_COUNT = '1';
          gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
          gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.githubToken}`).toString('base64')}`;
        }
        log('info', `Cloning target branch ${targetBranch} into an isolated temporary worktree.`);
        // M3: bounded mission-level retry for transient base movement. The base SHA
        // never changes within the loop, so this only re-clones; it is exhausted at
        // FORGE_MAX_MISSION_ATTEMPTS (default 1, i.e. a single attempt as before).
        const missionAttempts = loadForgeLimits().maxMissionAttempts;
        let cloneOk = false;
        let movedDetail = '';
        for (let attempt = 1; attempt <= missionAttempts && !cloneOk; attempt += 1) {
          await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined);
          if (attempt > 1) trace('INSPECT', 'STARTED', `mission retry ${attempt}/${missionAttempts}`);
          await execFileAsync('git', ['clone', '--depth', '1', '--branch', targetBranch, `https://github.com/${owner}/${repo}.git`, worktree], {
            env: gitEnv,
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          });
          const { stdout: checkedOutSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree, timeout: 15000 });
          const actual = checkedOutSha.trim();
          if (actual === report.baseCommitSha) {
            cloneOk = true;
            break;
          }
          movedDetail = `expected ${report.baseCommitSha}, cloned ${actual}`;
          log('warn', `Base moved during clone (attempt ${attempt}/${missionAttempts}): ${movedDetail}`);
        }
        if (!cloneOk) {
          report.status = 'BLOCKED';
          report.blockerReason = `Target branch moved during inspection (${movedDetail}). Retry against the new base.`;
          trace('INSPECT', 'BLOCKED', report.blockerReason);
          log('warn', report.blockerReason);
          return finalize();
        }

        await this.applyChangesToWorktree(worktree, report.plannedChanges);
        trace('APPLY', 'PASSED', 'validated patch applied to isolated worktree');

        const packagePath = path.join(worktree, 'package.json');
        let scripts: Record<string, string> = {};
        try {
          const targetPackage = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
          scripts = targetPackage.scripts || {};
        } catch {
          // Non-Node repositories are not assumed to have npm checks.
        }

        const checksToRun: string[] = [];
        const hasNpmScripts = Object.keys(scripts).length > 0;
        if (hasNpmScripts) {
          // Mirror the documented CI surface (verify.yml): lint, build, test, and the
          // keyless model smoke. Running model:smoke here means a Forge PR is fully
          // self-checked even when its PR-triggered CI run is held for approval.
          const candidateChecks: Array<[string, string]> = [
            ['npm run lint', 'lint'],
            ['npm test', 'test'],
            ['npm run build', 'build'],
            ['npm run model:smoke', 'model:smoke'],
          ];
          for (const [command, scriptName] of candidateChecks) {
            if (scripts[scriptName]) checksToRun.push(command);
          }
        }
        const substantiveChecks = checksToRun.filter((cmd) => cmd !== 'git diff --check');
        if (substantiveChecks.length === 0) {
          report.status = 'BLOCKED';
          report.blockerReason = 'No recognized target-project test, lint, build, or model-smoke script exists; whitespace validation alone is not sufficient to authorize a coding PR.';
          log('warn', report.blockerReason);
          return finalize();
        }
        checksToRun.push('git diff --check');

        let latestAttemptResults: TaskExecutionReport['testResults'] = [];
        let allChecksPassed = false;
        for (let attempt = 0; attempt < 3 && !allChecksPassed; attempt += 1) {
          const attemptResults: TaskExecutionReport['testResults'] = [];
          if (hasNpmScripts) {
            let install = await this.testRunner.runCheck('npm install', worktree);
            report.testResults.push(install);
            attemptResults.push(install);
            if (install.status !== 'PASSED') {
              log('warn', `Dependency installation failed on attempt ${attempt + 1}; retrying once before classifying the environment as blocked.`);
              await new Promise((resolve) => setTimeout(resolve, 1000));
              const retryInstall = await this.testRunner.runCheck('npm install', worktree);
              report.testResults.push(retryInstall);
              attemptResults[attemptResults.length - 1] = retryInstall;
              install = retryInstall;
            }
            if (install.status !== 'PASSED') {
              report.status = 'FAILED';
              report.errorMessage = `Target dependency installation failed twice (last exit ${install.exitCode}).`;
              log('error', report.errorMessage);
              return finalize();
            }
          }

          for (const cmd of checksToRun) {
            log('info', `Testing proposed patch (attempt ${attempt + 1}/3): ${cmd}`);
            const result = await this.testRunner.runCheck(cmd, worktree);
            report.testResults.push(result);
            attemptResults.push(result);
            const detail = result.status === 'PASSED'
              ? ''
              : `; stderr tail: ${result.stderr.slice(-500)}; stdout tail: ${result.stdout.slice(-500)}`;
            log(result.status === 'PASSED' ? 'info' : 'warn', `Target check "${cmd}" exit=${result.exitCode} status=${result.status}${detail}`);
          }

          latestAttemptResults = attemptResults;
          allChecksPassed = attemptResults.length > 0 && attemptResults.every((result) => result.status === 'PASSED');
          if (allChecksPassed) {
            trace('TEST', 'PASSED', `${attemptResults.length} target checks passed on attempt ${attempt + 1}`);
            break;
          }

          if (attempt < 2) {
            const failedResults = attemptResults.filter((result) => result.status !== 'PASSED');
            const failureDetails = failedResults.map((result) =>
              `COMMAND: ${result.command}\nSTATUS: ${result.status}\nEXIT: ${result.exitCode}\nSTDOUT HEAD:\n${result.stdout.slice(0, 700)}\nSTDOUT TAIL:\n${result.stdout.slice(-1100)}\nSTDERR HEAD:\n${result.stderr.slice(0, 500)}\nSTDERR TAIL:\n${result.stderr.slice(-1100)}`
            ).join('\n\n--- FAILED CHECK ---\n\n');
            log('warn', `Target checks failed; requesting bounded repair ${attempt + 1}/2 with ${failedResults.length} failing check(s).`);
            if (!guardModelCall('target-check repair')) return finalize();
            report.modelInvoked.callsCount += 1;
            const previousPatchSummary = report.plannedChanges
              .map((change) => JSON.stringify({
                path: change.path,
                action: change.action,
                rationale: change.rationale,
                edits: change.edits?.map((edit) => ({
                  find: edit.find.slice(0, 500),
                  replace: edit.replace.slice(0, 800),
                })),
                contentPreview: typeof change.content === 'string' ? change.content.slice(0, 1200) : undefined,
              }, null, 2))
              .join('\n');
            const repairResult = await this.model.generatePlanAndPatch(
              `TASK TO COMPLETE: ${task.title}\nDETAILS: ${task.description}\n\nTARGET-CHECK REPAIR REQUIRED (attempt ${attempt + 1}/2). The previous patch was applied but failed target checks. The exact previous edits and compiler/test diagnostics are included below. Do not repeat the same edit if it caused the failure; change the anchor or placement to address the diagnostics. For top-level declarations, use a file-scope anchor; for interface members, use a unique field anchor inside the intended interface. Fix the actual cause (including missing imports or type/syntax errors), and return a complete replacement JSON plan for the same task. Preserve the original task scope. Do not weaken, skip, or silence checks. Existing files must use exact-anchor edits copied verbatim from the original supplied source. Do not modify package manifests, workflows, scripts, secrets, or security controls.\n\nPREVIOUS PATCH SUMMARY:\n${previousPatchSummary}\n\nFAILED CHECK DIAGNOSTICS:\n${failureDetails}`,
              contextFiles
            );
            report.modelInvoked.provider = repairResult.provider;
            report.modelInvoked.model = repairResult.model;
            report.modelInvoked.fallbackUsed = repairResult.fallbackUsed ?? false;
            report.modelInvoked.keylessRouteErrors = [
              ...(report.modelInvoked.keylessRouteErrors ?? []),
              ...(repairResult.keylessRouteErrors ?? []),
            ];
            if (!repairResult.success) {
              report.status = 'FAILED';
              report.errorMessage = `Target-check repair model call failed: ${repairResult.error}`;
              log('error', report.errorMessage);
              return finalize();
            }
            let repairedPlan: any;
            try {
              repairedPlan = parseModelJson(repairResult.text);
            } catch (error: any) {
              report.status = 'FAILED';
              report.errorMessage = `Target-check repair returned invalid JSON: ${error.message}`;
              log('error', report.errorMessage);
              return finalize();
            }
            if (!Array.isArray(repairedPlan.changes) || repairedPlan.changes.length === 0) {
              report.status = 'FAILED';
              report.errorMessage = 'Target-check repair returned no replacement changes.';
              log('error', report.errorMessage);
              return finalize();
            }
            report.plannedChanges = repairedPlan.changes.map((change: any) => ({
              path: change.path,
              action: change.action,
              rationale: change.rationale,
              content: change.content,
              edits: change.edits,
            }));
            const repairAnchorProblems = this.findEditAnchorProblems(report.plannedChanges, contextFiles);
            if (repairAnchorProblems.length > 0) {
              report.status = 'FAILED';
              report.errorMessage = `Target-check repair failed patch preflight: ${repairAnchorProblems.slice(0, 5).join(' | ')}`;
              log('error', report.errorMessage);
              return finalize();
            }
            const repairValidation = this.validatePatch(report.plannedChanges);
            if (!repairValidation.valid) {
              report.status = 'FAILED';
              report.errorMessage = `Target-check repair was rejected: ${repairValidation.error}`;
              log('error', report.errorMessage);
              return finalize();
            }

            await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: worktree, timeout: 15000 });
            await execFileAsync('git', ['clean', '-fd'], { cwd: worktree, timeout: 15000 });
            await this.applyChangesToWorktree(worktree, report.plannedChanges);
            log('info', 'Applied repaired patch to a clean base worktree; rerunning target checks after this repair attempt.');
          }
        }

        if (!allChecksPassed) {
          report.status = 'FAILED';
          report.errorMessage = 'Target checks still failed after two bounded patch-repair attempts.';
          trace('TEST', 'FAILED', 'target checks failed after bounded repairs');
          log('error', report.errorMessage);
          return finalize();
        }

        // Bind each requirement to the concrete evidence available for it rather than
        // forcing a blanket PENDING (see evaluateRequirementEvidence).
        report.requirements.forEach((req) => {
          const evaluation = evaluateRequirementEvidence(req, latestAttemptResults);
          req.status = evaluation.status;
          req.evidence = evaluation.evidence;
        });
      } finally {
        await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
      }

      // 7. GITHUB BRANCH, COMMIT & PR CREATION
      report.status = 'VERIFYING';
      const runDiscriminator = process.env.GITHUB_RUN_ID || `${Date.now()}`;
      const branchName = `forge/task-${task.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${runDiscriminator}`;
      report.branchName = branchName;

      // R7: the permission control plane decides, before any GitHub write, whether
      // this mission may create a branch, commit, or open a PR. Defaults preserve
      // least privilege; broader capability must be enabled explicitly.
      const permission = evaluatePermissionPolicy(
        {
          requestedPrCreation: task.allowPrCreation,
          branchName,
          targetBranch,
          repo: `${owner}/${repo}`,
        },
        loadPermissionConfig(),
      );
      trace('POLICY', permission.allowBranchWrite ? 'PASSED' : 'BLOCKED', `${permission.effectiveProfile}: ${permission.reason}`);

      // Extract validated files with content
      const filesToCommit = report.plannedChanges
        .filter((c) => c.content && typeof c.content === 'string')
        .map((c) => ({ path: c.path, content: c.content as string }));

      // Fix AUD-20261012-02 Empty PR prevention: fail closed if no file contents are committed
      if (filesToCommit.length === 0) {
        report.status = 'FAILED';
        report.errorMessage = 'Safety Block: Zero files with valid content to commit. Cannot open empty Pull Request.';
        log('error', report.errorMessage);
        return finalize();
      }

      if (!task.allowPrCreation) {
        log('info', 'Task verified locally. Pull Request creation not authorized by caller.');
        report.status = 'VERIFYING';
      } else if (!permission.allowBranchWrite) {
        report.status = 'BLOCKED';
        report.blockerReason = `Permission policy denied GitHub write: ${permission.reason}`;
        log('warn', report.blockerReason);
      } else {
        log('info', `Permission policy (${permission.effectiveProfile}): ${permission.reason}`);
        log('info', `Creating or updating isolated branch ${branchName} at base SHA ${report.baseCommitSha}...`);
        const branchRes = await this.github.createOrUpdateBranch(owner, repo, branchName, report.baseCommitSha);

        if (!branchRes.success) {
          log('warn', `Branch operation halted: ${branchRes.error}`);
          report.status = 'BLOCKED';
          report.blockerReason = `GitHub branch operation blocked: ${branchRes.error}`;
        } else {
          log('info', `Branch ${branchName} confirmed.`);

          // Commit the actual patch files to the branch with base tree SHA resolution
          log('info', `Committing ${filesToCommit.length} modified files to ${branchName}...`);
          const commitRes = await this.github.commitChangesToBranch({
            owner,
            repo,
            branchName,
            baseCommitSha: report.baseCommitSha,
            commitMessage: `[Forge] ${task.title}\n\nTask-ID: ${task.id}\nRequirements: ${report.requirements.map(r => r.id).join(', ')}`,
            files: filesToCommit,
          });

          if (commitRes.success && commitRes.headSha) {
            report.headCommitSha = commitRes.headSha;
            log('info', `Committed changes. Head SHA: ${report.headCommitSha}`);
            trace('COMMIT', 'PASSED', report.headCommitSha);

            // Open Pull Request with genuine head and base (requires 'review' profile)
            log('info', 'Opening Pull Request on GitHub...');
            if (!permission.allowOpenPr) {
              report.status = 'BLOCKED';
              report.blockerReason = `Permission policy withheld Pull Request: ${permission.reason}`;
              log('warn', report.blockerReason);
              return finalize();
            }
            const prRes = await this.github.openPullRequest({
              owner,
              repo,
              title: `[Forge] ${task.title}`,
              head: branchName,
              base: targetBranch,
              body: `### Forge Task Report: ${task.id}
- **Base Commit**: \`${report.baseCommitSha}\`
- **Head Commit**: \`${report.headCommitSha}\`
- **Provider**: ${report.modelInvoked.provider}
- **Model**: ${report.modelInvoked.model}
- **Fallback Used**: ${report.modelInvoked.fallbackUsed ?? 'unknown'}
- **Keyless Route Errors**: ${(report.modelInvoked.keylessRouteErrors ?? []).join(' | ') || 'none reported'}
- **Status**: Local checks passed; PR opened
- **Tests**: ${report.testResults.map((r) => `${r.command}: ${r.status}`).join(', ')}
`,
            });

            if (prRes.success) {
              report.status = 'PR_OPENED';
              report.prUrl = prRes.url;
              report.prNumber = prRes.number;
              trace('PR', 'PASSED', prRes.url);
              log('info', `Pull Request opened: ${prRes.url}`);
            } else {
              report.status = 'BLOCKED';
              report.blockerReason = `PR opening blocked: ${prRes.error}`;
              log('warn', report.blockerReason);
            }
          } else {
            log('warn', `Commit failed: ${commitRes.error}`);
            report.status = 'BLOCKED';
            report.blockerReason = `Git commit blocked: ${commitRes.error}`;
          }
        }
      }

      report.endTime = new Date().toISOString();
      return finalize();
    } catch (err: any) {
      report.status = 'FAILED';
      report.errorMessage = `Unhandled agent exception: ${err.message}`;
      report.endTime = new Date().toISOString();
      log('error', report.errorMessage);
      return finalize();
    }
  }
}
