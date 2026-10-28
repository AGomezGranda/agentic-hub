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

export const fmtDuration = (ms) => {
  if (typeof ms !== 'number') return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

// Elapsed fraction from start to deadline, clamped to [0, 1]; null means no bar.
export function progressOf({ startedAt, deadlineAt } = {}, nowMs) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) || deadlineAt <= startedAt) return null;
  return Math.min(1, Math.max(0, (nowMs - startedAt) / (deadlineAt - startedAt)));
}

// Offset from the swarm start: "+12.4s" under a minute, then fmtDuration. Empty when either time is missing.
export function offsetLabel(ts, startedAt) {
  if (typeof ts !== 'number' || typeof startedAt !== 'number') return '';
  const ms = Math.max(0, ts - startedAt);
  return ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${fmtDuration(ms)}`;
}
