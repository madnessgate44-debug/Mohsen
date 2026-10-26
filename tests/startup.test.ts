import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regression guard for the H1 defect: `npm start` must launch a reachable server.
// This exercises the real documented start command, not a hand-built invocation.
test('npm start boots a server that answers /api/health', async () => {
  const port = 34117;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npm, ['start'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });

  const killTree = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  };

  try {
    const deadline = Date.now() + 45_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          const body = await res.json();
          healthy = body.status === 'ONLINE';
        }
      } catch {
        /* not listening yet */
      }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(healthy, true, 'expected /api/health to report ONLINE before timeout');
  } finally {
    killTree();
  }
});
