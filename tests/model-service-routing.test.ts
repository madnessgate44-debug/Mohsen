import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codingKeylessOption } from '../src/services/model-routing-policy.ts';

test('Forge coding prefers configured credentials over rate-limited anonymous routes', () => {
  assert.equal(codingKeylessOption({ GROQ_API_KEY: 'configured' }), 'auto');
  assert.equal(codingKeylessOption({ GEMINI_API_KEY: 'configured' }), 'auto');
});

test('Forge coding remains runnable without configured provider credentials', () => {
  assert.equal(codingKeylessOption({}), true);
});

test('explicit keyless-only mode overrides configured credentials', () => {
  assert.equal(codingKeylessOption({ FIRSTBORN_KEYLESS_ONLY: 'true', GEMINI_API_KEY: 'configured' }), true);
});
