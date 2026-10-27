import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { keepNewestPerNode } from '../../src/adapters/inbound/ui/activity.js';

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
