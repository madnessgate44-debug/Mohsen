/**
 * forge-company CLI — run the company on a real goal.
 *
 *   npm run company -- "goal"                        # deterministic scripted employees (offline)
 *   npm run company -- --model "goal"                # model-backed employees using Forge's keys
 *   npm run company -- --model --target "goal"       # model-backed against a generated sample workspace
 *   npm run company -- --model --workspace DIR "goal" # model-backed against a real directory
 *
 * In `--target` mode every employee is handed the real workspace tools, and QA's
 * evidence comes from the checks it actually ran, so a winning attempt is one
 * that produced a real change and passed the real checks.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactBus } from '../src/company/bus.ts';
import { runCompany } from '../src/company/company.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import type { AgentAction, AgentBrain } from '../src/kernel/loop.ts';
import { ModelService } from '../src/company/model.ts';
import type { TaskTier } from '../src/company/model.ts';
import { modelBrain } from '../src/company/brains.ts';
import { buildRoleTools } from '../src/company/role-tools.ts';

const TARGET_COMMANDS: Record<string, string> = {
  test: 'npm test',
  lint: 'npm run lint',
};

/** A self-contained target so `--target` demonstrates a real pass with no setup. */
function sampleTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-company-target-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample-target', scripts: { test: 'node --test', lint: 'node --check index.js' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), "module.exports = { version: '0.0.0' };\n");
  fs.writeFileSync(path.join(dir, 'index.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\ntest('loads', () => assert.ok(require('./index.js')));\n");
  return dir;
}

/** Role-appropriate demo artifacts, so the demo shows a real winning competition. */
function demoData(id: string, attempt: number): Record<string, unknown> {
  switch (id) {
    case 'pm':
      return { items: ['acceptance criteria 1', 'acceptance criteria 2'] };
    case 'architect':
      return { design: 'a small, reversible change', files: ['src/feature.ts'] };
    case 'implementer':
      return { files: { 'src/feature.ts': `// attempt ${attempt}\nexport const feature = true;\n` } };
    case 'reviewer':
      return { blockers: 0, notes: ['looks correct'] };
    case 'qa':
      return { checks: [{ name: 'test', status: 'PASSED' }, { name: 'lint', status: 'PASSED' }] };
    case 'security':
      return { clean: true, findings: [] };
    case 'release':
      return { ship: true };
    default:
      return {};
  }
}

function scriptedBrain(id: string, attempt: number): AgentBrain {
  const script: AgentAction[] = [
    { tool: 'think', input: { thought: `${id} plans the work` } },
    { tool: 'finish', input: { summary: `${id} completed its mandate`, data: demoData(id, attempt) } },
  ];
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

function scriptedRoster(attempt: number): Role[] {
  return DEFAULT_ROSTER.map((r) => ({
    id: r.id,
    title: r.title,
    mandate: r.mandate,
    authority: r.authority,
    consumes: r.consumes,
    produces: r.produces,
    tools: [{ name: 'think', description: 'noop', run: async () => ({ ok: true, output: 'ok' }) }],
    brain: scriptedBrain(r.id, attempt),
  }));
}

/** An explicit tool sequence per role, so the model executes rather than wanders. */
const ROLE_SEQUENCE: Record<string, string[]> = {
  pm: ['finish with your requirements artifact (data.items = list of acceptance criteria)'],
  architect: ['read_file on the main source file(s)', 'finish with your design artifact (data.design, data.files = list of paths)'],
  implementer: ['read_file on the target file', 'write_file with the new content', 'run_check the "test" command', 'finish with your change artifact (data.summary)'],
  reviewer: ['read_file on the changed file', 'finish with your review artifact (data.blockers = number, data.notes = list)'],
  qa: ['run_check the "test" command', 'run_check the "lint" command', 'finish with your evidence artifact'],
  security: ['read_file on the changed file', 'finish with your security artifact (data.clean = boolean, data.findings = list)'],
  release: ['finish with your decision artifact (data.ship = boolean)'],
};

/**
 * Work tier per role. Easy work — turning a goal into requirements, reviewing a
 * diff, recording evidence, deciding to ship — needs no provider key, so it rides
 * the free keyless routes. Hard work — actually writing the code — may use the
 * configured keys (Rock, Gemini) and fall back to keyless.
 */
const EASY_ROLES = new Set(['pm', 'architect', 'reviewer', 'qa', 'security', 'release']);
function tierForRole(id: string): TaskTier {
  return EASY_ROLES.has(id) ? 'easy' : 'hard';
}

function modelRoster(model: ModelService, attempt: number, workspaceDir: string): Role[] {
  return DEFAULT_ROSTER.map((r) => ({
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
      authorizedCommands: TARGET_COMMANDS,
    }),
    brain: modelBrain(model, {
      role: `${r.title} (attempt ${attempt})`,
      mandate: r.mandate,
      sequence: ROLE_SEQUENCE[r.id],
      artifactHint: `Emit your "${r.produces}" artifact in data.`,
      tier: tierForRole(r.id),
    }),
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useModel = args.includes('--model');
  const wsIdx = args.indexOf('--workspace');
  const explicitTarget = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
  const useTarget = args.includes('--target') || Boolean(explicitTarget);
  const goal = args.filter((a, i) => a !== '--model' && a !== '--target' && a !== '--workspace' && !(wsIdx >= 0 && i === wsIdx + 1)).join(' ').trim() || 'Demonstrate the company on a sample goal.';

  const workspaceDir = useTarget ? explicitTarget ?? sampleTarget() : undefined;
  if (workspaceDir) console.log(`[target] ${workspaceDir}${explicitTarget ? '' : ' (generated sample)'}`);

  const bus = new ArtifactBus();
  const model = useModel ? new ModelService() : null;
  if (model) {
    const info = model.getProviderInfo();
    console.log(`[model] ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);
  }

  const attemptsPerItem = Math.max(1, Number.parseInt(process.env.FORGE_COMPANY_ATTEMPTS ?? '', 10) || 2);
  const result = await runCompany({
    goal,
    bus,
    plan: (g) => [{ id: 'w1', title: g }],
    rosterFor: (_item, attempt) => (model ? modelRoster(model, attempt, workspaceDir ?? process.cwd()) : scriptedRoster(attempt)),
    attemptsPerItem,
    workspaceDir,
    integrate: ({ changes }) => ({ ok: Object.keys(changes).length > 0, reason: Object.keys(changes).length ? `${Object.keys(changes).length} file(s) changed` : 'no change produced' }),
  });

  console.log('--- FORGE COMPANY REPORT ---');
  console.log('Goal:', result.goal);
  console.log('Status:', result.status);
  console.log('Reason:', result.reason);
  console.log('Winners:', result.winners.join(', ') || '(none)');
  console.log('Artifacts:', bus.all().length);
  for (const item of result.items) {
    console.log(`- ${item.item.title}: ${item.competition.reason}`);
    for (const card of item.competition.scorecards) {
      console.log(`    ${card.attempt}: ${card.total} pt(s)${card.eligible ? '' : ' [ineligible]'}`);
    }
  }
  console.log('Changed files:', Object.keys(result.integratedChanges).length ? Object.keys(result.integratedChanges).join(', ') : '(none)');
  console.log('Routing: easy roles (pm, architect, reviewer, qa, security, release) ride keyless; implementer is hard (keys first).');
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
