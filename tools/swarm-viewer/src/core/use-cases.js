import { buildSwarm, membersOf, normalizeState, numberOrNull, reportReference, summarizeEvent } from './model.js';

const EVENTS_FILE = 'events.jsonl';
const RECEIPT_FILE = 'workflow-receipt.json';

const isWorkflowRoot = (status) => status?.mode === 'workflow' && !status.parentWorkflowRunId;

/**
 * @param {{store: import('./ports.js').ArtifactStore, probe: import('./ports.js').ProcessProbe,
 *   clock: import('./ports.js').Clock, listLimit?: number, reportMaxBytes?: number,
 *   showArgs?: boolean, showOutput?: boolean}} deps
 */
export function createSwarmService({ store, probe, clock, listLimit = 20, reportMaxBytes = 512 * 1024, showArgs = false, showOutput = false }) {
  // Members come only from the root's inventory. Other run dirs are never scanned.
  async function load(id) {
    const root = await store.readStatus(id);
    if (!isWorkflowRoot(root)) return null;
    const members = membersOf(root);
    const statuses = await Promise.all(members.map((m) => store.readStatus(m.runId)));
    const children = new Map(members.map((m, i) => [m.runId, statuses[i]]));
    const receipt = await store.readJson(id, RECEIPT_FILE);
    return { root, members, children, receipt };
  }

  const viewOf = ({ root, children, receipt }) =>
    buildSwarm({ root, children, receipt, nowMs: clock.now(), pidAlive: (pid) => probe.isAlive(pid), showArgs, showOutput });

  return {
    async listSwarms() {
      const ids = await store.listRunIds();
      const runs = await Promise.all(ids.map(async (id) => ({ id, status: await store.readStatus(id) })));
      return runs
        .filter(({ status }) => isWorkflowRoot(status))
        .sort((a, b) => (numberOrNull(b.status.startedAt) ?? 0) - (numberOrNull(a.status.startedAt) ?? 0))
        .slice(0, listLimit)
        .map(({ id, status }) => ({
          id,
          state: normalizeState(status.state),
          startedAt: numberOrNull(status.startedAt),
          endedAt: numberOrNull(status.endedAt),
          memberCount: membersOf(status).length,
        }));
    },

    async getSwarm(id) {
      const loaded = await load(id);
      return loaded ? viewOf(loaded) : null;
    },

    // cursors: { [runId]: { [file]: offset } }. A missing cursor asks for the backlog.
    async followSwarm(id, cursors = {}) {
      const loaded = await load(id);
      if (!loaded) return { view: null, activity: [], cursors: {} };
      const view = viewOf(loaded);
      if (view.unsupportedVersion) return { view, activity: [], cursors: {} };
      const activity = [];
      const next = {};
      for (const member of loaded.members) {
        const from = cursors[member.runId]?.[EVENTS_FILE] ?? null;
        const page = await store.readEventsFrom(member.runId, EVENTS_FILE, from);
        next[member.runId] = { [EVENTS_FILE]: page.nextOffset };
        for (const raw of page.records) {
          const summary = summarizeEvent(raw, { showArgs });
          if (summary) activity.push({ ...summary, nodeKey: member.childId });
        }
      }
      return { view, activity, cursors: next };
    },

    // The node must be in the swarm view and the receipt must hold its path. The path never comes from the caller.
    async reportFor(id, nodeKey) {
      const loaded = await load(id);
      if (!loaded || !viewOf(loaded).nodes.some((n) => n.key === nodeKey)) return null;
      const outputReference = reportReference(loaded.receipt, nodeKey);
      if (outputReference === null) return null;
      return store.readText(outputReference, reportMaxBytes);
    },
  };
}
