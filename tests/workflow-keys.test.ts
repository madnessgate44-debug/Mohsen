import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A workflow-contract guard: both the coding job and the audit job must run with
// the keyed providers. The coding job previously set FIRSTBORN_KEYLESS_ONLY=true,
// which strips every provider key and made the keyless route return empty plans
// ("Empty patch: No file changes proposed."). This test fails if that regresses.

const yml = readFileSync(new URL('../.github/workflows/forge.yml', import.meta.url), 'utf8');

/** Extract the `env:` block that follows a given step name, up to the next step. */
function envBlockForStep(stepName: string): string {
  const start = yml.indexOf(`- name: ${stepName}`);
  assert.ok(start >= 0, `step "${stepName}" not found`);
  const rest = yml.slice(start);
  const next = rest.indexOf('\n      - name:', 1);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('the coding job runs with the keyed providers, not the keyless lock', () => {
  const env = envBlockForStep('Run Forge Agent');
  assert.match(env, /GROQ_API_KEY:/, 'coding job must pass GROQ_API_KEY');
  assert.match(env, /GEMINI_API_KEY:/, 'coding job must pass GEMINI_API_KEY');
  assert.doesNotMatch(env, /FIRSTBORN_KEYLESS_ONLY:\s*'?true'?/, 'coding job must not force keyless-only');
});

test('the audit job still runs with the keyed providers', () => {
  const env = envBlockForStep('Run read-only repository audit');
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
