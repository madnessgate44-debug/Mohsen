/**
 * forge-company audit CLI — the software company performs a read-only audit.
 *
 *   npm run audit -- madnessgate44-debug/Amina
 *   npm run audit -- --full madnessgate44-debug/Amina
 *
 * The default path drives the real company engine: one work item per audit lens,
 * competing attempts, judged on evidence (a mandatory rule is that every finding
 * cites a path that exists). Read-only; it never clones or executes the target's
 * code.
 *
 * `--full` reads the *entire* repository: every tracked text file is chunked and
 * examined, and the report states its own coverage (files examined / total). It
 * costs one model call per chunk, so it is slower than the sampled path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModelService } from '../src/company/model.ts';
import { runCompanyAudit } from '../src/company/audit-company.ts';
import { fetchRepoContext } from '../src/company/repo-context.ts';
import { fetchRepoCorpus } from '../src/company/registry.ts';
import { runFullCoverageAudit } from '../src/company/sweep.ts';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const target = (args.find((a) => !a.startsWith('--')) || '').trim();
  if (!repoPattern.test(target) || target.includes('..')) {
    console.error('usage: npm run audit -- [--full] owner/repo');
    process.exitCode = 2;
    return;
  }

  const model = new ModelService();
  const info = model.getProviderInfo();

  if (full) {
    const ctx = await fetchRepoContext(target);
    console.log(`[audit:full] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; ${ctx.files.length} files`);
    console.log(`[audit:full] model: ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);
    const corpus = await fetchRepoCorpus(target, ctx.commit);
    const result = await runFullCoverageAudit({
      model,
      target: ctx.target,
      commit: ctx.commit,
      corpus,
      onChunk: ({ id, index, count, ok, provider, model }) =>
        console.log(`[audit:full] ${id} ${index}/${count} ${ok ? 'ok' : 'FAILED'}${ok ? ` via ${provider}/${model}` : ''}`),
      onRole: ({ role, verdict }) => console.log(`[audit:full] verify ${role} ${verdict}`),
    });
    const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'company-audit-full.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, 'company-audit-full.md'), result.markdown + '\n');
    console.log('\n--- FULL-COVERAGE AUDIT REPORT ---');
    console.log('Status:', result.status, '|', result.reason);
    console.log(
      `Coverage: ${result.coverage.examinedFiles}/${result.coverage.totalFiles} files (${result.coverage.percent}%); ` +
        `${result.coverage.succeededChunks}/${result.coverage.totalChunks} chunks answered; ${result.coverage.failedChunks} failed`
    );
    console.log(`Routes used: ${result.routesUsed.map((r) => `${r.provider}/${r.model} (${r.chunks})`).join('; ') || '(none)'}`);
    console.log('\n' + result.markdown);
    // Any status other than COMPLETED is a degraded run: fail the step so CI and a
    // reader both see it, instead of a green check over a partial read.
    if (result.status !== 'COMPLETED') process.exitCode = 1;
    return;
  }

  const ctx = await fetchRepoContext(target);
  console.log(`[audit] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; ${ctx.files.length} files; ${Object.keys(ctx.excerpts).length} excerpts`);
  console.log(`[audit] model: ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);

  const attempts = Math.max(1, Number.parseInt(process.env.FORGE_AUDIT_ATTEMPTS ?? '', 10) || 2);
  const result = await runCompanyAudit({ model, ctx, attemptsPerItem: attempts, providerInfo: info });

  console.log('\n--- COMPANY AUDIT REPORT ---');
  console.log('Status:', result.status, '|', result.reason);
  console.log('Winners:', result.winners.join(', ') || '(none)');
  for (const e of result.employees) console.log(`- ${e.title}: ${e.success ? `winner ${e.model}` : `FAILED (${e.note})`}`);
  console.log('Integrated findings:', result.findings.length);

  const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'company-audit.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'company-audit.md'), result.markdown + '\n');
  console.log('\n' + result.markdown);
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company audit] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
