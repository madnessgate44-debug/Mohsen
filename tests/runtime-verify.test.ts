import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTarget,
  buildSafeEnv,
  ALLOWED_COMMANDS,
  runIsolatedRuntimeVerify,
} from '../src/agent/runtime-verify.ts';

describe('runtime-verify', () => {
  it('rejects malformed or traversing targets', () => {
    assert.equal(validateTarget('').ok, false);
    assert.equal(validateTarget('../evil/repo').ok, false);
    assert.equal(validateTarget('owner/repo/../other').ok, false);
    assert.equal(validateTarget('not-a-repo').ok, false);
    const ok = validateTarget('madnessgate44-debug/Firstborn');
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.owner, 'madnessgate44-debug');
      assert.equal(ok.repo, 'Firstborn');
    }
  });

  it('builds an environment with no secrets or write tokens', () => {
    const poisoned: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/tmp',
      GITHUB_TOKEN: 'ghp_should_never_appear',
      GEMINI_API_KEY: 'secret-gemini',
      GROQ_API_KEY: 'secret-groq',
      FORGE_DELIVER_TOKEN: 'secret-deliver',
      OPENAI_API_KEY: 'secret-openai',
      AWS_SECRET_ACCESS_KEY: 'secret-aws',
    };
    const safe = buildSafeEnv(poisoned);
    assert.equal(safe.GITHUB_TOKEN, undefined);
    assert.equal(safe.GEMINI_API_KEY, undefined);
    assert.equal(safe.GROQ_API_KEY, undefined);
    assert.equal(safe.FORGE_DELIVER_TOKEN, undefined);
    assert.equal(safe.OPENAI_API_KEY, undefined);
    assert.equal(safe.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(safe.npm_config_ignore_scripts, 'true');
    assert.ok(safe.PATH);
  });

  it('exposes only allow-listed commands', () => {
    const names = ALLOWED_COMMANDS.map((c) => c.name);
    assert.deepEqual(names, ['install', 'lint', 'test', 'build']);
    for (const entry of ALLOWED_COMMANDS) {
      assert.equal(entry.args[0], 'npm');
      assert.ok(!entry.args.includes('start'));
      assert.ok(!entry.args.some((a) => /deploy|publish|login/i.test(a)));
    }
  });

  it('fails closed on invalid target without executing anything', async () => {
    const report = await runIsolatedRuntimeVerify({
      target: '../evil',
      commitSha: 'abc1234',
    });
    assert.equal(report.overall, 'BLOCKED');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].status, 'BLOCKED');
    assert.ok(report.guarantees.some((g) => /No target code executed/i.test(g)));
  });

  it('fails closed on non-hex commit SHA', async () => {
    const report = await runIsolatedRuntimeVerify({
      target: 'madnessgate44-debug/Firstborn',
      commitSha: 'not-a-sha',
    });
    assert.equal(report.overall, 'BLOCKED');
    assert.equal(report.checks[0].name, 'validate-commit');
  });
});
