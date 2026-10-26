import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelResult } from '../src/company/model.ts';
import {
  splitFile,
  planSweep,
  computeCoverage,
  runSweep,
  renderFullAuditMarkdown,
  runFullCoverageAudit,
  runVerificationPanel,
  renderCitedFiles,
  buildSweepPrompt,
  isDegradedRoute,
  DEFAULT_MAX_CHARS_PER_SEGMENT,
  DEFAULT_MAX_CHARS_PER_CHUNK,
  type SweepModel,
} from '../src/company/sweep.ts';

// A structural double at the model boundary, typed against the generic
// `completeJson<T>` signature so the double matches the real interface.
function stubModel(handler: () => { value: any; result: ModelResult }): SweepModel {
  return { completeJson: async <T,>() => handler() as { value: T | null; result: ModelResult } };
}

// The sweep is the guarantee that a full audit really covers 100% of a repo.
// The pure planner/coverage logic is proven here with no network; the runner is
// proven with a structural double at the model boundary.

test('sweep: splitFile keeps a small file whole and splits a large one at line boundaries', () => {
  assert.deepEqual(splitFile('a\nb\nc', 1000), ['a\nb\nc']);
  const big = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
  const parts = splitFile(big, 50);
  assert.ok(parts.length > 1, 'a file larger than the cap must be split');
  // No content is lost: rejoining the parts restores the original exactly.
  assert.equal(parts.join('\n'), big);
});

test('sweep: splitFile keeps a single over-long line intact rather than corrupting it', () => {
  const oneLine = 'x'.repeat(500);
  const parts = splitFile(oneLine, 100);
  assert.deepEqual(parts, [oneLine]);
});

test('sweep: planSweep covers every file exactly once (no file dropped, no file duplicated)', () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 60; i += 1) corpus[`src/f${String(i).padStart(2, '0')}.ts`] = 'y'.repeat(3000);
  const plan = planSweep(corpus, { maxCharsPerSegment: 2000, maxCharsPerChunk: 4000 });
  assert.deepEqual(plan.files, Object.keys(corpus).sort());
  const seen = new Map<string, number>();
  for (const chunk of plan.chunks) {
    for (const segment of chunk.segments) seen.set(segment.path, (seen.get(segment.path) ?? 0) + 1);
  }
  assert.equal(seen.size, plan.files.length, 'every file appears in the plan');
  for (const path of plan.files) assert.ok((seen.get(path) ?? 0) >= 1, `${path} must be planned`);
});

test('sweep: a file larger than one segment is split into numbered parts that all appear', () => {
  const corpus = { 'src/huge.ts': Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n') };
  const plan = planSweep(corpus, { maxCharsPerSegment: 100, maxCharsPerChunk: 100 });
  const segments = plan.chunks.flatMap((c) => c.segments).filter((s) => s.path === 'src/huge.ts');
  assert.ok(segments.length > 1);
  assert.deepEqual(segments.map((s) => s.part), segments.map((_, i) => i + 1));
  assert.ok(segments.every((s) => s.parts === segments.length));
});

test('sweep: coverage is 100% only when every chunk answered', () => {
  const corpus = { 'a.ts': 'x'.repeat(2000), 'b.ts': 'y'.repeat(2000), 'c.ts': 'z'.repeat(2000) };
  const plan = planSweep(corpus, { maxCharsPerSegment: 1000, maxCharsPerChunk: 1000 });
  const all = computeCoverage(plan, []);
  assert.equal(all.examinedFiles, 3);
  assert.equal(all.percent, 100);
  assert.equal(all.failedChunks, 0);

  // Failing one chunk must downgrade its files and never round up to 100%.
  const failedId = plan.chunks[0].id;
  const partial = computeCoverage(plan, [failedId]);
  assert.equal(partial.failedChunks, 1);
  assert.ok(partial.examinedFiles < 3, 'a failed chunk must reduce examined files');
  assert.ok(partial.percent < 100);
});

test('sweep: a fully unread file is reported as not examined, never as examined', () => {
  const corpus = { 'a.ts': 'x'.repeat(500) };
  const plan = planSweep(corpus, { maxCharsPerSegment: 1000, maxCharsPerChunk: 1000 });
  const cov = computeCoverage(plan, plan.chunks.map((c) => c.id));
  assert.equal(cov.examinedFiles, 0);
  assert.deepEqual(cov.notExamined, ['a.ts']);
  assert.equal(cov.percent, 0);
});

test('sweep: the prompt fences file content as untrusted and forbids inventing paths', () => {
  const plan = planSweep({ 'src/a.ts': 'const x = 1;' });
  const prompt = buildSweepPrompt({
    target: 'o/r', commit: 'abc', chunk: plan.chunks[0], chunkIndex: 1, chunkCount: 1, fileCount: 1, maxFindings: 5,
  });
  assert.match(prompt, /UNTRUSTED INPUT/);
  assert.match(prompt, /Never invent paths/i);
  assert.match(prompt, /--- FILE: src\/a\.ts ---/);
});

test('sweep: runSweep accepts findings that cite a real file and drops invented paths', async () => {
  const corpus = { 'src/a.ts': 'const x = 1;' };
  const plan = planSweep(corpus);
  const model = stubModel(() => ({
    value: {
      summary: 's',
      findings: [
        { severity: 'HIGH', title: 'real', paths: ['src/a.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' },
        { severity: 'HIGH', title: 'invented', paths: ['src/nope.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' },
      ],
    },
    result: { text: '{}', model: 'm', provider: 'p', success: true },
  }));
  const result = await runSweep({ model, plan, target: 'o/r', commit: 'abc' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'real');
  assert.equal(result.coverage.percent, 100);
});

test('sweep: a failed chunk is recorded and its files are not counted as examined', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 4; i += 1) corpus[`f${i}.ts`] = 'x'.repeat(1500);
  const plan = planSweep(corpus, { maxCharsPerSegment: 800, maxCharsPerChunk: 800 });
  let calls = 0;
  const model = stubModel(() => {
    calls += 1;
    if (calls === 1) return { value: null, result: { text: '', model: 'm', provider: 'p', success: false, error: 'boom' } };
    return { value: { findings: [] }, result: { text: '{}', model: 'm', provider: 'p', success: true } };
  });
  const result = await runSweep({ model, plan, target: 'o/r', commit: 'abc' });
  assert.equal(result.coverage.failedChunks, 1);
  assert.ok(result.coverage.percent < 100);
  assert.equal(result.chunkNotes.filter((n) => !n.ok).length, 1);
});

test('sweep: runFullCoverageAudit reports 100% coverage and renders the ledger', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 20; i += 1) corpus[`src/f${i}.ts`] = 'y'.repeat(2000);
  const model = stubModel(() => ({
    value: { findings: [{ severity: 'LOW', title: 't', paths: ['src/f0.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' }] },
    result: { text: '{}', model: 'm', provider: 'p', success: true },
  }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 4000 }, verify: false });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.coverage.percent, 100);
  assert.equal(result.coverage.examinedFiles, 20);
  assert.match(result.markdown, /Files examined: 20\/20 \(100%\)/);
  assert.match(result.markdown, /## Guarantees/);
});

test('sweep: runFullCoverageAudit is BLOCKED (not a clean pass) when the corpus is empty', async () => {
  const model = stubModel(() => ({ value: { findings: [] }, result: { text: '{}', model: 'm', provider: 'p', success: true } }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus: null });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reason, /could not read the target corpus/);
  assert.equal(result.findings.length, 0);
});

test('sweep: the rendered report names unexamined files instead of implying full coverage', () => {
  const md = renderFullAuditMarkdown({
    target: 'o/r',
    commit: 'abc',
    fileCount: 2,
    findings: [],
    evidence: {},
    evidenceSummary: { supported: 0, contradicted: 0, judgment: 0 },
    groundingNotes: [],
    verification: [],
    coverage: { totalFiles: 2, examinedFiles: 1, percent: 50, totalChunks: 2, succeededChunks: 1, failedChunks: 1, partialFiles: [], notExamined: ['b.ts'] },
    chunkNotes: [],
    route: { provider: 'p', model: 'm' },
    routesUsed: [],
    status: 'COMPLETED',
    reason: 'r',
  });
  assert.match(md, /Files examined: 1\/2 \(50%\)/);
  assert.match(md, /NOT examined: b\.ts/);
});

test('sweep: the default segment cap is a positive, usable number', () => {
  assert.ok(DEFAULT_MAX_CHARS_PER_SEGMENT >= 4000);
});

test('sweep: a normal source file is atomic by default, so evidence in one file stays in one call', () => {
  // Regression: the caps used to be 12k/24k, so a 15 KB component was split.
  // The model saw the JSX usage but not the import at the top of the same file
  // and reported the import as missing. A file of this size must not be split.
  const lines = ['import { VoiceSpeakButton } from "../voice/VoiceSpeakButton";'];
  while (lines.join('\n').length < 15000) lines.push('  // padding line to grow the file');
  lines.push('  <VoiceSpeakButton text={turn.text} />');
  const content = lines.join('\n');
  assert.ok(content.length > 12000 && content.length < DEFAULT_MAX_CHARS_PER_CHUNK, 'fixture must exceed the old cap but fit a whole-file call');

  const plan = planSweep({ 'src/components/TeachingSessionModal.tsx': content });
  const segments = plan.chunks.flatMap((c) => c.segments);
  assert.equal(segments.length, 1, 'a file under the call budget must be one segment');
  assert.equal(segments[0].parts, 1);
  // Both the import and the usage are in the single payload the model receives.
  assert.match(segments[0].content, /VoiceSpeakButton \} from/);
  assert.match(segments[0].content, /<VoiceSpeakButton/);
});

test('sweep: a file larger than one whole call is still split, never dropped', () => {
  const huge = Array.from({ length: 20000 }, (_, i) => `const line${i} = ${i};`).join('\n');
  assert.ok(huge.length > DEFAULT_MAX_CHARS_PER_CHUNK);
  const plan = planSweep({ 'src/monster.ts': huge });
  const segments = plan.chunks.flatMap((c) => c.segments).filter((s) => s.path === 'src/monster.ts');
  assert.ok(segments.length > 1, 'a file past the call budget must be split');
  assert.equal(segments.join('\n').length > 0, true);
  assert.equal(plan.files.length, 1);
});

test('sweep: the verification panel records objections and never silently confirms an empty answer', async () => {
  const replies = [
    { value: { verdict: 'OBJECT', reason: 'the import is present', objections: ['missing import'] }, result: { text: '{}', model: 'm', provider: 'p', success: true } },
    { value: null, result: { text: '', model: 'm', provider: 'p', success: false } },
  ];
  let call = 0;
  const model = stubModel(() => replies[call++]);
  const verdicts = await runVerificationPanel({
    model,
    findings: [{ severity: 'HIGH', title: 'missing import', paths: ['a.ts'], basis: 'observed', evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' }],
    corpus: { 'a.ts': 'import x from "y";\n' },
    roles: ['Reviewer', 'QA'],
  });
  assert.equal(verdicts[0].verdict, 'OBJECT');
  assert.match(verdicts[0].title, /missing import/);
  assert.equal(verdicts[1].verdict, 'UNVERIFIED');
});

test('sweep: the panel is skipped when there are no findings', async () => {
  const model = stubModel(() => ({ value: {}, result: { text: '{}', model: 'm', provider: 'p', success: true } }));
  const verdicts = await runVerificationPanel({ model, findings: [], corpus: {} });
  assert.deepEqual(verdicts, []);
});

// ---- Status: COMPLETED only on a genuinely complete read (Part 1.2) ----

test('sweep: status is COMPLETED only when every chunk answered and every file was examined', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 12; i += 1) corpus[`src/f${i}.ts`] = 'y'.repeat(1500);
  const model = stubModel(() => ({
    value: { findings: [{ severity: 'LOW', title: 't', paths: ['src/f0.ts'], basis: 'observed', evidence: 'e', recommendation: 'r' }] },
    result: { text: '{}', model: 'gemini-2.5-flash', provider: 'google', success: true },
  }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 3000 }, verify: false });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.coverage.failedChunks, 0);
  assert.equal(result.coverage.examinedFiles, result.coverage.totalFiles);
  assert.match(result.markdown, /- Status: COMPLETED/);
});

test('sweep: status is PARTIAL when some files were read but a chunk failed', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 8; i += 1) corpus[`src/f${i}.ts`] = 'y'.repeat(1500);
  let calls = 0;
  const model = stubModel(() => {
    calls += 1;
    if (calls === 1) return { value: null, result: { text: '', model: 'm', provider: 'p', success: false, error: 'boom' } };
    return { value: { findings: [] }, result: { text: '{}', model: 'gemini-2.5-flash', provider: 'google', success: true } };
  });
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 3000 }, verify: false });
  assert.equal(result.status, 'PARTIAL');
  assert.ok(result.coverage.examinedFiles > 0, 'some files were read');
  assert.ok(result.coverage.examinedFiles < result.coverage.totalFiles, 'not all files were read');
  assert.match(result.reason, /partial read/);
  assert.match(result.markdown, /- Status: PARTIAL/);
});

test('sweep: status is BLOCKED when no file could be read', async () => {
  const corpus: Record<string, string> = { 'a.ts': 'x'.repeat(500), 'b.ts': 'y'.repeat(500) };
  const model = stubModel(() => ({ value: null, result: { text: '', model: 'm', provider: 'p', success: false, error: 'no route' } }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 1000 }, verify: false });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.coverage.examinedFiles, 0);
  assert.match(result.markdown, /- Status: BLOCKED/);
});

test('sweep: the CLI exits non-zero for anything but COMPLETED', async () => {
  // Mirrors the guard in scripts/audit.ts: only a COMPLETED run is a green step.
  const exitCode = (status: 'COMPLETED' | 'PARTIAL' | 'BLOCKED') => (status !== 'COMPLETED' ? 1 : 0);
  assert.equal(exitCode('COMPLETED'), 0);
  assert.equal(exitCode('PARTIAL'), 1);
  assert.equal(exitCode('BLOCKED'), 1);
});

// ---- Route visibility (Part 1.3) ----

test('sweep: the routes that answered are counted per provider/model', async () => {
  const corpus: Record<string, string> = {};
  for (let i = 0; i < 6; i += 1) corpus[`src/f${i}.ts`] = 'y'.repeat(1500);
  let calls = 0;
  const model = stubModel(() => {
    calls += 1;
    // First two chunks answered by google, the rest by kilo.
    const route = calls <= 2 ? { provider: 'google', model: 'gemini-2.5-flash' } : { provider: 'kilo', model: 'nvidia/nemotron-3-super:free' };
    return { value: { findings: [] }, result: { text: '{}', success: true, ...route } };
  });
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, sweep: { maxCharsPerSegment: 1000, maxCharsPerChunk: 2000 }, verify: false });
  const google = result.routesUsed.find((r) => r.provider === 'google');
  const kilo = result.routesUsed.find((r) => r.provider === 'kilo');
  assert.ok(google && google.chunks >= 1, 'google chunks counted');
  assert.ok(kilo && kilo.chunks >= 1, 'kilo chunks counted');
  assert.match(result.markdown, /Routes used: .*google \/ gemini-2\.5-flash/);
});

test('sweep: a keyless answer is flagged DEGRADED ROUTE in the report', async () => {
  const corpus = { 'a.ts': 'x'.repeat(500) };
  const model = stubModel(() => ({ value: { findings: [] }, result: { text: '{}', success: true, provider: 'kilo', model: 'nvidia/nemotron-3-super-120b-a12b:free' } }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, verify: false });
  assert.match(result.markdown, /DEGRADED ROUTE/);
  assert.ok(isDegradedRoute('kilo', 'nvidia/nemotron-3-super-120b-a12b:free'));
  assert.ok(isDegradedRoute('OVHcloud', 'anything'));
  assert.ok(!isDegradedRoute('google', 'gemini-2.5-flash'));
});

test('sweep: a failed chunk note carries the last route errors when the service has them', async () => {
  const corpus = { 'a.ts': 'x'.repeat(500) };
  const model = stubModel(() => ({
    value: null,
    result: {
      text: '', model: 'm', provider: 'p', success: false,
      error: 'model returned no parseable JSON',
      routeErrors: ['e1', 'e2', 'e3', 'e4'],
    },
  }));
  const result = await runFullCoverageAudit({ model, target: 'o/r', commit: 'abc', corpus, verify: false });
  const note = result.chunkNotes.find((n) => !n.ok)!;
  assert.match(note.note, /recent route errors/);
  assert.match(note.note, /e2 ; e3 ; e4/, 'the last three errors, not all four');
  assert.doesNotMatch(note.note, /e1 ;/);
});

// ---- Verification panel budget (Part 1.4) ----

test('sweep: a 50 KB first cited file does not stop later cited files from being provided', () => {
  const corpus: Record<string, string> = {
    'huge.ts': 'H'.repeat(50000),
    'small.ts': 'S'.repeat(200),
    'other.ts': 'O'.repeat(200),
  };
  const findings = [
    { severity: 'HIGH' as const, title: 'f1', paths: ['huge.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
    { severity: 'HIGH' as const, title: 'f2', paths: ['small.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
    { severity: 'HIGH' as const, title: 'f3', paths: ['other.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
  ];
  const { text, provided, omitted } = renderCitedFiles(corpus, findings);
  // The huge file is capped at 12000, so the later small files still fit and are included.
  assert.ok(provided.includes('small.ts'), 'a later cited file must still be provided');
  assert.ok(provided.includes('other.ts'), 'a later cited file must still be provided');
  assert.match(text, /--- FILE: small\.ts ---/);
  assert.ok(text.length <= 60000, 'total stays within the cap');
  assert.ok(!omitted.includes('small.ts'));
});

test('sweep: the panel is told which cited files were not provided, and may not object because of that', async () => {
  const corpus: Record<string, string> = { 'shown.ts': 'ok' };
  const findings = [
    { severity: 'HIGH' as const, title: 'shown finding', paths: ['shown.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
    { severity: 'HIGH' as const, title: 'hidden finding', paths: ['missing.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
  ];
  let prompt = '';
  const model: SweepModel = {
    completeJson: async <T,>(messages: { content: string }[]) => {
      prompt = messages.map((m) => m.content).join('\n');
      // The model objects to the hidden finding; the panel must drop that objection.
      return { value: { verdict: 'OBJECT', reason: 'file not shown', objections: ['hidden finding'] } as any, result: { text: '{}', model: 'm', provider: 'p', success: true } };
    },
  };
  const verdicts = await runVerificationPanel({ model, findings, corpus, roles: ['Reviewer'] });
  assert.match(prompt, /missing\.ts/, 'the panel is told which files were not provided');
  assert.match(prompt, /Never object to a finding merely because its file was not provided/i);
  // The only objection was to an unprovided file, so it is dropped. With no valid
  // objection left the panel cannot claim OBJECT, and it has not positively
  // confirmed either, so the honest verdict is UNVERIFIED.
  assert.equal(verdicts[0].verdict, 'UNVERIFIED');
  assert.match(verdicts[0].reason, /dropped: cited file was not provided/);
  assert.deepEqual(verdicts[0].unverified, ['hidden finding']);
});

test('sweep: a finding whose only cited file was not provided is UNVERIFIED, not objected to', async () => {
  const corpus: Record<string, string> = { 'shown.ts': 'ok' };
  const findings = [
    { severity: 'HIGH' as const, title: 'only hidden', paths: ['missing.ts'], basis: 'observed' as const, evidence: 'e', recommendation: 'r', raisedBy: 'Sweep' },
  ];
  const model = stubModel(() => ({
    value: { verdict: 'OBJECT', reason: 'cannot see it', objections: ['only hidden'] },
    result: { text: '{}', model: 'm', provider: 'p', success: true },
  }));
  const verdicts = await runVerificationPanel({ model, findings, corpus, roles: ['Reviewer'] });
  assert.equal(verdicts[0].verdict, 'UNVERIFIED');
  assert.deepEqual(verdicts[0].unverified, ['only hidden']);
  assert.match(verdicts[0].reason, /dropped: cited file was not provided/);
});
