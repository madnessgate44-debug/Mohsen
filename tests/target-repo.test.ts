import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetRepo } from '../src/agent/target-repo.ts';

test('repository target defaults to the workflow repository', () => {
  assert.equal(resolveTargetRepo(undefined, 'madnessgate44-debug/Firstborn'), 'madnessgate44-debug/Firstborn');
});

test('explicit Amina target is preserved exactly and never falls back', () => {
  assert.equal(resolveTargetRepo('madnessgate44-debug/Amina', 'madnessgate44-debug/Firstborn'), 'madnessgate44-debug/Amina');
});

test('invalid target URLs and extra path segments are rejected', () => {
  assert.throws(() => resolveTargetRepo('https://github.com/madnessgate44-debug/Amina', 'madnessgate44-debug/Firstborn'), /BLOCKED/);
  assert.throws(() => resolveTargetRepo('madnessgate44-debug/Amina/tree/main', 'madnessgate44-debug/Firstborn'), /BLOCKED/);

test('empty repository target is rejected', () => {
  assert.throws(() => resolveTargetRepo('', ''), /BLOCKED/);
});
});
