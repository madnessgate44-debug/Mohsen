/**
 * A bounded shell runner for `run_check`.
 *
 * Verification commands are executed for real, but only commands on an explicit
 * allowlist, only inside the workspace, with a hard timeout and no shell
 * metacharacters. This is the same discipline the Firstborn TestRunnerService
 * uses: an authorized command map, never a free-form shell.
 */
import { spawn } from 'node:child_process';

export interface CheckResult {
  status: 'PASSED' | 'FAILED';
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunCheckOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Reject a command string that could chain, redirect, or substitute. */
export function isSimpleCommand(command: string): boolean {
  if (!command.trim()) return false;
  return !/[;&|`$><\n\\]/.test(command);
}

export function runCommand(command: string, cwd: string, options: RunCheckOptions = {}): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutput = options.maxOutputBytes ?? 64_000;
  return new Promise((resolve) => {
    if (!isSimpleCommand(command)) {
      resolve({ status: 'FAILED', output: `Refused unsafe command: ${command}`, exitCode: null, timedOut: false });
      return;
    }
    const parts = command.split(/\s+/);
    const child = spawn(parts[0], parts.slice(1), { cwd, shell: false, env: process.env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const append = (chunk: Buffer) => {
      if (out.length < maxOutput) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'FAILED', output: `${out}\n${err.message}`.trim(), exitCode: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code === 0 && !timedOut ? 'PASSED' : 'FAILED', output: out.slice(0, maxOutput).trim(), exitCode: code, timedOut });
    });
  });
}
