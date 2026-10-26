/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface GitHubRepoInfo {
  exists: boolean;
  fullName: string;
  defaultBranch: string;
  latestCommitSha: string;
  isPrivate: boolean;
  permissions?: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
  errorMessage?: string;
}

export interface GitHubFileContent {
  path: string;
  sha: string;
  content: string;
}

export class GitHubService {
  private token?: string;

  constructor(token?: string) {
    this.token = token?.trim();
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Firstborn-Forge-Agent',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async inspectRepository(owner: string, repo: string): Promise<GitHubRepoInfo> {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: this.getHeaders(),
      });

      if (res.status === 404) {
        return {
          exists: false,
          fullName: `${owner}/${repo}`,
          defaultBranch: 'main',
          latestCommitSha: 'N/A',
          isPrivate: false,
          errorMessage: 'Repository not found (HTTP 404). It has not been created yet or the token lacks read access.',
        };
      }

      if (!res.ok) {
        const errorText = await res.text();
        return {
          exists: false,
          fullName: `${owner}/${repo}`,
          defaultBranch: 'main',
          latestCommitSha: 'N/A',
          isPrivate: false,
          errorMessage: `GitHub API error (${res.status}): ${errorText}`,
        };
      }

      const data = await res.json();
      
      let latestSha = 'UNKNOWN';
      try {
        const branchRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${data.default_branch}`,
          { headers: this.getHeaders() }
        );
        if (branchRes.ok) {
          const branchData = await branchRes.json();
          latestSha = branchData.sha;
        }
      } catch {
        // Ignored
      }

      return {
        exists: true,
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        latestCommitSha: latestSha,
        isPrivate: data.private,
        permissions: data.permissions,
      };
    } catch (err: any) {
      return {
        exists: false,
        fullName: `${owner}/${repo}`,
        defaultBranch: 'main',
        latestCommitSha: 'N/A',
        isPrivate: false,
        errorMessage: `Network error: ${err.message}`,
      };
    }
  }

  async fetchBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.sha === 'string' ? data.sha : null;
    } catch {
      return null;
    }
  }

  async fetchCommitTreeSha(owner: string, repo: string, commitSha: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits/${commitSha}`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.tree?.sha || null;
    } catch {
      return null;
    }
  }

  async fetchFile(owner: string, repo: string, path: string, ref = 'main'): Promise<GitHubFileContent | null> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return {
        path: data.path,
        sha: data.sha,
        content,
      };
    } catch {
      return null;
    }
  }

  async listRepositoryFiles(owner: string, repo: string, ref = 'main'): Promise<string[]> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (!data.tree || !Array.isArray(data.tree)) return [];
      return data.tree
        .filter((item: any) => item.type === 'blob')
        .map((item: any) => item.path);
    } catch {
      return [];
    }
  }

  /** Create a new isolated branch; never reset or reuse an existing task ref. */
  async createOrUpdateBranch(
    owner: string,
    repo: string,
    branchName: string,
    baseSha: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.token) {
      return { success: false, error: 'Cannot push or branch without a GitHub token.' };
    }
    try {
      // 1. Try to create ref
      const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: baseSha,
        }),
      });

      if (createRes.ok) {
        return { success: true };
      }

      if (createRes.status === 422) {
        const err = await createRes.text();
        return { success: false, error: `BLOCKED: branch ref already exists; refusing to reuse it (HTTP 422): ${err}` };
      }

      const err = await createRes.text();
      return { success: false, error: `Branch creation failed (${createRes.status}): ${err}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Commits files to GitHub using Git Data API with resolved base_tree SHA (Fixes Git tree API bug)
   */
  async commitChangesToBranch(params: {
    owner: string;
    repo: string;
    branchName: string;
    baseCommitSha: string;
    commitMessage: string;
    files: { path: string; content: string }[];
  }): Promise<{ success: boolean; headSha?: string; error?: string }> {
    if (!this.token) {
      return { success: false, error: 'Cannot commit changes without GitHub token.' };
    }

    try {
      // 1. Resolve base commit SHA to base tree SHA
      const baseTreeSha = await this.fetchCommitTreeSha(params.owner, params.repo, params.baseCommitSha);
      if (!baseTreeSha) {
        return { success: false, error: `Failed to resolve tree SHA for base commit ${params.baseCommitSha}` };
      }

      // 2. Create blobs for each file
      const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const file of params.files) {
        const blobRes = await fetch(
          `https://api.github.com/repos/${params.owner}/${params.repo}/git/blobs`,
          {
            method: 'POST',
            headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: file.content,
              encoding: 'utf-8',
            }),
          }
        );
        if (!blobRes.ok) {
          const err = await blobRes.text();
          return { success: false, error: `Failed to create blob for ${file.path}: ${err}` };
        }
        const blobData = await blobRes.json();
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        });
      }

      // 3. Create tree pointing to resolved base tree SHA (NOT commit SHA)
      const treeRes = await fetch(
        `https://api.github.com/repos/${params.owner}/${params.repo}/git/trees`,
        {
          method: 'POST',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: treeItems,
          }),
        }
      );
      if (!treeRes.ok) {
        const err = await treeRes.text();
        return { success: false, error: `Failed to create Git tree: ${err}` };
      }
      const treeData = await treeRes.json();

      // 4. Create commit with parent pointing to base commit SHA
      const commitRes = await fetch(
        `https://api.github.com/repos/${params.owner}/${params.repo}/git/commits`,
        {
          method: 'POST',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: params.commitMessage,
            tree: treeData.sha,
            parents: [params.baseCommitSha],
          }),
        }
      );
      if (!commitRes.ok) {
        const err = await commitRes.text();
        return { success: false, error: `Failed to create commit: ${err}` };
      }
      const commitData = await commitRes.json();

      // 5. Update branch reference to point to new commit
      const refRes = await fetch(
        `https://api.github.com/repos/${params.owner}/${params.repo}/git/refs/heads/${params.branchName}`,
        {
          method: 'PATCH',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sha: commitData.sha,
          }),
        }
      );
      if (!refRes.ok) {
        const err = await refRes.text();
        return { success: false, error: `Failed to update branch reference: ${err}` };
      }

      return { success: true, headSha: commitData.sha };
    } catch (err: any) {
      return { success: false, error: `Commit operation failed: ${err.message}` };
    }
  }

  async openPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<{ success: boolean; url?: string; number?: number; error?: string }> {
    if (!this.token) {
      return { success: false, error: 'Cannot create Pull Request without a GitHub token.' };
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/pulls`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, error: `PR creation failed (${res.status}): ${err}` };
      }

      const pr = await res.json();
      return {
        success: true,
        url: pr.html_url,
        number: pr.number,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
