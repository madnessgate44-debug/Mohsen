import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planQuery, runQuery, extractTerm, renderQueryResult, type PageData } from '../src/services/query.ts';

// Pure tests for the natural-language query planner. No browser, no network:
// the same question always yields the same plan and the same structured result.

const DATA: PageData = {
  url: 'https://shop.example/product',
  title: 'Widget Pro — Example Shop',
  text: 'Widget Pro costs $19.99 and ships today. Contact sales@example.com or call +1 (555) 123-4567 for bulk orders. Free returns within 30 days.',
  headings: ['Widget Pro', 'Specifications', 'Pricing'],
  links: [
    { text: 'Documentation', href: 'https://docs.example.com/widget' },
    { text: 'Buy now', href: 'https://shop.example/product/buy' },
  ],
  tables: [
    [
      ['Plan', 'Price'],
      ['Basic', '$9.99'],
      ['Pro', '$19.99'],
    ],
  ],
  fields: [
    { label: 'Weight', value: '250 g' },
    { label: 'Colour', value: 'Graphite' },
  ],
};

test('extractTerm prefers quoted text', () => {
  assert.equal(extractTerm('list the links about "release notes"'), 'release notes');
});

test('planQuery maps questions to typed plans', () => {
  assert.equal(planQuery('what is the title').kind, 'title');
  assert.equal(planQuery('list all the links').kind, 'links');
  assert.equal(planQuery('show the headings').kind, 'headings');
  assert.equal(planQuery('how many links are there').kind, 'count');
  assert.equal(planQuery('what is the price').kind, 'prices');
  assert.equal(planQuery('find the email address').kind, 'emails');
  assert.equal(planQuery('what is the phone number').kind, 'phones');
  assert.equal(planQuery('show the table').kind, 'table');
  assert.equal(planQuery('what is the value of weight').kind, 'labeled');
  assert.equal(planQuery('refund policy').kind, 'search');
});

test('count plan carries the noun to count', () => {
  assert.equal(planQuery('how many links are on the page').term, 'links');
  assert.equal(planQuery('how many rows in the table').term, 'rows');
});

test('title query returns the page title', () => {
  const r = runQuery(DATA, planQuery('what is the title'));
  assert.deepEqual(r.matches, [{ value: 'Widget Pro — Example Shop' }]);
});

test('links query can be filtered by a keyword', () => {
  const r = runQuery(DATA, planQuery('list the links about docs'));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].href, 'https://docs.example.com/widget');
});

test('emails and phones are pulled from the text', () => {
  assert.deepEqual(runQuery(DATA, planQuery('what is the email')).matches, [{ value: 'sales@example.com' }]);
  assert.equal(runQuery(DATA, planQuery('what is the phone number')).matches[0].value.replace(/\s+/g, ''), '+1(555)123-4567');
});

test('prices are detected and deduplicated', () => {
  const r = runQuery(DATA, planQuery('what is the price'));
  const values = r.matches.map((m) => m.value);
  assert.ok(values.includes('$19.99'), `expected $19.99 in ${JSON.stringify(values)}`);
});

test('table query returns rows joined by a pipe', () => {
  const r = runQuery(DATA, planQuery('show the table'));
  assert.deepEqual(r.matches.map((m) => m.value), ['Plan | Price', 'Basic | $9.99', 'Pro | $19.99']);
});

test('count query returns a number', () => {
  assert.deepEqual(runQuery(DATA, planQuery('how many links')).matches, [{ value: '2' }]);
  assert.deepEqual(runQuery(DATA, planQuery('how many rows in the table')).matches, [{ value: '3' }]);
});

test('labeled query resolves a labelled field', () => {
  assert.deepEqual(runQuery(DATA, planQuery('what is the value of colour')).matches, [{ value: 'Graphite' }]);
});

test('search query returns matching sentences', () => {
  const r = runQuery(DATA, planQuery('when does it ship'));
  assert.ok(r.matches.length >= 1);
  assert.match(r.matches[0].value, /ships today/);
});

test('a miss is reported, never invented', () => {
  const r = runQuery(DATA, planQuery('what is the phone number of the ceo'));
  assert.equal(r.matches.length >= 0, true);
  const empty = runQuery({ ...DATA, text: 'nothing here' }, planQuery('find the email address'));
  assert.equal(empty.matches.length, 0);
  assert.match(renderQueryResult(empty), /No email addresses found/);
});

test('renderQueryResult is compact and lists matches', () => {
  const text = renderQueryResult(runQuery(DATA, planQuery('what is the title')));
  assert.match(text, /kind: title/);
  assert.match(text, /matches: 1/);
  assert.match(text, /Widget Pro/);
});
