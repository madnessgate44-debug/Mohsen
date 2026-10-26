import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePackageJson,
  extractDepNames,
  isVersionClaim,
  isLockfileClaim,
  satisfiesRange,
  compareVersions,
  groundFindings,
  type VersionGrounder,
} from '../src/company/registry.ts';

const PKG = JSON.stringify({
  dependencies: { vite: '^8.3.0', dotenv: '^17.2.3', '@google/genai': '^2.4.0' },
  devDependencies: { typescript: '^7.0.2' },
});

const deps = parsePackageJson(PKG);
const grounderOf = (map: Record<string, { latest: string; versions: string[] }>): VersionGrounder => ({
  get: (n) => map[n] ?? null,
});

test('registry: parses runtime and dev dependencies', () => {
  assert.equal(deps.length, 4);
  assert.ok(deps.some((d) => d.name === 'typescript' && d.kind === 'dev' && d.range === '^7.0.2'));
  assert.ok(deps.some((d) => d.name === 'vite' && d.kind === 'runtime'));
});

test('registry: malformed package.json yields no dependencies', () => {
  assert.deepEqual(parsePackageJson('not json'), []);
});

test('registry: extracts only exact dependency-name tokens', () => {
  const names = extractDepNames('The typescript version ^7.0.2 looks fine, and vite too', deps);
  assert.deepEqual(names.sort(), ['typescript', 'vite']);
  // A substring like "vitest" must NOT match "vite".
  assert.deepEqual(extractDepNames('vitest is a test runner', deps), []);
});

test('registry: version and lockfile claim detection', () => {
  assert.equal(isVersionClaim('Outdated TypeScript version with known vulnerabilities'), true);
  assert.equal(isVersionClaim('CompanionChatScreen is tightly coupled'), false);
  assert.equal(isLockfileClaim('Missing lockfile for dependency integrity'), true);
  assert.equal(isLockfileClaim('No integration tests in CI'), false);
});

test('registry: semver comparison', () => {
  assert.ok(compareVersions('7.0.2', '5.0.0') > 0);
  assert.equal(compareVersions('8.3.4', '8.3.4'), 0);
  assert.ok(compareVersions('8.3.0', '8.3.4') < 0);
});

test('registry: satisfiesRange settles the real Amina claims', () => {
  const ts = ['5.9.2', '6.0.0-beta', '7.0.1-rc', '7.0.2'];
  const vite = ['6.4.4', '7.3.7', '8.2.4', '8.3.0-beta.1', '8.3.4'];
  const dotenv = ['16.4.5', '17.2.3', '18.0.8'];
  // ^7.0.2 admits the real latest 7.0.2 -> the "outdated/invalid" claim is false.
  assert.equal(satisfiesRange('^7.0.2', ts), true);
  // ^8.3.0 admits the stable 8.3.4 -> current, not invalid.
  assert.equal(satisfiesRange('^8.3.0', vite), true);
  // A range that only a prerelease satisfies does NOT resolve for a stable install.
  assert.equal(satisfiesRange('^8.3.1', ['8.3.0-beta.1', '8.2.4']), false);
  assert.equal(satisfiesRange('^17.2.3', dotenv), true);
  assert.equal(satisfiesRange('^19.0.0', dotenv), false);
  assert.equal(satisfiesRange('*', dotenv), true);
  assert.equal(satisfiesRange('>=16 <18', dotenv), true);
});

test('registry: keeps a finding that merely mentions a dependency name', () => {
  // Regression: this was dropped as a false version claim because it mentions
  // react and "PIN" was matched case-insensitively against the word "pin".
  const findings = [
    {
      severity: 'HIGH',
      title: 'Parent PIN is handled entirely in frontend component state',
      paths: ['src/App.tsx'],
      basis: 'observed' as const,
      evidence: 'The PIN is stored in react state; there is no server-side check.',
      recommendation: 'Move the check to the backend.',
    },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({ react: { latest: '19.3.1', versions: ['19.0.1', '19.3.1'] } }),
    hasLockfile: true,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 1, 'a passing dependency mention must not trigger grounding');
  assert.equal(out.dropped, 0);
});

test('registry: still grounds a finding that claims a version of a named dependency', () => {
  const findings = [
    {
      severity: 'HIGH',
      title: 'Peer dependency version range mismatch for vite',
      paths: ['package.json'],
      basis: 'observed' as const,
      evidence: '"@tailwindcss/vite": "^4.3.3" does not match "vite": "^8.3.0".',
      recommendation: 'Align the vite versions.',
    },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({ vite: { latest: '8.3.4', versions: ['8.3.0', '8.3.4'] } }),
    hasLockfile: true,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 0);
  assert.equal(out.dropped, 1);
  assert.match(out.notes[0], /registry contradicts/i);
});

test('registry: keeps a finding that mentions a lockfile without claiming it is missing', () => {
  // Regression: "Deprecated dependency present in lockfile" was dropped because a
  // lockfile exists, though the finding never claimed one was missing.
  const findings = [
    { severity: 'MEDIUM', title: 'Deprecated dependency present in lockfile', paths: ['package-lock.json'], basis: 'observed' as const, evidence: 'a dependency is deprecated', recommendation: 'update it' },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({}),
    hasLockfile: true,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 1, 'mentioning a lockfile is not a missing-lockfile claim');
  assert.equal(out.dropped, 0);
});

test('registry: keeps a finding that mentions dependencies but makes no version claim', () => {
  // Regression: bare "dependency" used to trigger version grounding, which then
  // dropped a real install-script finding because the dependency resolves fine.
  const findings = [
    { severity: 'HIGH', title: 'Dependency declares postinstall script which may execute arbitrary code on install', paths: ['package.json'], basis: 'observed' as const, evidence: 'a dependency runs a postinstall script', recommendation: 'review it' },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({ typescript: { latest: '7.0.2', versions: ['7.0.2'] } }),
    hasLockfile: true,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 1, 'a non-version finding must survive grounding');
  assert.equal(out.dropped, 0);
});

test('registry: drops a false "outdated" claim the registry contradicts', () => {
  const findings = [
    { severity: 'HIGH', title: 'Invalid TypeScript version specified in devDependencies', paths: ['package.json'], basis: 'observed' as const, evidence: '"typescript": "^7.0.2" is outdated; current stable is 5.x', recommendation: 'downgrade to ^5.0.0' },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({ typescript: { latest: '7.0.2', versions: ['5.9.2', '7.0.2'] } }),
    hasLockfile: false,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 0);
  assert.equal(out.dropped, 1);
  assert.match(out.notes[0], /registry contradicts/i);
});

test('registry: keeps a true "range does not resolve" claim and corrects its evidence', () => {
  const findings = [
    { severity: 'HIGH', title: 'Vite range does not resolve', paths: ['package.json'], basis: 'observed' as const, evidence: '"vite": "^8.3.0" is invalid', recommendation: 'fix the range' },
  ];
  const out = groundFindings(findings, {
    deps,
    registry: grounderOf({ vite: { latest: '8.3.4', versions: ['8.2.4'] } }),
    hasLockfile: false,
    lockfileChecked: true,
  });
  assert.equal(out.findings.length, 1);
  assert.match(out.findings[0].evidence, /resolves to no published version \(latest is 8\.3\.4\)/);
  assert.equal(out.dropped, 0);
});

test('registry: drops a lockfile claim when a lockfile is actually present', () => {
  const findings = [
    { severity: 'HIGH', title: 'Missing lockfile for dependency integrity', paths: ['package.json'], basis: 'observed' as const, evidence: 'no lockfile is present', recommendation: 'add one' },
  ];
  const out = groundFindings(findings, { deps, registry: grounderOf({}), hasLockfile: true, lockfileChecked: true });
  assert.equal(out.findings.length, 0);
  assert.match(out.notes[0], /lockfile IS present/);
});

test('registry: keeps a lockfile claim when no lockfile exists', () => {
  const findings = [
    { severity: 'HIGH', title: 'Missing lockfile for dependency integrity', paths: ['package.json'], basis: 'observed' as const, evidence: 'no lockfile is present', recommendation: 'add one' },
  ];
  const out = groundFindings(findings, { deps, registry: grounderOf({}), hasLockfile: false, lockfileChecked: true });
  assert.equal(out.findings.length, 1);
});

test('registry: findings with no version claim pass through untouched', () => {
  const findings = [
    { severity: 'MEDIUM', title: 'Tight coupling in CompanionChatScreen', paths: ['src/App.tsx'], basis: 'observed' as const, evidence: 'imports many services', recommendation: 'add a facade' },
  ];
  const out = groundFindings(findings, { deps, registry: grounderOf({}), hasLockfile: false, lockfileChecked: true });
  assert.equal(out.findings.length, 1);
  assert.equal(out.dropped, 0);
});
