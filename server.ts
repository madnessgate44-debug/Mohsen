/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { RequestHandler } from 'express';
import { ForgeAgent } from './src/agent/forge.ts';
import { GitHubService } from './src/services/github.ts';
import { ModelService } from './src/services/model.ts';
import { TestRunnerService } from './src/services/test-runner.ts';
import * as fs from 'fs/promises';
import * as path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// In-memory reports store for current session
const reportsStore = new Map<string, any>();

const requireGitHubToken: RequestHandler = async (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ error: 'A valid GitHub token is required for this operation.' });
    return;
  }
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Firstborn-Forge',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      res.status(401).json({ error: 'GitHub rejected the supplied token. No task was run.' });
      return;
    }
    const user = (await response.json()) as { login?: string };
    const allowedLogins = (process.env.FORGE_ALLOWED_LOGINS || 'madnessgate44-debug')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!user.login || !allowedLogins.includes(user.login.toLowerCase())) {
      res.status(403).json({ error: 'This GitHub account is not authorized for Forge.' });
      return;
    }
    next();
  } catch {
    res.status(503).json({ error: 'Could not validate the GitHub token. No task was run.' });
  }
};

// Helper to sanitize task IDs and prevent directory traversal (Fix F-05)
function sanitizeTaskId(rawId: string): string {
  const sanitized = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return sanitized || `task-${Date.now()}`;
}

const allowedRepos = (process.env.FORGE_ALLOWED_REPOS || 'madnessgate44-debug/Firstborn')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAllowedRepo = (r: unknown) => typeof r === 'string' && allowedRepos.includes(r.toLowerCase());

function getRequestToken(req: { headers: { authorization?: string } }): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || undefined;
}

// 1. Health & Capability inspection
app.get('/api/health', (req, res) => {
  const modelService = new ModelService();
  res.json({
    status: 'ONLINE',
    project: 'Firstborn',
    agent: 'Forge',
    version: '1.1.0',
    model: modelService.getProviderInfo(),
    environment: {
      nodeVersion: process.version,
    },
  });
});

// 2. Inspect Target Repository
app.get('/api/github/inspect', requireGitHubToken, async (req, res) => {
  const target = (req.query.repo as string) || 'madnessgate44-debug/Firstborn';
  const token = getRequestToken(req);
  const [owner, repo] = target.split('/');

  if (!owner || !repo) {
    return res.status(400).json({ error: 'Invalid repo query parameter. Expected owner/repo.' });
  }
  if (!isAllowedRepo(target)) return res.status(403).json({ error: 'Repository not allowed.' });

  const github = new GitHubService(token);
  const info = await github.inspectRepository(owner, repo);
  res.json(info);
});

// 3. Submit and execute a Task through Forge
app.post('/api/tasks/run', requireGitHubToken, async (req, res) => {
  const { id, title, description, targetRepo, targetBranch, allowPrCreation } = req.body;
  const token = getRequestToken(req);

  const taskId = sanitizeTaskId(id || `task-${Date.now()}`);
  const repoToRun = targetRepo || 'madnessgate44-debug/Firstborn';
  if (!isAllowedRepo(repoToRun)) return res.status(403).json({ error: 'Repository not allowed.' });
  const agent = new ForgeAgent(token);

  const report = await agent.executeTask({
    id: taskId,
    title,
    description,
    targetRepo: repoToRun,
    targetBranch: targetBranch || 'main',
    createdAt: new Date().toISOString(),
    author: 'operator-mobile',
    allowPrCreation: Boolean(allowPrCreation),
  });

  reportsStore.set(taskId, report);

  // Save report to disk as persistent evidence in .firstborn/evidence/<taskId>.json
  try {
    const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(
      path.join(evidenceDir, `${taskId}.json`),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
  } catch (err: any) {
    console.error('Failed to write local evidence file:', err.message);
  }

  res.json(report);
});

// 4. Retrieve Task Reports
app.get('/api/tasks/:id', requireGitHubToken, (req, res) => {
  const safeId = sanitizeTaskId(req.params.id);
  const report = reportsStore.get(safeId);
  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }
  res.json(report);
});

// 5. Run explicit bounded verification check
app.post('/api/verify/check', requireGitHubToken, async (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }
  const runner = new TestRunnerService();
  const result = await runner.runCheck(command);
  res.json(result);
});

// 6. Read COORDINATION.md contents
app.get('/api/coordination', async (req, res) => {
  try {
    const content = await fs.readFile(path.resolve(process.cwd(), 'COORDINATION.md'), 'utf-8');
    res.json({ content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend in production
app.use(express.static(path.resolve(process.cwd(), 'dist')));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Firstborn server running on port ${PORT}`);
});
