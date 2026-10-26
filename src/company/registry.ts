/**
 * Version grounding: never let an audit assert dependency currency from model memory.
 *
 * Free models carry stale training data, so they confidently call a current version
 * "outdated" and invent "known vulnerabilities" (e.g. claiming TypeScript 5.x is the
 * latest when 7.0.2 is). This module resolves the real truth from the npm registry and
 * either corrects or drops any finding that makes a version claim.
 *
 * Pure helpers are separated from the one network call so the logic is unit-testable.
 */

export interface ParsedDep {
  name: string;
  range: string;
  /** 'runtime' for dependencies, 'dev' for devDependencies. */
  kind: 'runtime' | 'dev';
}

export interface RegistryVersions {
  latest: string;
  versions: string[];
}

/** Known package-manager lockfiles; used to settle "missing lockfile" claims. */
export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
];

/**
 * True when a version-claim word appears in the same sentence as the dependency
 * name. Grounding used to fire on any finding that mentioned a dependency and a
 * claim word anywhere in its text, so "Parent PIN is handled in frontend state"
 * was dropped as a false version claim because it mentioned react.
 */
function claimsVersionOf(text: string, name: string): boolean {
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);
  const nameRe = new RegExp(`(^|[^\\w@/-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w@/-]|$)`);
  return sentences.some((s) => nameRe.test(s) && hasClaimWord(s));
}

/**
 * Words that signal a finding is making a claim about dependency versions.
 * Bare "dependency"/"dependencies" is deliberately excluded: it matched findings
 * about install scripts and production bundling, which assert nothing about a
 * version, and grounding then dropped them as false version claims.
 */
const CLAIM_RE =
  /\b(version|versions|outdated|unsupported|invalid|obsolete|vulnerab\w*|upgrade|update|downgrade|deprecat\w*|stale|eol|end[- ]of[- ]life|latest|semver|resolve[sd]?|valid)\b/i;

/**
 * "pin"/"pinned" is matched case-sensitively on purpose: uppercase PIN is a
 * personal identification number, not a version-pinning claim, and matching it
 * dropped a real finding about frontend PIN handling.
 */
const PIN_RE = /\bpin(ned|ning)?\b/;

/** True when a sentence makes a claim about a dependency version. */
function hasClaimWord(sentence: string): boolean {
  return CLAIM_RE.test(sentence) || PIN_RE.test(sentence);
}

/** Parse `dependencies` and `devDependencies` from a package.json excerpt. */
export function parsePackageJson(text: string): ParsedDep[] {
  let pkg: any;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const out: ParsedDep[] = [];
  for (const [kind, key] of [
    ['runtime', 'dependencies'],
    ['dev', 'devDependencies'],
  ] as const) {
    const deps = pkg?.[key];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string') out.push({ name, range, kind });
    }
  }
  return out;
}

/** The package names a finding refers to, by exact token match (never substring). */
export function extractDepNames(text: string, deps: ParsedDep[]): string[] {
  const tokens = new Set((text.toLowerCase().match(/@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?/g) ?? []));
  return deps.filter((d) => tokens.has(d.name.toLowerCase())).map((d) => d.name);
}

/** Does the finding text quote the declared version range (e.g. "^7.0.2")? */
export function mentionsDeclaredRange(text: string, deps: ParsedDep[]): boolean {
  return deps.some((d) => text.includes(d.range));
}

/** True when a finding is making a claim about dependency versions at all. */
export function isVersionClaim(text: string): boolean {
  return CLAIM_RE.test(text);
}

/** True when the finding is about a lockfile rather than a package version. */
export function isLockfileClaim(text: string): boolean {
  return /lock\s*-?\s*file|package-lock|yarn\.lock|pnpm-lock/i.test(text);
}

/**
 * True when the finding asserts a lockfile is missing, not merely mentions one.
 * Without this, "Deprecated dependency present in lockfile" was dropped because
 * a lockfile exists — the claim was never that one was missing.
 */
export function isMissingLockfileClaim(text: string): boolean {
  return isLockfileClaim(text) && /\b(missing|absent|no|not|without|uncommitted|lacks?|lacking|omit\w*)\b/i.test(text);
}

/** Compare two semver-ish strings, ignoring build metadata and leading zeros. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [av, bv] = [norm(a), norm(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Does `range` (npm semver) admit at least one published `version`?
 * Covers `*`, `x`, `latest`, `^`, `~`, `>`, `>=`, `<`, `<=`, `=`, and exact/partial
 * versions, plus `||` unions and ` - ` hyphen ranges. Prereleases are only admitted
 * when the range itself names one.
 */
export function satisfiesRange(range: string, versions: string[]): boolean {
  const pool = range.includes('-') ? versions : versions.filter((v) => !v.includes('-'));
  if (!pool.length) return false;
  return range.split('||').some((part) => part.trim() && satisfiesSimple(part.trim(), pool));
}

function satisfiesSimple(range: string, versions: string[]): boolean {
  const hyp = range.split(/\s+-\s+/);
  if (hyp.length === 2) {
    return versions.some((v) => compareVersions(v, hyp[0].trim()) >= 0 && compareVersions(v, hyp[1].trim()) <= 0);
  }
  const checks = range.split(/\s+/).filter(Boolean);
  return versions.some((v) => checks.every((c) => checkOne(c, v)));
}

function checkOne(op: string, v: string): boolean {
  if (op === '*' || op === 'x' || op === 'latest') return true;
  const m = op.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/);
  if (!m) return true;
  const [, sign = '=', raw] = m;
  const target = raw.replace(/\.[x*]/gi, '.0').replace(/(^|\.)[x*]/gi, '$10');
  if (sign === '^') {
    const base = target.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const lower = `${base[0]}.${base[1]}.${base[2]}`;
    const upper = base[0] > 0 ? `${base[0] + 1}.0.0` : base[1] > 0 ? `0.${base[1] + 1}.0` : `0.0.${base[2] + 1}`;
    return compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0;
  }
  if (sign === '~') {
    const base = target.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const lower = `${base[0]}.${base[1]}.${base[2]}`;
    const upper = `${base[0]}.${base[1] + 1}.0`;
    return compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0;
  }
  const d = compareVersions(v, target);
  if (sign === '>=') return d >= 0;
  if (sign === '<=') return d <= 0;
  if (sign === '>') return d > 0;
  if (sign === '<') return d < 0;
  return d === 0;
}

export interface VersionGrounder {
  get(name: string): RegistryVersions | null;
}

export interface GroundOutcome {
  /** Findings that survived (possibly with a corrected evidence line). */
  findings: { severity: string; title: string; paths: string[]; basis: 'observed' | 'inferred'; evidence: string; recommendation: string }[];
  /** One line per dropped/corrected finding, for transparency in the report. */
  notes: string[];
  /** Findings dropped because their version claim was false. */
  dropped: number;
}

/**
 * Ground every finding that makes a version claim against the registry:
 * - "outdated / has vulnerabilities / update to X" with the declared range still
 *   admissible -> the claim is false; drop it.
 * - "invalid / unsupported / won't install" with no admissible version -> true;
 *   keep it but replace the evidence with the resolved fact.
 * Findings with no version claim pass through untouched.
 */
export function groundFindings(
  findings: { severity: string; title: string; paths: string[]; basis: 'observed' | 'inferred'; evidence: string; recommendation: string }[],
  opts: { deps: ParsedDep[]; registry: VersionGrounder; hasLockfile: boolean; lockfileChecked: boolean }
): GroundOutcome {
  const notes: string[] = [];
  const out: GroundOutcome['findings'] = [];
  let dropped = 0;

  for (const f of findings) {
    const text = `${f.title} ${f.evidence} ${f.recommendation}`;
    const names = extractDepNames(text, opts.deps);

    if (opts.lockfileChecked && isMissingLockfileClaim(text) && !names.length) {
      if (opts.hasLockfile) {
        dropped += 1;
        notes.push(`Dropped "${f.title}": a lockfile IS present in the repository.`);
        continue;
      }
      out.push(f);
      continue;
    }

    if (!names.length || !isVersionClaim(text)) {
      out.push(f);
      continue;
    }

    // Ground only the dependencies the finding actually makes a version claim
    // about. A passing mention of react in a state-management finding must not
    // make that finding droppable as a version claim.
    const claimed = names.filter((n) => claimsVersionOf(text, n));
    if (!claimed.length) {
      out.push(f);
      continue;
    }

    let corrected: string | null = null;
    let falseClaim = false;
    let undetermined = false;
    for (const name of claimed) {
      const dep = opts.deps.find((d) => d.name === name)!;
      const reg = opts.registry.get(name);
      if (!reg) {
        undetermined = true;
        continue;
      }
      const ok = satisfiesRange(dep.range, reg.versions);
      if (ok) {
        falseClaim = true;
      } else {
        const line = `${dep.name}@${dep.range} resolves to no published version (latest is ${reg.latest}).`;
        corrected = corrected ? `${corrected} ${line}` : line;
      }
    }

    if (falseClaim) {
      dropped += 1;
      const detail = claimed
        .map((n) => {
          const d = opts.deps.find((x) => x.name === n)!;
          const r = opts.registry.get(n);
          return r ? `${n}@${d.range} (latest ${r.latest})` : n;
        })
        .join(', ');
      notes.push(`Dropped "${f.title}": the registry contradicts the claim — ${detail} is current/admissible.`);
      continue;
    }
    if (corrected) {
      out.push({ ...f, evidence: corrected });
      continue;
    }
    if (undetermined) {
      dropped += 1;
      notes.push(`Dropped "${f.title}": its version claim could not be verified against the registry.`);
      continue;
    }
    out.push(f);
  }
  return { findings: out, notes, dropped };
}

/** Fetch the published versions of a package from the npm registry. */
export async function fetchRegistryVersions(name: string, timeoutMs = 8000): Promise<RegistryVersions | null> {
  const url = `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2F') : name}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data: any = await res.json();
    const versions = Object.keys(data?.versions ?? {});
    const latest = typeof data?.['dist-tags']?.latest === 'string' ? data['dist-tags'].latest : versions[versions.length - 1];
    if (!latest) return null;
    return { latest, versions };
  } catch {
    return null;
  }
}

/** Resolve the registry versions of every dependency referenced by any finding. */
export async function buildRegistryGrounder(
  deps: ParsedDep[],
  texts: string[]
): Promise<VersionGrounder> {
  const names = new Set<string>();
  for (const t of texts) for (const n of extractDepNames(t, deps)) names.add(n);
  const map = new Map<string, RegistryVersions>();
  await Promise.all(
    [...names].map(async (n) => {
      const v = await fetchRegistryVersions(n);
      if (v) map.set(n, v);
    })
  );
  return { get: (n: string) => map.get(n) ?? null };
}

/**
 * Download the exact-commit source as a tarball and parse it into a file map.
 * Read-only: it never checks out or runs the target's code.
 */
export async function fetchRepoCorpus(
  target: string,
  commit: string,
  timeoutMs = 30000
): Promise<Record<string, string> | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target) || target.includes('..')) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${target}/tarball/${commit}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'forge-company-audit',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const gz = Buffer.from(await res.arrayBuffer());
    const { parseTarGz } = await import('./evidence.ts');
    return parseTarGz(gz);
  } catch {
    return null;
  }
}
