/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'child_process';
import { TestExecutionResult } from '../types/agent.ts';

// Fixed list of strictly whitelisted executables and authorized arguments (no shell, no eval)
export interface SafeCommandSpec {
  executable: string;
  args: string[];
}

export const AUTHORIZED_COMMANDS: Record<string, SafeCommandSpec> = {
  'npm install': { executable: 'npm', args: ['install', '--ignore-scripts'] },
  'npm run lint': { executable: 'npm', args: ['run', 'lint'] },
  'npm run test': { executable: 'npm', args: ['run', 'test'] },
  'npm test': { executable: 'npm', args: ['test'] },
  'npm run build': { executable: 'npm', args: ['run', 'build'] },
  'npm run model:smoke': { executable: 'npm', args: ['run', 'model:smoke'] },
  'npx tsc --noEmit': { executable: 'npx', args: ['tsc', '--noEmit'] },
  'git status': { executable: 'git', args: ['status', '--short'] },
  'git diff': { executable: 'git', args: ['diff'] },
  'git diff --check': { executable: 'git', args: ['diff', '--check'] },
};

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'];
function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true' };
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  return env;
}

export class TestRunnerService {
  async runCheck(commandKey: string, cwd = process.cwd()): Promise<TestExecutionResult> {
    const trimmed = commandKey.trim();
    const startTime = Date.now();

    const spec = AUTHORIZED_COMMANDS[trimmed];
    if (!spec) {
      return {
        command: trimmed,
        exitCode: 126, // Command Invocation blocked by security policy
        stdout: '',
        stderr: `Security Boundary Violation: Command "${trimmed}" is not in the strict fixed command registry. Shell evaluation and arbitrary script arguments are prohibited. Allowed commands: ${Object.keys(
          AUTHORIZED_COMMANDS
        ).join(', ')}`,
        durationMs: 0,
        status: 'ERROR',
      };
    }

    return new Promise<TestExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';

      // spawn directly without shell: true to prevent command injection, piping, and shell metacharacter expansion
      const child = spawn(spec.executable, spec.args, {
        cwd,
        shell: false,
        env: buildSafeEnv(),
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({
          command: trimmed,
          exitCode: 124, // Timeout
          stdout,
          stderr: stderr + '\nExecution timed out (npm install: 180000ms; other commands: 45000ms)',
          durationMs: Date.now() - startTime,
          status: 'ERROR',
        });
      }, trimmed === 'npm install' ? 180000 : 45000);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command: trimmed,
          exitCode: 1,
          stdout,
          stderr: stderr + `\nProcess spawn error: ${err.message}`,
          durationMs: Date.now() - startTime,
          status: 'ERROR',
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = typeof code === 'number' ? code : 1;
        resolve({
          command: trimmed,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          status: exitCode === 0 ? 'PASSED' : 'FAILED',
        });
      });
    });
  }
}
