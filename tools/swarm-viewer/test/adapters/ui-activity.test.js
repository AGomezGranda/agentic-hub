import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, keepNewestPerNode, offsetLabel, progressOf } from '../../src/adapters/inbound/ui/activity.js';

const rows = (nodeKey, count) => Array.from({ length: count }, (_, n) => ({ nodeKey, n }));
const labels = (items) => items.map((item) => `${item.nodeKey}${item.n}`);

describe('keepNewestPerNode (UI activity cap)', () => {
  test('an early node keeps its own newest rows when a later node has more rows overall', () => {
    const kept = keepNewestPerNode([...rows('scout', 5), ...rows('review', 5)], 3);
    assert.deepEqual(labels(kept), ['scout2', 'scout3', 'scout4', 'review2', 'review3', 'review4']);
  });

  test('rows under the cap are kept in arrival order', () => {
    assert.deepEqual(labels(keepNewestPerNode([...rows('a', 2), ...rows('b', 1)], 5)), ['a0', 'a1', 'b0']);
  });

  test('interleaved rows keep arrival order across nodes', () => {
    const items = [{ nodeKey: 'a', n: 0 }, { nodeKey: 'b', n: 0 }, { nodeKey: 'a', n: 1 }, { nodeKey: 'b', n: 1 }, { nodeKey: 'a', n: 2 }];
    assert.deepEqual(labels(keepNewestPerNode(items, 2)), ['b0', 'a1', 'b1', 'a2']);
  });

  test('an empty list stays empty', () => {
    assert.deepEqual(keepNewestPerNode([], 3), []);
  });
});

describe('progressOf (running card bar)', () => {
  test('no bar for equal, reversed or missing times', () => {
    assert.equal(progressOf({ startedAt: 10, deadlineAt: 10 }, 5), null);
    assert.equal(progressOf({ startedAt: 10, deadlineAt: 5 }, 5), null);
    assert.equal(progressOf({ startedAt: null, deadlineAt: 5 }, 5), null);
    assert.equal(progressOf({ startedAt: 0 }, 5), null);
    assert.equal(progressOf(undefined, 5), null);
  });

  test('the elapsed fraction is clamped to [0, 1]', () => {
    assert.equal(progressOf({ startedAt: 0, deadlineAt: 100 }, 10), 0.1);
    assert.equal(progressOf({ startedAt: 0, deadlineAt: 100 }, -5), 0);
    assert.equal(progressOf({ startedAt: 0, deadlineAt: 100 }, 500), 1);
  });
});

describe('offsetLabel (timeline prefix)', () => {
  test('no prefix without a start or a timestamp', () => {
    assert.equal(offsetLabel(5, null), '');
    assert.equal(offsetLabel(undefined, 0), '');
  });

  test('tenths of a second under a minute, minutes after, never negative', () => {
    assert.equal(offsetLabel(12_400, 0), '+12.4s');
    assert.equal(offsetLabel(125_000, 0), '+2m 5s');
    assert.equal(offsetLabel(0, 1000), '+0.0s');
    assert.equal(offsetLabel(59_940, 0), '+59.9s');
    assert.equal(offsetLabel(59_960, 0), '+1m 0s');
  });

  test('fmtDuration rounds to seconds, then switches to minutes', () => {
    assert.equal(fmtDuration(42_000), '42s');
    assert.equal(fmtDuration(59_600), '1m 0s');
    assert.equal(fmtDuration(undefined), '—');
  });
});
