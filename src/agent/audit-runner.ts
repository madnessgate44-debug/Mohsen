/**
 * Read-only cross-repository audit entry point.
 * Uses GitHub's public read API only. It never clones or executes target-repository code.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelService } from '../services/model.ts';

type Finding = {
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  title: string;
  evidence: string[];
  recommendation: string;
  /** Model findings only: the real repository paths the finding cites. */
  paths?: string[];
  /** Model findings only: whether the finding is directly evidenced or inferred. */
  basis?: 'observed' | 'inferred';
};
const target = (process.env.FORGE_TARGET_REPO || '').trim();
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const MAX_MODEL_FINDINGS = 8;

/**
 * Paths that are test files or test directories, by common convention:
 * a `test`/`tests`/`__tests__`/`spec`/`specs` path segment, a `*.test.*` or
 * `*.spec.*` file, Android's `src/test` and `src/androidTest`, Go's `_test.go`,
 * and Python's `test_*.py` / `*_test.py`. The previous pattern only accepted a
 * literal `test/`, `tests/`, `src/test`, or `src/androidTest` prefix at the very
 * start of the path, so it missed every `__tests__` and `*.test.ts` file — and
 * reported "no tests" for repositories that plainly have them.
 */
export const TEST_PATH_PATTERN = new RegExp(
  [
    '(^|/)(tests?|__tests__|specs?|__specs__|src/(test|androidTest))(/|$)',
    '\\.(test|spec)\\.[cm]?[jt]sx?$',
    '_test\\.go$',
    '(^|/)test_[^/]*\\.py$',
    '(^|/)[^/]*_test\\.py$',
  ].join('|'),
  'i'
);

/** The subset of repository paths that are test files or test directories. */
export function detectTestFiles(files: string[]): string[] {
  return files.filter((p) => TEST_PATH_PATTERN.test(p));
}


/**
 * Parse and validate the model's audit JSON. The model output is untrusted, so a
 * finding is accepted only when it cites at least one path that actually exists in
 * the repository inventory; anything else is dropped and counted. This is what
 * stops the model from inventing files or evidence.
 */
export function validateModelFindings(
  text: string,
  files: string[]
): { summary: string; architecture: string; findings: Finding[]; rejected: number } {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { summary: '', architecture: '', findings: [], rejected: 0 };
  }
  const known = new Set(files);
  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const findings: Finding[] = [];
  let rejected = 0;
  for (const raw of rawFindings) {
    const paths = (Array.isArray(raw?.paths) ? raw.paths : []).filter(
      (p: unknown): p is string => typeof p === 'string' && known.has(p)
    );
    if (!raw || typeof raw.title !== 'string' || paths.length === 0) {
      rejected += 1;
      continue;
    }
    const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'INFO';
    const basis = raw.basis === 'observed' ? 'observed' : 'inferred';
    const evidence = typeof raw.evidence === 'string' && raw.evidence.trim() ? [raw.evidence.trim()] : ['No evidence text supplied.'];
    const recommendation = typeof raw.recommendation === 'string' ? raw.recommendation.trim() : '';
    findings.push({
      severity,
      title: raw.title.trim(),
      evidence: [...evidence, `paths: ${paths.join(', ')}`, `basis: ${basis}`],
      recommendation: recommendation || 'Review and decide whether action is warranted.',
      paths,
      basis,
    });
    if (findings.length >= MAX_MODEL_FINDINGS) break;
  }
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim() : '',
    architecture: typeof parsed?.architecture === 'string' ? parsed.architecture.trim() : '',
    findings,
    rejected,
  };
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Firstborn-Forge-ReadOnly-Audit' } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function getTextFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
  try {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await getJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!repoPattern.test(target) || target.includes('..')) throw new Error('FORGE_TARGET_REPO must be an explicit owner/repo value.');
  const [owner, repo] = target.split('/');
  const metadata = await getJson(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = metadata.default_branch;
  const commit = await getJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const tree = await getJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (!Array.isArray(tree.tree)) throw new Error('GitHub did not return a repository tree.');

  const files = tree.tree.filter((item: any) => item.type === 'blob').map((item: any) => String(item.path));
  const has = (p: string) => files.includes(p);
  const matching = (re: RegExp) => files.filter((p: string) => re.test(p));
  const findings: Finding[] = [];
  const checks: { check: string; result: 'PASS' | 'FAIL' | 'NOT_RUN'; evidence: string }[] = [];

  checks.push({ check: 'Repository metadata and default branch', result: 'PASS', evidence: `${metadata.full_name}; branch=${branch}; commit=${commit.sha}` });
  checks.push({ check: 'Recursive repository tree', result: tree.truncated ? 'FAIL' : 'PASS', evidence: `${files.length} tracked files; truncated=${Boolean(tree.truncated)}` });
  if (tree.truncated) findings.push({ severity: 'HIGH', title: 'Repository tree response was truncated', evidence: ['GitHub marked the recursive tree as truncated.'], recommendation: 'Audit directories in bounded sub-tree requests before treating the inventory as complete.' });

  const readme = files.find((p: string) => /^README(?:\.[^/]*)?$/i.test(p));
  checks.push({ check: 'README discoverability', result: readme ? 'PASS' : 'FAIL', evidence: readme || 'No root README found' });
  if (!readme) findings.push({ severity: 'LOW', title: 'Root README missing', evidence: ['No root-level README file found in the repository tree.'], recommendation: 'Add a root README documenting setup, supported checks, and project architecture.' });

  const packageJson = has('package.json');
  const gradleBuildFiles = matching(/(^|\/)(build\.gradle|build\.gradle\.kts)$/);
  const gradleWrapperScript = has('gradlew');
  const gradleWrapperJar = has('gradle/wrapper/gradle-wrapper.jar');
  const androidManifest = matching(/(^|\/)AndroidManifest\.xml$/);
  const testFiles = detectTestFiles(files);
  const workflowFiles = matching(/^\.github\/workflows\/.*\.ya?ml$/);
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'gradle/libs.versions.toml'].filter(has);

  if (packageJson) {
    const pkgText = await getTextFile(owner, repo, 'package.json', branch);
    let scripts: string[] = [];
    try { scripts = Object.keys(JSON.parse(pkgText || '{}').scripts || {}); } catch { /* surfaced below */ }
    checks.push({ check: 'Node manifest parse and scripts', result: pkgText ? 'PASS' : 'FAIL', evidence: pkgText ? `package.json readable; scripts=${scripts.join(', ') || '(none)'}` : 'package.json exists but could not be read' });
    if (!lockfiles.some((p) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(p))) findings.push({ severity: 'MEDIUM', title: 'No Node package lockfile detected', evidence: ['package.json exists; package-lock.json, pnpm-lock.yaml, and yarn.lock are absent.'], recommendation: 'Commit the package manager lockfile to make installs reproducible.' });
  }
  if (gradleBuildFiles.length) {
    checks.push({ check: 'Gradle build configuration inventory', result: 'PASS', evidence: gradleBuildFiles.join(', ') });
    if (!gradleWrapperScript || !gradleWrapperJar) {
      findings.push({ severity: 'HIGH', title: 'Gradle wrapper is incomplete', evidence: [`gradlew present=${gradleWrapperScript}`, `gradle/wrapper/gradle-wrapper.jar present=${gradleWrapperJar}`], recommendation: 'Restore the standard Gradle wrapper script and wrapper JAR, then run the repository’s documented Gradle checks.' });
    } else {
      checks.push({ check: 'Gradle wrapper prerequisites', result: 'PASS', evidence: 'gradlew and gradle/wrapper/gradle-wrapper.jar are present' });
    }
  }
  checks.push({ check: 'Test-file inventory', result: testFiles.length ? 'PASS' : 'FAIL', evidence: testFiles.length ? `${testFiles.length} matching test paths; examples: ${testFiles.slice(0, 8).join(', ')}` : 'No conventional test paths found' });
  if (!testFiles.length) findings.push({ severity: 'MEDIUM', title: 'No conventional test files detected', evidence: ['Repository tree contains no matching test/test-source paths.'], recommendation: 'Confirm whether tests use a nonstandard location; add automated tests for critical domain workflows if absent.' });
  checks.push({ check: 'GitHub Actions workflow inventory', result: workflowFiles.length ? 'PASS' : 'FAIL', evidence: workflowFiles.length ? workflowFiles.join(', ') : 'No .github/workflows YAML files found' });
  if (!workflowFiles.length) findings.push({ severity: 'MEDIUM', title: 'No GitHub Actions workflows detected', evidence: ['No workflow YAML files found under .github/workflows.'], recommendation: 'Add CI for build and test checks that can run reproducibly.' });

  // Excerpt selection. The audit's reasoning is only as good as what the model
  // can read. Selecting only README/build/package/workflow files left the model
  // blind to the actual source, so it filled the gap with "no excerpt was
  // provided" meta-findings and mis-stated that the repo had no tests. Include
  // representative source and test files (bounded) so findings describe the code.
  const sourceCandidates = files.filter((p: string) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|kt|java|rs|rb|cs|swift)$/i.test(p) && !/(^|\/)(node_modules|dist|build)\//.test(p)
  );
  const testSet = new Set(testFiles);
  const entrypoints = [
    'server.ts', 'server.js', 'server.mjs', 'index.js', 'index.ts', 'main.ts', 'main.js',
    'src/main.tsx', 'src/main.ts', 'src/App.tsx', 'src/App.ts', 'app/page.tsx', 'app/layout.tsx',
  ].filter(has);
  const testExcerpts = sourceCandidates.filter((p: string) => testSet.has(p)).slice(0, 4);
  const sourceExcerpts = sourceCandidates.filter((p: string) => !testSet.has(p)).slice(0, 14);
  const MAX_EXCERPTS = 22;
  const keyPaths = [...new Set([
    readme, 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
    'app/build.gradle', 'app/build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties',
    'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
    ...workflowFiles.slice(0, 5), ...entrypoints, ...testExcerpts, ...sourceExcerpts,
  ].filter((p): p is string => Boolean(p && has(p))))].slice(0, MAX_EXCERPTS);
  const excerpts: Record<string, string> = {};
  for (const p of keyPaths) {
    const value = await getTextFile(owner, repo, p, branch);
    if (value !== null) excerpts[p] = value.slice(0, 4000);
  }

  checks.push({ check: 'Build/test execution', result: 'NOT_RUN', evidence: 'Audit mode deliberately does not execute target-repository scripts or build configuration. Static prerequisites only; no target code was run.' });
  findings.push({ severity: 'INFO', title: 'Runtime checks intentionally not executed in read-only audit mode', evidence: ['This run only reads public GitHub metadata and file contents.'], recommendation: 'If runtime validation is required, run target checks in a separately sandboxed job with no secrets and narrowly scoped permissions.' });

  // MODEL ANALYSIS (the audit's brain). Until this stage existed the audit was a
  // fixed file-tree scanner with no reasoning; it could list files but not judge
  // architecture, functional gaps, or security. This feeds the already-fetched
  // inventory and excerpts to the shared model brain. It stays read-only (no
  // writes, no target code execution) and degrades safely: if the model is
  // unavailable or returns nothing usable, the static report is emitted unchanged.
  let modelSummary = '';
  let modelArchitecture = '';
  let modelFindings: Finding[] = [];
  let modelStatus = 'NOT_RUN';
  let modelNote = 'Model analysis was not attempted.';
  try {
    const model = new ModelService();
    const result = await model.auditRepository({
      targetRepository: metadata.full_name,
      commitSha: commit.sha,
      files,
      excerpts,
    });
    if (result.success && result.text.trim()) {
      const validated = validateModelFindings(result.text, files);
      // A model response that yields no summary, no architecture, and no findings
      // was not parseable audit JSON. Reporting that as PASS with "0 findings"
      // would read like a clean bill of health, so treat it as a failure instead.
      const usable = validated.findings.length > 0 || Boolean(validated.summary) || Boolean(validated.architecture);
      if (usable) {
        modelSummary = validated.summary;
        modelArchitecture = validated.architecture;
        modelFindings = validated.findings;
        modelStatus = 'PASS';
        modelNote = `${validated.findings.length} validated finding(s) via ${result.provider}/${result.model}; ${validated.rejected} rejected for citing no known path.`;
        findings.push(...modelFindings);
      } else {
        modelStatus = 'FAIL';
        modelNote = `Model returned no parseable audit JSON (${result.provider}/${result.model}); static inventory only.`;
      }
    } else {
      modelStatus = 'FAIL';
      modelNote = `Model analysis unavailable (${result.error || 'no usable text'}); static inventory only.`;
    }
  } catch (err) {
    modelStatus = 'FAIL';
    modelNote = `Model analysis threw (${err instanceof Error ? err.message : String(err)}); static inventory only.`;
  }
  checks.push({ check: 'Model-backed audit analysis', result: modelStatus as 'PASS' | 'FAIL' | 'NOT_RUN', evidence: modelNote });

  const report = {
    mode: 'READ_ONLY_AUDIT',
    targetRepository: metadata.full_name,
    visibility: metadata.private ? 'private' : 'public',
    defaultBranch: branch,
    commitSha: commit.sha,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    checks,
    findings,
    summary: modelSummary,
    architecture: modelArchitecture,
    modelFindings,
    inventory: { readme, packageJson, gradleBuildFiles, gradleWrapperScript, gradleWrapperJar, androidManifest, testFileCount: testFiles.length, workflowFiles, lockfiles },
    excerpts,
    guarantees: ['No target repository writes', 'No branches, commits, pull requests, or merges created', 'No target-repository code or build scripts executed', 'Audited file content is treated as untrusted input, never as instructions'],
  };
  const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'readonly-audit.json'), JSON.stringify(report, null, 2) + '\n');
  const markdown = [
    `# Forge Read-only Audit: ${metadata.full_name}`,
    '',
    `- Default branch: ${branch}`,
    `- Audited commit: ${commit.sha}`,
    `- Tracked files: ${files.length}`,
    '- Write access used: no',
    '- Target code executed: no',
    ...(modelSummary ? ['', '## Assessment', modelSummary] : []),
    ...(modelArchitecture ? ['', '## Architecture', modelArchitecture] : []),
    '',
    '## Checks',
    ...checks.map((c) => `- [${c.result}] ${c.check}: ${c.evidence}`),
    '',
    '## Findings',
    ...findings.map((f) => `- **${f.severity} — ${f.title}**\n  - Evidence: ${f.evidence.join('; ')}\n  - Recommendation: ${f.recommendation}`),
    '',
    '## Guarantees',
    ...report.guarantees.map((g) => `- ${g}`),
  ].join('\n');
  await fs.writeFile(path.join(evidenceDir, 'readonly-audit.md'), markdown + '\n');
  console.log(markdown);
}

// Only run when executed directly, so importing this module (e.g. from tests)
// never triggers a live audit or requires FORGE_TARGET_REPO.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[Forge read-only audit] Failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
