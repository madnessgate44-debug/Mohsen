import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_ENV_NAMES,
  isKeylessOnly,
  hasProviderKeys,
  resolveKeylessMode,
  keylessOption,
  keylessAllowed,
  applyRoutingPolicy,
} from '../src/model-routing.ts';

// Both engines (src/services/model.ts and src/company/model.ts) must make the
// SAME keyless-vs-keyed decision. These tests pin the shared policy so the two
// paths cannot drift apart again.

test('routing: the keyless lock is recognized case-insensitively', () => {
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'True' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'TRUE' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'true' }), true);
  assert.equal(isKeylessOnly({ FIRSTBORN_KEYLESS_ONLY: 'false' }), false);
  assert.equal(isKeylessOnly({}), false);
});

test('routing: hasProviderKeys is true when any credential is present', () => {
  assert.equal(hasProviderKeys({ GROQ_API_KEY: 'g' }), true);
  assert.equal(hasProviderKeys({ GEMINI_API_KEY: 'k' }), true);
  assert.equal(hasProviderKeys({ GROQ_API_KEY: '   ' }), false);
  assert.equal(hasProviderKeys({}), false);
});

test('routing: hard work with a key uses the keyed providers only', () => {
  // 'auto' tells freelm to add the anonymous Kilo/OVHcloud endpoints only when no
  // key exists. With a key present the pool stays keyed-only, which is what keeps a
  // long sweep off Kilo's ~3-requests-per-minute cap.
  assert.equal(resolveKeylessMode({ GROQ_API_KEY: 'g' }, 'hard'), 'auto');
  assert.equal(resolveKeylessMode({ GEMINI_API_KEY: 'k' }, 'hard'), 'auto');
  assert.equal(keylessOption({ GROQ_API_KEY: 'g' }, 'hard'), 'auto');
});

test('routing: hard work without a key falls back to keyless', () => {
  // There is nothing else to route to, so the anonymous endpoints are the only route.
  assert.equal(resolveKeylessMode({}, 'hard'), 'always');
  assert.equal(resolveKeylessMode({ GROQ_API_KEY: '   ' }, 'hard'), 'always');
  assert.equal(keylessOption({}, 'hard'), true);
});

test('routing: easy work keeps keyless as a last resort even when a key is present', () => {
  assert.equal(resolveKeylessMode({ GROQ_API_KEY: 'g' }, 'easy'), 'always');
  assert.equal(keylessOption({ GROQ_API_KEY: 'g' }, 'easy'), true);
});

test('routing: the strict lock is keyless even for hard work with a key', () => {
  const env = { FIRSTBORN_KEYLESS_ONLY: 'true', GROQ_API_KEY: 'g' };
  assert.equal(resolveKeylessMode(env, 'hard'), 'always');
  assert.equal(keylessOption(env, 'hard'), true);
});

test('routing: the no-argument form stays keyless-tolerant for the services engine', () => {
  // src/services/model.ts calls keylessOption() with no tier and must not change.
  assert.equal(keylessOption({ GROQ_API_KEY: 'g' }), true);
  assert.equal(keylessOption({}), true);
  assert.equal(resolveKeylessMode({ GROQ_API_KEY: 'g' }), 'always');
});

test('routing: keylessAllowed reflects the lock', () => {
  assert.equal(keylessAllowed({}), true);
  assert.equal(keylessAllowed({ FIRSTBORN_KEYLESS_ONLY: 'true' }), false);
});

test('routing: the strict lock strips every provider key and forces keyless', () => {
  const env: NodeJS.ProcessEnv = { FIRSTBORN_KEYLESS_ONLY: 'true', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  const { keyless } = applyRoutingPolicy(env);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.FREELM_KEYLESS, '1');
  assert.equal(keyless, true);
});

test('routing: without the lock, provider keys are left intact', () => {
  const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  applyRoutingPolicy(env);
  assert.equal(env.GROQ_API_KEY, 'g');
  assert.equal(env.GEMINI_API_KEY, 'k');
  assert.equal(env.FREELM_KEYLESS, undefined);
});

test('routing: both engines read the same credential names', () => {
  for (const name of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'KILO_API_KEY']) {
    assert.ok(CREDENTIAL_ENV_NAMES.includes(name), `expected ${name} to be honoured`);
  }
});
