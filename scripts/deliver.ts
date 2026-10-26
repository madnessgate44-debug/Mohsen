/**
 * forge-company deliver CLI — audit a target, then deliver a verified fix.
 *
 *   npm run deliver -- <owner/repo> "goal"
 *
 * Read the target, run the software company's implementation team inside a clone
 * pinned at the audited commit, run the target's own checks, and open a pull
 * request on an isolated `forge/` branch. It never merges and never touches the
 * base branch. Requires GITHUB_TOKEN with `repo` scope (contents + pull requests).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelService } from '../src/company/model.ts';
import { modelBrain } from '../src/company/brains.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import { deliverChange, type PullRequestOpener, type DeliveryExpectation } from '../src/company/deliver.ts';
import { runCompanyAudit } from '../src/company/audit-company.ts';
import type { AuditFinding } from '../src/company/audit.ts';
import { fetchRepoContext } from '../src/company/repo-context.ts';
import type { AgentAction, AgentBrain } from '../src/kernel/loop.ts';

const TOKEN = process.env.GITHUB_TOKEN || '';
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The one tool sequence each role follows, so the model executes rather than wanders. */
const ROLE_SEQUENCE: Record<string, string[]> = {
  pm: ['finish with your requirements artifact (data.items = acceptance criteria)'],
  architect: ['read_file on the files named in the goal', 'finish with your design artifact (data.design, data.files)'],
  implementer: [
    'read_file on each file you will change',
    'edit_file with minimal anchors: old_str is a small unique snippet copied exactly from what you read, new_str is the replacement',
    'never retype a whole file — you may only have seen part of it',
    'run_check the "test" command',
    'finish with your change artifact',
  ],
  reviewer: ['read_file on the changed file', 'finish with your review artifact (data.blockers = number)'],
  qa: ['run_check the "test" command', 'run_check the "lint" command', 'finish with your evidence artifact'],
  security: ['read_file on the changed file', 'finish with your security artifact (data.clean = boolean)'],
  release: ['finish with your decision artifact (data.ship = boolean)'],
};

function modelRoster(model: ModelService, workspaceDir: string): (item: { id: string; title: string }, attempt: number) => Role[] {
  return (_item, attempt) =>
    DEFAULT_ROSTER.map((r) => ({
      id: r.id,
      title: r.title,
      mandate: r.mandate,
      authority: r.authority,
      consumes: r.consumes,
      produces: r.produces,
      tools: buildRoleTools({
        workspaceDir,
        canMutate: r.authority === 'branch-write',
        allowedRoots: [''],
      }),
      brain: modelBrain(model, {
        role: `${r.title} (attempt ${attempt})`,
        mandate: r.mandate,
        sequence: ROLE_SEQUENCE[r.id],
        artifactHint: `Emit your "${r.produces}" artifact in data.`,
      }),
    }));
}

/**
 * A deterministic roster for offline plumbing tests (`--scripted`). The
 * implementer makes a trivial, verifiable edit and QA records the check it
 * really ran; the rest of the roster is evidence-only. It proves the delivery
 * path (clone → team → checks → branch → push → PR) without needing model keys.
 */
function scriptedRoster(workspaceDir: string): (item: { id: string; title: string }, attempt: number) => Role[] {
  const EDIT_PATH = 'FORGE-DELIVERY-PROBE.md';
  const content = `# Forge delivery probe\n\nThis file was written by the Forge software company to prove the delivery path end to end.\n`;
  const brain = (id: string): AgentBrain => {
    const scripts: Record<string, AgentAction[]> = {
      implementer: [
        { tool: 'write_file', input: { path: EDIT_PATH, content } },
        { tool: 'run_check', input: { command: 'test' } },
        { tool: 'finish', input: { summary: 'wrote the probe file', data: { files: { [EDIT_PATH]: content } } } },
      ],
      qa: [
        { tool: 'run_check', input: { command: 'test' } },
        { tool: 'run_check', input: { command: 'lint' } },
        { tool: 'finish', input: { summary: 'ran the checks', data: {} } },
      ],
      security: [{ tool: 'finish', input: { summary: 'no escapes', data: { clean: true } } }],
      reviewer: [{ tool: 'finish', input: { summary: 'change is correct', data: { blockers: 0 } } }],
      release: [{ tool: 'finish', input: { summary: 'may ship', data: { ship: true } } }],
      pm: [{ tool: 'finish', input: { summary: 'requirement: probe the path', data: { items: ['probe file exists'] } } }],
      architect: [{ tool: 'finish', input: { summary: 'add one file', data: { files: [EDIT_PATH] } } }],
    };
    const script = scripts[id] ?? [{ tool: 'finish', input: { summary: id, data: {} } }];
    let i = 0;
    return async () => script[Math.min(i++, script.length - 1)];
  };
  return () =>
    DEFAULT_ROSTER.map((r) => ({
      id: r.id,
      title: r.title,
      mandate: r.mandate,
      authority: r.authority,
      consumes: r.consumes,
      produces: r.produces,
      tools: buildRoleTools({ workspaceDir, canMutate: r.authority === 'branch-write', allowedRoots: [''] }),
      brain: brain(r.id),
    }));
}

const openPr: PullRequestOpener = async ({ target, head, base, title, body, token }) => {
  const res = await fetch(`https://api.github.com/repos/${target}/pulls`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'forge-company-deliver' },
    body: JSON.stringify({ title, head, base, body }),
  });
  if (!res.ok) throw new Error(`GitHub PR API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scripted = args.includes('--scripted');
  const runAudit = args.includes('--audit');
  const valueFlags = new Set(['--expect-file', '--expect-contains', '--max-deletions', '--max-additions', '--expect-touches']);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (valueFlags.has(a)) {
      flags[a] = args[i + 1] ?? '';
      i += 1;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  const target = (positional[0] || '').trim();
  const goalArg = positional.slice(1).join(' ').trim();
  if (!repoPattern.test(target) || target.includes('..')) {
    console.error('usage: npm run deliver -- [--scripted] [--audit] [--expect-file <path>] [--expect-contains <text>] [--max-deletions <n>] [--max-additions <n>] owner/repo "goal"');
    process.exitCode = 2;
    return;
  }

  const expect: DeliveryExpectation[] = [];
  const parseCount = (flag: string): number | undefined => {
    if (flags[flag] === undefined) return undefined;
    const n = Number.parseInt(flags[flag], 10);
    return Number.isNaN(n) ? undefined : n;
  };
  const touchedAny = flags['--expect-touches'] !== undefined
    ? flags['--expect-touches'].split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  if (flags['--expect-contains'] !== undefined) {
    expect.push({
      file: flags['--expect-file'] || undefined,
      addedLinesContain: flags['--expect-contains'],
      maxDeletions: parseCount('--max-deletions'),
      maxAdditions: parseCount('--max-additions'),
      touchedAny,
    });
  } else if (flags['--max-deletions'] !== undefined || flags['--max-additions'] !== undefined || touchedAny) {
    expect.push({
      file: flags['--expect-file'] || undefined,
      maxDeletions: parseCount('--max-deletions'),
      maxAdditions: parseCount('--max-additions'),
      touchedAny,
    });
  }

  const ctx = await fetchRepoContext(target);

  const model = scripted ? null : new ModelService();
  const providerInfo = model ? model.getProviderInfo() : { primaryProvider: 'scripted', fallbackConfigured: false };
  if (model) {
    console.log(`[deliver] model: ${providerInfo.primaryProvider}; Gemini fallback configured: ${providerInfo.fallbackConfigured}`);
  } else {
    console.log('[deliver] scripted roster (deterministic; proves the delivery path, not model quality)');
  }

  // Optional: run the real audit first and deliver its findings. This is what
  // makes the report's "audited <target>" claim true. `--goal` supplies the
  // instruction (a manual goal is never called an audit).
  let audited = false;
  let findings: AuditFinding[] = [];
  let goal = goalArg;
  if (runAudit) {
    if (!model) {
      console.error('[deliver] --audit needs a model; --scripted cannot audit. Run without --scripted, or drop --audit.');
      process.exitCode = 2;
      return;
    }
    const attempts = Math.max(1, Number.parseInt(process.env.FORGE_AUDIT_ATTEMPTS ?? '', 10) || 2);
    console.log(`[deliver] auditing ${ctx.target} @ ${ctx.commit.slice(0, 8)} (attempts=${attempts}) ...`);
    const audit = await runCompanyAudit({ model, ctx, attemptsPerItem: attempts, providerInfo });
    const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'company-audit.json'), JSON.stringify(audit, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'company-audit.md'), audit.markdown + '\n');
    findings = audit.findings;
    audited = audit.status === 'COMPLETED' && findings.length > 0;
    console.log(`[deliver] audit: status ${audit.status}; ${findings.length} finding(s)`);
    if (!findings.length) {
      console.log('[deliver] the audit produced no findings; nothing to deliver. Stopping.');
      return;
    }
    // Highest severity first, then the order the audit produced.
    const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
    const top = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
    // A change that only adds a new file does not fix a finding in an existing
    // file. Require the diff to touch one of the finding's own files.
    if (top.paths.length && !expect.some((e) => e.touchedAny?.length)) {
      expect.push({ touchedAny: top.paths });
    }
    if (goalArg) {
      // A supplied goal means the run follows the goal, not the findings. Say so
      // honestly rather than claiming the change addresses the audit: drop the
      // findings from the delivery expectation (they remain in company-audit.json).
      goal = goalArg;
      audited = false;
      findings = [];
      console.log('[deliver] a goal was supplied, so this run follows the goal, not the audit findings; the report will say so.');
    } else {
      // Deliver ONE bounded finding, not the whole report: a goal that lists
      // twelve findings is not a change anyone can make or verify in one run.
      findings = [top];
      goal = `Fix this ${top.severity} audit finding: ${top.title}. Files: ${top.paths.join(', ')}. Evidence: ${top.evidence}${top.recommendation ? ` Recommendation: ${top.recommendation}` : ''}`;
      console.log(`[deliver] delivering the top finding (${top.severity}): ${top.title}`);
    }
  }
  if (!goal) goal = 'Address the audit findings.';

  console.log(`[deliver] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; goal: ${goal}`);

  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deliver-'));
  const branch = `forge/deliver-${ctx.commit.slice(0, 8)}-${Date.now().toString(36)}`;

  const result = await deliverChange({
    target: ctx.target,
    goal,
    commit: ctx.commit,
    branch,
    workspaceDir,
    token: TOKEN,
    rosterFor: model ? modelRoster(model, workspaceDir) : scriptedRoster(workspaceDir),
    attemptsPerItem: Math.max(1, Number.parseInt(process.env.FORGE_DELIVER_ATTEMPTS ?? '', 10) || 1),
    push: process.env.FORGE_DELIVER_PUSH !== 'false',
    expect,
    audited,
    findings,
    openPr,
  });

  const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'company-delivery.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'company-delivery.md'), result.markdown + '\n');

  console.log('\n--- COMPANY DELIVERY REPORT ---');
  console.log('Status:', result.status, '|', result.reason);
  console.log('Branch:', result.branch, '| head:', result.headCommit ?? '(none)');
  console.log('Changed files:', result.changedFiles.join(', ') || '(none)');
  for (const c of result.checks) console.log(`- ${c.name}: ${c.status}`);
  if (result.prUrl) console.log('PR:', result.prUrl);
  console.log('\n' + result.markdown);
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company deliver] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
