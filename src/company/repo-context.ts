/**
 * Repository context: read a target repository's inventory and key excerpts.
 *
 * Read-only. Fetches metadata, the file tree, and a bounded set of source/config
 * excerpts at the default branch's head commit. Shared by the audit CLI and the
 * delivery CLI so both look at the same commit the same way.
 */
const TOKEN = process.env.GITHUB_TOKEN || '';
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface RepoContext {
  target: string;
  commit: string;
  files: string[];
  excerpts: Record<string, string>;
}

export async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'forge-company-audit', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function ghText(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
  try {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

const TEST_RE = /(^|\/)(tests?|__tests__|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)(test_)?[^/]*_?test\.py$/i;

/** Fetch the inventory and a representative, bounded set of excerpts. */
export async function fetchRepoContext(target: string): Promise<RepoContext> {
  if (!repoPattern.test(target) || target.includes('..')) throw new Error('target must be an explicit owner/repo value');
  const [owner, repo] = target.split('/');
  const meta = await ghJson(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = meta.default_branch;
  const commit = await ghJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  const files: string[] = tree.tree.filter((i: any) => i.type === 'blob').map((i: any) => i.path);
  const has = (p: string) => files.includes(p);

  const src = files.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|kt|java)$/i.test(p) && !/(^|\/)(node_modules|dist|build)\//.test(p));
  const tests = src.filter((p) => TEST_RE.test(p)).slice(0, 4);
  const source = src.filter((p) => !TEST_RE.test(p)).slice(0, 14);
  const entrypoints = ['server.ts', 'index.js', 'index.ts', 'src/main.tsx', 'src/App.tsx', 'package.json', 'tsconfig.json', 'vite.config.ts'].filter(has);
  const workflows = files.filter((p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p)).slice(0, 5);
  const keyPaths = [...new Set([...entrypoints, ...workflows, ...tests, ...source])].slice(0, 22);
  const excerpts: Record<string, string> = {};
  for (const p of keyPaths) {
    const v = await ghText(owner, repo, p, branch);
    if (v !== null) excerpts[p] = v.slice(0, 4000);
  }
  return { target: meta.full_name, commit: commit.sha, files, excerpts };
}
