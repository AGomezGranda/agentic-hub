// Keeps the newest `max` rows per node, in arrival order. A single global cap would drop
// an early node's whole backlog when later nodes have more rows.
export function keepNewestPerNode(items, max) {
  const counts = new Map();
  const kept = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const count = counts.get(items[i].nodeKey) ?? 0;
    if (count < max) {
      counts.set(items[i].nodeKey, count + 1);
      kept.push(items[i]);
    }
  }
  return kept.reverse();
}
