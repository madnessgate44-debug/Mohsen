import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The runnable same-repository entrypoint is replicate-firstborn.yml. The exact
// source Forge workflow is retained under replica-source because this repository's
// Actions token cannot push workflow-file changes into executable .github/workflows/.

const activeWorkflow = readFileSync(new URL('../.github/workflows/replicate-firstborn.yml', import.meta.url), 'utf8');
const sourceWorkflow = readFileSync(new URL('../replica-source/.github/workflows/forge.yml', import.meta.url), 'utf8');

/** Extract the env block for a named step from a workflow's text. */
function envBlockForStep(yml: string, stepName: string): string {
  const start = yml.indexOf(`- name: ${stepName}`);
  assert.ok(start >= 0, `step "${stepName}" not found`);
  const rest = yml.slice(start);
  const next = rest.indexOf('\\n      - name:', 1);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('the runnable Forge job passes keyed providers and does not force keyless-only', () => {
  const env = envBlockForStep(activeWorkflow, 'Run Forge Agent');
  assert.match(env, /GROQ_API_KEY:/, 'coding job must pass GROQ_API_KEY');
  assert.match(env, /GEMINI_API_KEY:/, 'coding job must pass GEMINI_API_KEY');
  assert.doesNotMatch(env, /FIRSTBORN_KEYLESS_ONLY:\\s*'?true'?/, 'coding job must not force keyless-only');
});

test('the preserved source audit job passes keyed providers', () => {
  const env = envBlockForStep(sourceWorkflow, 'Run read-only repository audit');
  assert.match(env, /GROQ_API_KEY:/);
  assert.match(env, /GEMINI_API_KEY:/);
});

test('the company audit workflow exposes the full-coverage switch and uploads its report', () => {
  const audit = readFileSync(new URL('../.github/workflows/company-audit.yml', import.meta.url), 'utf8');
  assert.match(audit, /full:/, 'workflow must expose a full input');
  assert.match(audit, /FORGE_AUDIT_FULL:/, 'workflow must pass the full flag');
  assert.match(audit, /scripts\/audit\.ts --full/, 'workflow must run the full sweep when asked');
  assert.match(audit, /company-audit-full\.md/, 'workflow must upload the full report');
});
