/**
 * M3 — Sentinel runner. Re-runs the deterministic checks against a pull request
 * and applies the pure merge decision in `src/agent/sentinel.ts`.
 *
 * It NEVER merges by itself: it only reports the decision and (when explicitly
 * enabled) performs the merge API call. The workflow gates the merge on this
 * decision AND on the repository variable SENTINEL_AUTO_MERGE.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { decideMerge, loadSentinelConfig, type CheckResult, type ModelVerdict } from '../src/agent/sentinel.ts';

function runCheck(name: string, command: string, args: string[]): CheckResult {
  try {
    execFileSync(command, args, { stdio: 'inherit', env: process.env });
    return { name, passed: true };
  } catch {
    return { name, passed: false };
  }
}

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

async function main(): Promise<void> {
  const sourceBranch = (process.env.SENTINEL_SOURCE_BRANCH ?? '').trim();
  const targetBranch = (process.env.SENTINEL_TARGET_BRANCH ?? 'main').trim();
  const config = loadSentinelConfig();

  const checks: CheckResult[] = [];
  if (config.requiredChecks.includes('lint')) checks.push(runCheck('lint', 'npm', ['run', 'lint']));
  if (config.requiredChecks.includes('build')) checks.push(runCheck('build', 'npm', ['run', 'build']));
  if (config.requiredChecks.includes('test')) checks.push(runCheck('test', 'npm', ['run', 'test']));

  // The model judge is optional and off by default. When enabled, its verdict
  // must be supplied by an upstream step; absent a verdict the Sentinel holds.
  const modelVerdict = config.modelJudgeEnabled
    ? ((process.env.SENTINEL_MODEL_VERDICT ?? '').trim() as ModelVerdict || undefined)
    : undefined;

  const decision = decideMerge({ sourceBranch, targetBranch, checks, config, modelVerdict });

  console.log('--- SENTINEL DECISION ---');
  console.log(`Source: ${sourceBranch || '(none)'} -> Target: ${targetBranch}`);
  for (const c of checks) console.log(`Check ${c.name}: ${c.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Decision: ${decision.merge ? 'MERGE' : decision.hold ? 'HOLD' : 'BLOCK'}`);
  console.log(`Reason: ${decision.reason}`);
  if (decision.violations.length > 0) console.log('Violations:\n - ' + decision.violations.join('\n - '));

  const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    sourceBranch,
    targetBranch,
    checks,
    modelJudgeEnabled: config.modelJudgeEnabled,
    modelVerdict: modelVerdict ?? null,
    decision,
  };
  writeFileSync(path.join(evidenceDir, 'sentinel-decision.json'), JSON.stringify(artifact, null, 2) + '\n');

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `merge=${decision.merge}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `hold=${decision.hold}\n`);
  }

  // Perform the merge only when the decision allows it AND auto-merge is
  // explicitly enabled by an operator. Default: verify and report only.
  const repo = (process.env.GITHUB_REPOSITORY ?? '').trim();
  const prNumber = (process.env.SENTINEL_PR_NUMBER ?? '').trim();
  const token = (process.env.GITHUB_TOKEN ?? '').trim();
  if (decision.merge && flag('SENTINEL_AUTO_MERGE') && repo && prNumber && token) {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Firstborn-Sentinel',
      },
      body: JSON.stringify({ merge_method: 'squash' }),
    });
    if (!response.ok) {
      console.error(`Merge failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
      process.exitCode = 1;
    } else {
      console.log(`Merged PR #${prNumber} into ${targetBranch}.`);
    }
  } else if (decision.merge) {
    console.log('Verified OK. Auto-merge is disabled (SENTINEL_AUTO_MERGE is not "true"); not merging.');
  } else {
    // A blocked or held verification is a failing gate.
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[Sentinel] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
