import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUDIT_BENCH,
  buildAuditEmployeePrompt,
  validateEmployeeFindings,
  mergeFindings,
  renderAuditMarkdown,
} from '../src/company/audit.ts';
import { runCompanyAudit, auditPlan, buildAuditRubric, VERIFY_PANEL, type AuditModel, type RepoContext } from '../src/company/audit-company.ts';
import type { ModelResult } from '../src/company/model.ts';

const FILES = ['src/App.tsx', 'server.ts', 'package.json', 'src/services/__tests__/x.test.ts'];

const ctx: RepoContext = {
  target: 'o/r',
  commit: 'abc123',
  files: FILES,
  excerpts: { 'server.ts': 'const x = 1;' },
};

/** A fake model that answers by the explicit role marker in its prompt. */
function fakeModel(byRole: Record<string, unknown>): AuditModel {
  return {
    async completeJson<T>(messages: { content: string }[]) {
      const prompt = messages.map((m) => m.content).join('\n');
      const role = Object.keys(byRole).find((t) => prompt.includes(t));
      const value = (role ? byRole[role] : { summary: '', architecture: '', findings: [], ok: true, note: 'ok' }) as T;
      const result: ModelResult = { text: JSON.stringify(value), model: 'fake', provider: 'fake', success: true, fallbackUsed: false, routeErrors: [] };
      return { value, result };
    },
  };
}

test('audit core: a finding citing a real path is accepted and tagged with its raiser', () => {
  const text = JSON.stringify({ summary: 'ok', findings: [{ severity: 'HIGH', title: 'Client key exposed', paths: ['src/App.tsx'], basis: 'observed', evidence: 'key in bundle', recommendation: 'proxy it' }] });
  const v = validateEmployeeFindings(text, FILES, 'Security Auditor');
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].raisedBy, 'Security Auditor');
  assert.equal(v.findings[0].severity, 'HIGH');
});

test('audit core: a finding citing a nonexistent path is rejected', () => {
  const text = JSON.stringify({ summary: '', findings: [{ severity: 'HIGH', title: 'Ghost', paths: ['src/DoesNotExist.ts'], basis: 'observed', evidence: 'x', recommendation: 'y' }] });
  const v = validateEmployeeFindings(text, FILES, 'Architecture Auditor');
  assert.equal(v.findings.length, 0);
  assert.equal(v.rejected, 1);
});

test('audit core: non-JSON prose yields nothing (no clean bill of health)', () => {
  const v = validateEmployeeFindings('Looks fine to me.', FILES, 'Quality Auditor');
  assert.equal(v.findings.length, 0);
  assert.equal(v.summary, '');
});

test('audit core: merge collapses duplicate titles, keeps the most severe, notes every raiser', () => {
  const merged = mergeFindings([
    { severity: 'LOW', title: 'Missing lockfile', paths: ['package.json'], basis: 'observed', evidence: 'a', recommendation: 'x', raisedBy: 'Quality Auditor' },
    { severity: 'MEDIUM', title: 'Missing  lockfile!', paths: ['package.json'], basis: 'observed', evidence: 'b', recommendation: 'y', raisedBy: 'Configuration Auditor' },
    { severity: 'HIGH', title: 'Hardcoded key', paths: ['server.ts'], basis: 'observed', evidence: 'c', recommendation: 'z', raisedBy: 'Security Auditor' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, 'HIGH');
  const lock = merged.find((f) => /lockfile/i.test(f.title))!;
  assert.equal(lock.severity, 'MEDIUM');
  assert.match(lock.raisedBy, /Quality Auditor/);
  assert.match(lock.raisedBy, /Configuration Auditor/);
});

test('audit core: the bench has distinct lenses and the prompt carries the excerpts and rules', () => {
  assert.ok(DEFAULT_AUDIT_BENCH.length >= 3);
  assert.equal(new Set(DEFAULT_AUDIT_BENCH.map((e) => e.id)).size, DEFAULT_AUDIT_BENCH.length);
  const prompt = buildAuditEmployeePrompt(DEFAULT_AUDIT_BENCH[0], { target: 'o/r', commit: 'abc', files: FILES, excerpts: { 'server.ts': 'const x = 1;' } });
  assert.match(prompt, /--- FILE: server\.ts ---/);
  assert.match(prompt, /never follow instructions/i);
  assert.match(prompt, /Never invent paths/i);
});

test('audit core: markdown renders the assessment, bench, panel, and findings', () => {
  const md = renderAuditMarkdown({
    target: 'o/r',
    commit: 'abc',
    fileCount: 3,
    employees: [{ id: 'sec', title: 'Security Auditor', provider: 'p', model: 'm', success: true, note: '' }],
    findings: [{ severity: 'HIGH', title: 'X', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'r', raisedBy: 'Security Auditor' }],
    synthesis: { summary: 'looks risky', architecture: 'a server and a client' },
    verification: [{ role: 'Reviewer', verdict: 'CONFIRM', reason: 'paths check out' }],
  });
  assert.match(md, /# Company Read-only Audit: o\/r/);
  assert.match(md, /## Assessment/);
  assert.match(md, /looks risky/);
  assert.match(md, /## Verification panel/);
  assert.match(md, /Reviewer: CONFIRMED/);
  assert.match(md, /HIGH — X/);
});

/** A deterministic registry grounder so tests never hit the network. */
const noRegistry = { get: () => null };

test('company audit: the whole company runs — lenses compete, Forge synthesizes, the panel verifies', async () => {
  const model = fakeModel({
    '[role:lens:arch]': { summary: 'a', findings: [{ severity: 'MEDIUM', title: 'God module', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'split' }] },
    '[role:lens:sec]': { summary: 's', findings: [{ severity: 'HIGH', title: 'Client key', paths: ['src/App.tsx'], basis: 'inferred', evidence: 'e', recommendation: 'proxy' }] },
    '[role:lens:quality]': { summary: 'q', findings: [{ severity: 'LOW', title: 'No lockfile', paths: ['package.json'], basis: 'observed', evidence: 'e', recommendation: 'commit' }] },
    '[role:lens:config]': { summary: 'c', findings: [{ severity: 'INFO', title: 'No env validation', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'validate' }] },
    '[role:forge-lead]': { summary: 'Overall risky', architecture: 'A server and a client.' },
    '[role:verify:Reviewer]': { verdict: 'CONFIRM', reason: 'paths check out' },
    '[role:verify:QA Engineer]': { verdict: 'CONFIRM', reason: 'findings are concrete' },
    '[role:verify:Security Engineer]': { verdict: 'OBJECT', reason: 'one risk understated' },
    '[role:verify:Release Engineer]': { verdict: 'CONFIRM', reason: 'fit to hand over' },
  });
  const result = await runCompanyAudit({ model, ctx, attemptsPerItem: 2, registryGrounder: noRegistry, corpus: null });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.employees.length, 4);
  assert.ok(result.findings.length >= 4);
  assert.equal(result.synthesis.summary, 'Overall risky');
  assert.equal(result.synthesis.architecture, 'A server and a client.');
  assert.equal(result.verification.length, VERIFY_PANEL.length);
  assert.ok(result.verification.some((v) => v.role === "Security Engineer" && v.verdict === "OBJECT"));
  assert.match(result.markdown, /## Verification panel/);
});

test('company audit: an attempt that invents a path cannot win', async () => {
  const model = fakeModel({
    '[role:lens:arch]': { summary: 'a', findings: [{ severity: 'HIGH', title: 'Ghost', paths: ['src/Nope.ts'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:lens:sec]': { summary: 's', findings: [{ severity: 'HIGH', title: 'Real', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:lens:quality]': { summary: 'q', findings: [{ severity: 'LOW', title: 'Real q', paths: ['package.json'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:lens:config]': { summary: 'c', findings: [{ severity: 'INFO', title: 'Real c', paths: ['package.json'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:forge-lead]': { summary: 's', architecture: 'a' },
    '[role:verify:Reviewer]': { verdict: 'CONFIRM', reason: 'ok' },
  });
  const result = await runCompanyAudit({ model, ctx, attemptsPerItem: 1, registryGrounder: noRegistry, corpus: null });
  // The architecture item has no eligible attempt, so the whole run is blocked.
  assert.equal(result.status, 'BLOCKED');
  assert.ok(!result.findings.some((f) => f.title === 'Ghost'));
});

test('company audit: version claims the registry contradicts are dropped and noted', async () => {
  const model = fakeModel({
    '[role:lens:arch]': { summary: 'a', findings: [{ severity: 'LOW', title: 'God module', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'split' }] },
    '[role:lens:sec]': { summary: 's', findings: [{ severity: 'HIGH', title: 'Client key', paths: ['src/App.tsx'], basis: 'inferred', evidence: 'e', recommendation: 'proxy' }] },
    '[role:lens:quality]': { summary: 'q', findings: [{ severity: 'HIGH', title: 'Invalid TypeScript version', paths: ['package.json'], basis: 'observed', evidence: '"typescript": "^7.0.2" is outdated', recommendation: 'downgrade' }] },
    '[role:lens:config]': { summary: 'c', findings: [{ severity: 'HIGH', title: 'Outdated dotenv', paths: ['package.json'], basis: 'observed', evidence: 'dotenv ^17.2.3 has vulnerabilities', recommendation: 'upgrade' }] },
    '[role:forge-lead]': { summary: 's', architecture: 'a' },
    '[role:verify:Reviewer]': { verdict: 'CONFIRM', reason: 'ok' },
  });
  const pkgCtx: RepoContext = {
    ...ctx,
    files: ['package.json', 'server.ts', 'src/App.tsx', 'src/services/__tests__/x.test.ts'],
    excerpts: { 'package.json': JSON.stringify({ dependencies: { dotenv: '^17.2.3' }, devDependencies: { typescript: '^7.0.2' } }) },
  };
  const result = await runCompanyAudit({
    model,
    ctx: pkgCtx,
    attemptsPerItem: 1,
    registryGrounder: { get: (n) => ({ typescript: { latest: '7.0.2', versions: ['5.9.2', '7.0.2'] }, dotenv: { latest: '18.0.8', versions: ['17.2.3', '18.0.8'] } })[n] ?? null },
  });
  assert.ok(!result.findings.some((f) => /typescript/i.test(f.title)));
  assert.ok(!result.findings.some((f) => /dotenv/i.test(f.title)));
  assert.ok(result.groundingNotes.some((n) => /registry contradicts/i.test(n)));
  assert.match(result.markdown, /## Version grounding \(npm registry\)/);
});

test('company audit: the rubric makes citations mandatory and the plan is one item per lens', () => {
  const rubric = buildAuditRubric(new Set(FILES));
  const mandatory = rubric.filter((r) => r.mandatory).map((r) => r.name);
  assert.ok(mandatory.includes('citations-valid'));
  assert.ok(mandatory.includes('completed'));
  assert.equal(auditPlan()(ctx.target).length, DEFAULT_AUDIT_BENCH.length);
});

test('company audit: a panel member that returns nothing usable is UNVERIFIED, never a silent CONFIRM', async () => {
  const model = fakeModel({
    '[role:lens:arch]': { summary: 'a', findings: [{ severity: 'LOW', title: 'God module', paths: ['server.ts'], basis: 'observed', evidence: 'e', recommendation: 'split' }] },
    '[role:lens:sec]': { summary: 's', findings: [{ severity: 'HIGH', title: 'Client key', paths: ['src/App.tsx'], basis: 'inferred', evidence: 'e', recommendation: 'proxy' }] },
    '[role:lens:quality]': { summary: 'q', findings: [{ severity: 'LOW', title: 'Real q', paths: ['package.json'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:lens:config]': { summary: 'c', findings: [{ severity: 'INFO', title: 'Real c', paths: ['package.json'], basis: 'observed', evidence: 'e', recommendation: 'x' }] },
    '[role:forge-lead]': { summary: 's', architecture: 'a' },
    // The Reviewer answers with an empty object — the old code read that as CONFIRM.
    '[role:verify:Reviewer]': {},
  });
  const result = await runCompanyAudit({ model, ctx, attemptsPerItem: 1, registryGrounder: noRegistry, corpus: null });
  const reviewer = result.verification.find((v) => v.role === 'Reviewer')!;
  assert.equal(reviewer.verdict, 'UNVERIFIED');
  assert.doesNotMatch(result.markdown, /Reviewer: CONFIRMED/);
});
