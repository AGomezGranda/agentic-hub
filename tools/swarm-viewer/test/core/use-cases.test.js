import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmService } from '../../src/core/use-cases.js';

// In-memory store. Event offsets are record indexes, which is enough to test the service's cursor handling.
function fakeStore(runs) {
  const calls = { status: [], text: [], events: [] };
  return {
    calls,
    store: {
      async listRunIds() {
        return Object.keys(runs);
      },
      async readStatus(id) {
        calls.status.push(id);
        return runs[id]?.status ?? null;
      },
      async readJson(id, file) {
        return runs[id]?.files?.[file] ?? null;
      },
      async readEventsFrom(id, file, fromOffset) {
        calls.events.push({ id, file, fromOffset });
        const records = runs[id]?.events?.[file] ?? [];
        return { records: records.slice(fromOffset ?? 0), nextOffset: records.length, skipped: 0 };
      },
      async readText(absPath, maxBytes) {
        calls.text.push({ absPath, maxBytes });
        return `report for ${absPath}`;
      },
    },
  };
}

const rootOf = (runId, { startedAt = 100, members = [], parent, mode = 'workflow' } = {}) => ({
  runId,
  mode,
  state: 'complete',
  startedAt,
  endedAt: startedAt + 10,
  ...(parent ? { parentWorkflowRunId: parent } : {}),
  workflowChildren: { inventoryComplete: true, children: members },
  steps: members.map((m) => ({ workflowKey: m.childId, label: `label ${m.childId}` })),
});
const childOf = (runId, { parent = 'root', key = 'scout-r1', state = 'complete', pid = 1 } = {}) => ({
  lifecycleArtifactVersion: 3,
  runId,
  parentWorkflowRunId: parent,
  workflowKey: key,
  state,
  pid,
  startedAt: 1,
  endedAt: state === 'running' ? undefined : 2,
  steps: [{ agent: 'scout', status: state, recentTools: [{ tool: 'read', args: 'SECRET', endMs: 3 }] }],
});
const receiptOf = (entries) => ({ version: 1, entries });
const members = [
  { childId: 'scout-r1', runId: 'c1', agent: 'scout' },
  { childId: 'review-r1', runId: 'c2', agent: 'reviewer' },
];

function service(runs, options = {}) {
  const fake = fakeStore(runs);
  const svc = createSwarmService({
    store: fake.store,
    probe: { isAlive: (pid) => pid !== 999 },
    clock: { now: () => 1000 },
    ...options,
  });
  return { svc, calls: fake.calls };
}

describe('listSwarms', () => {
  test('returns only workflow roots, newest first, capped at listLimit', async () => {
    const { svc } = service(
      {
        r1: { status: rootOf('r1', { startedAt: 100 }) },
        r2: { status: rootOf('r2', { startedAt: 300 }) },
        r3: { status: rootOf('r3', { startedAt: 200 }) },
        child: { status: childOf('child', { parent: 'r2' }) },
        single: { status: { runId: 'single', mode: 'single', startedAt: 999 } },
        nested: { status: rootOf('nested', { startedAt: 400, parent: 'r2' }) },
      },
      { listLimit: 2 },
    );
    const list = await svc.listSwarms();
    assert.deepEqual(list.map((s) => s.id), ['r2', 'r3']);
    assert.equal(list[0].state, 'completed');
    assert.equal(list[0].memberCount, 0);
  });

  test('a non-numeric startedAt or endedAt is listed as null and does not disturb the order', async () => {
    const { svc } = service({
      r1: { status: rootOf('r1', { startedAt: 100 }) },
      soon: { status: { ...rootOf('soon'), startedAt: 'soon', endedAt: 'later' } },
      r3: { status: rootOf('r3', { startedAt: 200 }) },
    });
    const list = await svc.listSwarms();
    assert.deepEqual(list.map((s) => s.id), ['r3', 'r1', 'soon']);
    assert.equal(list[2].startedAt, null);
    assert.equal(list[2].endedAt, null);
  });

  test('memberCount counts the members getSwarm reads, skipping a null member', async () => {
    const root = { ...rootOf('root', { members: [members[0]] }), workflowChildren: { inventoryComplete: true, children: [null, members[0]] } };
    const { svc } = service({
      root: { status: root },
      c1: { status: childOf('c1', { key: 'scout-r1' }) },
    });
    const [listed] = await svc.listSwarms();
    const view = await svc.getSwarm('root');
    assert.equal(listed.memberCount, 1);
    assert.equal(view.nodes.length, listed.memberCount);
  });
});

describe('getSwarm', () => {
  test('reads members from workflowChildren only and never scans other run dirs', async () => {
    const { svc, calls } = service({
      root: { status: rootOf('root', { members }) },
      c1: { status: childOf('c1', { key: 'scout-r1' }) },
      c2: { status: childOf('c2', { key: 'review-r1' }) },
      stray: { status: childOf('stray', { parent: 'root', key: 'stray-r1' }) },
    });
    const view = await svc.getSwarm('root');
    assert.deepEqual(view.nodes.map((n) => n.key), ['scout-r1', 'review-r1']);
    assert.equal(calls.status.includes('stray'), false);
  });

  test('a non-array members list is treated as empty and does not throw', async () => {
    const { svc } = service({
      root: { status: { ...rootOf('root'), workflowChildren: { inventoryComplete: true, children: 'nope' } } },
    });
    const view = await svc.getSwarm('root');
    assert.deepEqual(view.nodes, []);
  });

  test('a member with a missing status is listed as unknown and does not throw', async () => {
    const { svc } = service({
      root: { status: rootOf('root', { members }) },
      c1: { status: childOf('c1') },
    });
    const view = await svc.getSwarm('root');
    assert.equal(view.nodes[1].state, 'unknown');
  });

  test('returns null for a missing id or a run that is not a workflow root', async () => {
    const { svc } = service({ child: { status: childOf('child', { parent: 'root' }) } });
    assert.equal(await svc.getSwarm('nope'), null);
    assert.equal(await svc.getSwarm('child'), null);
  });
});

describe('reportFor', () => {
  const runs = (receiptEntries) => ({
    root: {
      status: rootOf('root', { members }),
      files: { 'workflow-receipt.json': receiptOf(receiptEntries) },
    },
    c1: { status: childOf('c1', { key: 'scout-r1' }) },
    c2: { status: childOf('c2', { key: 'review-r1' }) },
  });

  test('an unknown node key gives null and reads nothing', async () => {
    const { svc, calls } = service(runs({ 'scout-r1': { outputReference: '/x/r1.md' } }));
    assert.equal(await svc.reportFor('root', 'nope'), null);
    assert.equal(calls.text.length, 0);
  });

  test('a receipt entry that is null gives null and reads nothing', async () => {
    const { svc, calls } = service(runs({ 'scout-r1': null }));
    assert.equal(await svc.reportFor('root', 'scout-r1'), null);
    assert.equal(calls.text.length, 0);
  });

  test('a node present in the swarm but absent from the receipt gives null', async () => {
    const { svc, calls } = service(runs({ 'scout-r1': { outputReference: '/x/r1.md' } }));
    assert.equal(await svc.reportFor('root', 'review-r1'), null);
    assert.equal(calls.text.length, 0);
  });

  test('reads the receipt path with reportMaxBytes; the caller never supplies a path', async () => {
    const { svc, calls } = service(runs({ 'scout-r1': { outputReference: '/sessions/r1-scout.md' } }), { reportMaxBytes: 1234 });
    assert.equal(await svc.reportFor('root', 'scout-r1'), 'report for /sessions/r1-scout.md');
    assert.deepEqual(calls.text, [{ absPath: '/sessions/r1-scout.md', maxBytes: 1234 }]);
  });

  test('defaults reportMaxBytes to 512 KiB', async () => {
    const { svc, calls } = service(runs({ 'scout-r1': { outputReference: '/sessions/r1-scout.md' } }));
    await svc.reportFor('root', 'scout-r1');
    assert.equal(calls.text[0].maxBytes, 512 * 1024);
  });
});

describe('followSwarm', () => {
  const eventRecords = [
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'SECRET' } },
    { type: 'message_update', message: { content: 'SECRET' } },
    { type: 'tool_execution_end', toolName: 'read', result: { text: 'SECRET' }, isError: false, durationMs: 4 },
  ];
  const runs = () => ({
    root: { status: rootOf('root', { members }) },
    c1: { status: childOf('c1', { key: 'scout-r1' }), events: { 'events.jsonl': [...eventRecords] } },
    c2: { status: childOf('c2', { key: 'review-r1' }), events: { 'events.jsonl': [{ type: 'subagent.step.started', ts: 9, stepIndex: 0, agent: 'reviewer' }] } },
  });

  test('a cursor returns only the records after it, tagged with the node key', async () => {
    const { svc } = service(runs());
    const { activity } = await svc.followSwarm('root', { c1: { 'events.jsonl': 2 }, c2: { 'events.jsonl': 1 } });
    assert.deepEqual(activity, [{ type: 'tool_execution_end', tool: 'read', isError: false, durationMs: 4, nodeKey: 'scout-r1' }]);
  });

  test('no cursor requests the backlog (null offset)', async () => {
    const { svc, calls } = service(runs());
    const { activity } = await svc.followSwarm('root', {});
    // c1: two summarised tool events (message_update is dropped); c2: one lifecycle event
    assert.equal(activity.length, 3);
    assert.ok(calls.events.every((c) => c.fromOffset === null));
  });

  test('returns the next cursor for every member and the built view', async () => {
    const { svc } = service(runs());
    const result = await svc.followSwarm('root', {});
    assert.deepEqual(result.cursors, { c1: { 'events.jsonl': 3 }, c2: { 'events.jsonl': 1 } });
    assert.deepEqual(result.view.nodes.map((n) => n.key), ['scout-r1', 'review-r1']);
  });

  test('tool arguments stay out of the activity unless showArgs is set', async () => {
    const quiet = await service(runs()).svc.followSwarm('root', {});
    assert.equal(JSON.stringify(quiet.activity).includes('SECRET'), false);
    const loud = await service(runs(), { showArgs: true }).svc.followSwarm('root', {});
    assert.deepEqual(loud.activity[0].args, { path: 'SECRET' });
  });

  test('an unknown swarm gives a null view and no activity', async () => {
    const { svc } = service(runs());
    assert.deepEqual(await svc.followSwarm('nope', {}), { view: null, activity: [], cursors: {} });
  });

  test('an unsupported swarm gives its view with no activity and reads no events', async () => {
    const swarm = runs();
    swarm.c1.status = { ...swarm.c1.status, lifecycleArtifactVersion: 4 };
    const { svc, calls } = service(swarm);
    const result = await svc.followSwarm('root', {});
    assert.equal(result.view.unsupportedVersion, true);
    assert.deepEqual(result.activity, []);
    assert.deepEqual(result.cursors, {});
    assert.deepEqual(calls.events, []);
  });
});

describe('listSwarms read concurrency', () => {
  test('reads statuses at most 16 at a time and keeps input order', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `r${String(i).padStart(2, '0')}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const store = {
      listRunIds: async () => ids,
      async readStatus(id) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return rootOf(id, { startedAt: 1 });
      },
    };
    const svc = createSwarmService({ store, probe: { isAlive: () => true }, clock: { now: () => 0 }, listLimit: 50 });
    const list = await svc.listSwarms();
    assert.equal(maxInFlight, 16);
    // Equal startedAt and a stable sort: the output order is the read order.
    assert.deepEqual(list.map((s) => s.id), ids);
  });
});
