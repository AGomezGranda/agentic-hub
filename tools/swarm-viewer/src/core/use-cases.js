import { buildSwarm, countStates, cwdOf, membersOf, normalizeState, numberOrNull, reportReference, summarizeEvent, workflowArgs } from './model.js';

const EVENTS_FILE = 'events.jsonl';
const RECEIPT_FILE = 'workflow-receipt.json';

const isWorkflowRoot = (status) => status?.mode === 'workflow' && !status.parentWorkflowRunId;

/**
 * @param {{store: import('./ports.js').ArtifactStore, probe: import('./ports.js').ProcessProbe,
 *   repoProbe: import('./ports.js').RepoProbe, clock: import('./ports.js').Clock, listLimit?: number,
 *   reportMaxBytes?: number, showArgs?: boolean, showOutput?: boolean}} deps
 */
export function createSwarmService({ store, probe, repoProbe, clock, listLimit = 20, reportMaxBytes = 512 * 1024, showArgs = false, showOutput = false }) {
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

  const viewOf = ({ root, children, receipt }, repo = null) =>
    buildSwarm({ root, children, receipt, nowMs: clock.now(), pidAlive: (pid) => probe.isAlive(pid), showArgs, showOutput, repo });

  // Only getSwarm, followSwarm and listSwarms look the repo up. The stream ticks followSwarm; the probe caches.
  async function repoOf(root) {
    const cwd = cwdOf(root);
    return cwd === null ? null : repoProbe.describe(cwd);
  }

  return {
    async listSwarms() {
      const ids = await store.listRunIds();
      const runs = await Promise.all(ids.map(async (id) => ({ id, status: await store.readStatus(id) })));
      // Children resolve from the same reads; no extra file is read for the counts.
      const byId = new Map(runs.map(({ id, status }) => [id, status]));
      const kept = runs
        .filter(({ status }) => isWorkflowRoot(status))
        .sort((a, b) => (numberOrNull(b.status.startedAt) ?? 0) - (numberOrNull(a.status.startedAt) ?? 0))
        .slice(0, listLimit);
      return Promise.all(kept.map(async ({ id, status }) => ({
        id,
        state: normalizeState(status.state),
        startedAt: numberOrNull(status.startedAt),
        endedAt: numberOrNull(status.endedAt),
        memberCount: membersOf(status).length,
        cwd: cwdOf(status),
        repo: await repoOf(status),
        round: workflowArgs(status).round,
        stateCounts: countStates(status, byId, (pid) => probe.isAlive(pid)),
      })));
    },

    async getSwarm(id) {
      const loaded = await load(id);
      return loaded ? viewOf(loaded, await repoOf(loaded.root)) : null;
    },

    // cursors: { [runId]: { [file]: offset } }. A missing cursor asks for the backlog.
    async followSwarm(id, cursors = {}) {
      const loaded = await load(id);
      if (!loaded) return { view: null, activity: [], cursors: {} };
      const view = viewOf(loaded, await repoOf(loaded.root));
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
