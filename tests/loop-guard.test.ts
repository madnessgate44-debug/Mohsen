import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardRepeatedReadOnly } from '../src/services/model.ts';

// Pure guard used by the loop brain to stop a model from spinning on the same
// read-only action. No network or model call, so these are deterministic.

test('a first read-only action is passed through unchanged', () => {
  const action = { tool: 'search', input: { pattern: 'foo' } };
  const result = guardRepeatedReadOnly(action, []);
  assert.deepEqual(result, action);
});

test('a repeated read-only action is replaced with a think nudge', () => {
  const action = { tool: 'search', input: { pattern: 'foo' } };
  const history = [{ action: { tool: 'search', input: { pattern: 'foo' } } }];
  const result = guardRepeatedReadOnly(action, history);
  assert.equal(result.tool, 'think');
  assert.match(String(result.input?.thought), /Already ran/);
});

test('a read-only action with different input is not considered repeated', () => {
  const action = { tool: 'search', input: { pattern: 'bar' } };
  const history = [{ action: { tool: 'search', input: { pattern: 'foo' } } }];
  assert.deepEqual(guardRepeatedReadOnly(action, history), action);
});

test('a repeated mutating action is never altered', () => {
  const action = { tool: 'edit_file', input: { path: 'a.ts' } };
  const history = [{ action: { tool: 'edit_file', input: { path: 'a.ts' } } }];
  assert.deepEqual(guardRepeatedReadOnly(action, history), action);
});

test('a repeated think is nudged with a different thought', () => {
  const action = { tool: 'think', input: { thought: 'x' } };
  const history = [{ action: { tool: 'think', input: { thought: 'x' } } }];
  const result = guardRepeatedReadOnly(action, history);
  assert.equal(result.tool, 'think');
  assert.notEqual(result.input?.thought, 'x');
});
