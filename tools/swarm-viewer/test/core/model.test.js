import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildSwarm,
  inferStages,
  normalizeState,
  nodeState,
  reportReference,
  summarizeEvent,
  workflowArgs,
} from '../../src/core/model.js';

const RUNS = new URL('../fixtures/artifacts/async-subagent-runs/', import.meta.url);
const ROOT = '00000000-0000-4000-8000-000000000001';
const SCOUT = '00000000-0000-4000-8000-000000000002';
const CORRECTNESS = '00000000-0000-4000-8000-000000000003';
const ARCHITECTURE = '00000000-0000-4000-8000-000000000004';
const CANARIES = ['CANARY-SYSTEM', 'CANARY-THINKING', 'CANARY-TOOLARG', 'CANARY-TOOLOUT', 'CANARY-RESULT', 'CANARY-UPDATE', 'CANARY-SCOPE', 'CANARY-ARGKEY'];
const NOW = 1793100000000;

const readJson = async (runId, file) => JSON.parse(await readFile(new URL(`${runId}/${file}`, RUNS), 'utf8'));
const readEvents = async (runId) =>
  (await readFile(new URL(`${runId}/events.jsonl`, RUNS), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

async function fixtureSwarm(options = {}) {
  const root = await readJson(ROOT, 'status.json');
  const receipt = await readJson(ROOT, 'workflow-receipt.json');
  const children = new Map();
  for (const member of root.workflowChildren.children) {
    children.set(member.runId, await readJson(member.runId, 'status.json').catch(() => null));
  }
  return buildSwarm({ root, children, receipt, nowMs: NOW, pidAlive: () => false, ...options });
}

describe('normalizeState', () => {
  test('complete and completed both map to completed', () => {
    assert.equal(normalizeState('complete'), 'completed');
    assert.equal(normalizeState('completed'), 'completed');
  });

  test('failed, paused and stopped are kept as they are', () => {
    for (const state of ['failed', 'paused', 'stopped', 'running']) assert.equal(normalizeState(state), state);
  });

  test('any unknown value is shown as unknown, never guessed', () => {
    assert.equal(normalizeState('weird'), 'unknown');
    assert.equal(normalizeState(undefined), 'unknown');
  });
});

describe('nodeState', () => {
  test('a running node whose pid is gone is stale', () => {
    assert.equal(nodeState({ state: 'running' }, { pidAlive: false }), 'stale');
  });

  test('a running node with a live pid, or no pid probe, stays running', () => {
    assert.equal(nodeState({ state: 'running' }, { pidAlive: true }), 'running');
    assert.equal(nodeState({ state: 'running' }, { pidAlive: undefined }), 'running');
  });

  test('a finished node is never stale, even when its pid is gone', () => {
    assert.equal(nodeState({ state: 'complete' }, { pidAlive: false }), 'completed');
  });
});

describe('reportReference', () => {
  test('returns the output reference of a receipt entry', () => {
    assert.equal(reportReference({ entries: { a: { outputReference: '/r/a.md' } } }, 'a'), '/r/a.md');
  });

  test('returns null when there is no receipt or no entry for the key', () => {
    assert.equal(reportReference(null, 'a'), null);
    assert.equal(reportReference({ entries: {} }, 'a'), null);
  });

  test('returns null for a null entry', () => {
    assert.equal(reportReference({ entries: { a: null } }, 'a'), null);
  });

  test('returns null when the output reference is not a string', () => {
    assert.equal(reportReference({ entries: { a: { outputReference: 42 } } }, 'a'), null);
  });
});

describe('inferStages', () => {
  test('scout, two overlapping reviewers, then verifier gives stages 0,1,1,2', () => {
    const nodes = [
      { key: 'scout', startedAt: 0, endedAt: 100 },
      { key: 'r1', startedAt: 100, endedAt: 200 },
      { key: 'r2', startedAt: 110, endedAt: 180 },
      { key: 'verify', startedAt: 200, endedAt: 250 },
    ];
    assert.deepEqual(inferStages(nodes).map((n) => n.stage), [0, 1, 1, 2]);
  });

  test('a still-running reviewer keeps the verifier in its stage', () => {
    const nodes = [
      { key: 'scout', startedAt: 0, endedAt: 100 },
      { key: 'r1', startedAt: 100, endedAt: null },
      { key: 'verify', startedAt: 200, endedAt: 250 },
    ];
    assert.deepEqual(inferStages(nodes).map((n) => n.stage), [0, 1, 1]);
  });

  test('a node without startedAt gets stage null and input order is kept', () => {
    const nodes = [{ key: 'b', startedAt: null }, { key: 'a', startedAt: 5, endedAt: 6 }];
    const staged = inferStages(nodes);
    assert.deepEqual(staged.map((n) => n.key), ['b', 'a']);
    assert.equal(staged[0].stage, null);
    assert.equal(staged[1].stage, 0);
  });
});

describe('summarizeEvent', () => {
  test('no canary string from any fixture event reaches a summary by default', async () => {
    const summaries = [];
    for (const runId of [SCOUT, CORRECTNESS, ARCHITECTURE]) {
      for (const event of await readEvents(runId)) summaries.push(summarizeEvent(event));
    }
    assert.ok(summaries.some((summary) => summary !== null));
    const text = JSON.stringify(summaries);
    for (const canary of CANARIES) assert.equal(text.includes(canary), false, canary);
  });

  test('tool_execution_start has no args unless showArgs is set', () => {
    const raw = { type: 'tool_execution_start', toolName: 'read', args: { path: 'src/a.ts' } };
    assert.deepEqual(summarizeEvent(raw), { type: 'tool_execution_start', tool: 'read' });
    assert.deepEqual(summarizeEvent(raw, { showArgs: true }), {
      type: 'tool_execution_start',
      tool: 'read',
      args: { path: 'src/a.ts' },
    });
  });

  test('tool_execution_end never carries the result body', () => {
    const summary = summarizeEvent({ type: 'tool_execution_end', toolName: 'bash', result: { content: [{ text: 'secret' }] }, isError: true, durationMs: 9 });
    assert.deepEqual(summary, { type: 'tool_execution_end', tool: 'bash', isError: true, durationMs: 9 });
  });

  test('turn_end keeps usage and cost, and never the content', () => {
    const summary = summarizeEvent({
      type: 'turn_end',
      message: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        content: [{ type: 'thinking', thinking: 'private' }],
        usage: { input: 4, output: 334, cacheRead: 0, cacheWrite: 9664, cost: { total: 0.5 } },
      },
    });
    assert.deepEqual(summary, {
      type: 'turn_end',
      model: 'anthropic/claude-haiku-5-5',
      usage: { input: 4, output: 334, cacheRead: 0, cacheWrite: 9664, costUsd: 0.5 },
    });
  });

  test('subagent lifecycle events keep their timing and step identity', () => {
    const summary = summarizeEvent({ type: 'subagent.step.started', ts: 5, runId: 'x', stepIndex: 0, agent: 'scout' });
    assert.deepEqual(summary, { type: 'subagent.step.started', ts: 5, stepIndex: 0, agent: 'scout' });
  });

  test('a non-object event gives null and does not throw', () => {
    assert.equal(summarizeEvent(null), null);
    assert.equal(summarizeEvent(5), null);
  });

  test('unknown and default-deny types return null, including message_update', () => {
    assert.equal(summarizeEvent({ type: 'something_new' }), null);
    assert.equal(summarizeEvent({ type: 'message_update', message: { content: [{ text: 'CANARY-UPDATE' }] } }), null);
  });
});

describe('workflowArgs', () => {
  const withArgs = (args) => ({ workflow: { args } });

  test('round is kept only when it is an integer', () => {
    assert.deepEqual(workflowArgs(withArgs({ round: 3 })), { round: 3, scope: null });
    assert.equal(workflowArgs(withArgs({ round: '3' })).round, null);
    assert.equal(workflowArgs(withArgs({ round: 2.5 })).round, null);
  });

  test('scope is kept only with showArgs, and only as a string', () => {
    assert.equal(workflowArgs(withArgs({ scope: 'x' })).scope, null);
    assert.equal(workflowArgs(withArgs({ scope: 'x' }), { showArgs: true }).scope, 'x');
    assert.equal(workflowArgs(withArgs({ scope: 7 }), { showArgs: true }).scope, null);
  });

  test('no args, or args that are not an object, give nulls; other keys are never read', () => {
    assert.deepEqual(workflowArgs({}), { round: null, scope: null });
    assert.deepEqual(workflowArgs({ workflow: { args: 'nope' } }, { showArgs: true }), { round: null, scope: null });
    assert.deepEqual(workflowArgs(withArgs({ prompt: 'CANARY-ARGKEY' }), { showArgs: true }), { round: null, scope: null });
  });
});

describe('buildSwarm on the copied fixture', () => {
  test('the field paths the model reads exist in the fixture (A2)', async () => {
    const root = await readJson(ROOT, 'status.json');
    const child = await readJson(SCOUT, 'status.json');
    const step = child.steps[0];
    assert.equal(root.mode, 'workflow');
    assert.equal(root.workflowChildren.inventoryComplete, true);
    assert.equal(typeof root.totalCost.costUsd, 'number');
    assert.equal(typeof root.totalTokens.total, 'number');
    assert.equal(child.lifecycleArtifactVersion, 3);
    assert.equal(child.parentWorkflowRunId, ROOT);
    assert.equal(typeof child.pid, 'number');
    assert.equal(typeof child.totalCost.costUsd, 'number');
    assert.equal(typeof step.resolvedModel.provider, 'string');
    assert.equal(typeof step.requestedModel, 'string');
    assert.ok(Array.isArray(step.recentTools) && 'endMs' in step.recentTools[0]);
    assert.ok(Array.isArray(step.recentOutput));
    const events = await readEvents(SCOUT);
    assert.ok(events.some((e) => e.type === 'turn_end' && typeof e.message.usage.cost.total === 'number'));
    assert.ok(events.some((e) => e.type === 'tool_execution_end' && 'durationMs' in e && 'toolName' in e));
  });

  test('totals come from the root; the swarm is complete enough to show', async () => {
    const view = await fixtureSwarm();
    const root = await readJson(ROOT, 'status.json');
    assert.equal(view.totals.tokens, root.totalTokens.total);
    assert.equal(view.totals.costUsd, root.totalCost.costUsd);
    assert.equal(view.partial, false);
    assert.equal(view.unsupportedVersion, false);
    assert.equal(view.state, 'running');
  });

  test('node states: finished, stale when the pid is gone, unknown when the dir is missing', async () => {
    const view = await fixtureSwarm();
    const byKey = Object.fromEntries(view.nodes.map((n) => [n.key, n]));
    assert.equal(byKey['scout-r1'].state, 'completed');
    assert.equal(byKey['correctness-r1'].state, 'completed');
    assert.equal(byKey['architecture-r1'].state, 'stale');
    assert.equal(byKey['verify-r1'].state, 'unknown');
    assert.equal(byKey['verify-r1'].stage, null);
  });

  test('labels come from the root steps; the report flag comes from the receipt', async () => {
    const byKey = Object.fromEntries((await fixtureSwarm()).nodes.map((n) => [n.key, n]));
    assert.equal(byKey['scout-r1'].label, 'Map swarm scope');
    assert.equal(byKey['scout-r1'].hasReport, true);
    assert.equal(byKey['architecture-r1'].hasReport, false);
    assert.equal(byKey['verify-r1'].hasReport, false);
  });

  test('model is provider/model from resolvedModel, with no mismatch on the fixture', async () => {
    const scout = (await fixtureSwarm()).nodes.find((n) => n.key === 'scout-r1');
    assert.equal(scout.model, 'anthropic/claude-haiku-5-5');
    assert.equal(scout.requestedModel, 'anthropic/claude-haiku-5-5');
    assert.equal(scout.modelMismatch, false);
  });

  test('stages come from timing: scout, two reviewers, unknown member has no stage', async () => {
    const view = await fixtureSwarm();
    assert.deepEqual(view.nodes.map((n) => n.stage), [0, 1, 1, null]);
    assert.equal(view.stageCount, 2);
  });

  test('tool args and node output are hidden by default and shown only with their flags', async () => {
    const quiet = await fixtureSwarm();
    const scout = quiet.nodes.find((n) => n.key === 'scout-r1');
    assert.equal(scout.recentTools.length > 0, true);
    assert.equal(scout.recentTools.every((t) => !('args' in t)), true);
    assert.equal('recentOutput' in scout, false);

    const loud = await fixtureSwarm({ showArgs: true, showOutput: true });
    const loudScout = loud.nodes.find((n) => n.key === 'scout-r1');
    assert.equal(loudScout.recentTools.every((t) => typeof t.args === 'string'), true);
    assert.equal(loudScout.recentOutput.length, 3);
  });

  test('the fixture launch args: round is shown, scope only with showArgs, the other key never', async () => {
    const quiet = await fixtureSwarm();
    assert.equal(quiet.round, 1);
    assert.equal(quiet.scope, null);
    assert.equal(quiet.cwd, '/fixture/repo');
    const text = JSON.stringify(quiet);
    assert.equal(text.includes('CANARY-SCOPE'), false);
    assert.equal(text.includes('CANARY-ARGKEY'), false);
    const loud = await fixtureSwarm({ showArgs: true });
    assert.equal(loud.scope, 'CANARY-SCOPE fixture scope');
    assert.equal(JSON.stringify(loud).includes('CANARY-ARGKEY'), false);
  });

  test('a stale node stops its clock at its last activity', async () => {
    const arch = (await fixtureSwarm()).nodes.find((n) => n.key === 'architecture-r1');
    const status = await readJson(ARCHITECTURE, 'status.json');
    assert.equal(arch.endedAt, status.lastActivityAt);
    assert.equal(arch.durationMs, status.lastActivityAt - arch.startedAt);
  });
});

describe('buildSwarm on inline data', () => {
  const root = (children, extra = {}) => ({
    runId: 'r',
    mode: 'workflow',
    state: 'complete',
    startedAt: 0,
    endedAt: 100,
    workflowChildren: { inventoryComplete: true, children },
    steps: [{ workflowKey: 'a', label: 'A' }],
    ...extra,
  });
  const member = { childId: 'a', runId: 'c1', agent: 'scout' };
  const child = (extra = {}) => ({
    lifecycleArtifactVersion: 3,
    runId: 'c1',
    state: 'complete',
    pid: 1,
    startedAt: 1,
    endedAt: 50,
    steps: [{ agent: 'scout' }],
    ...extra,
  });
  const build = (rootStatus, childStatus, options = {}) =>
    buildSwarm({
      root: rootStatus,
      children: new Map([['c1', childStatus]]),
      receipt: null,
      nowMs: NOW,
      pidAlive: () => true,
      ...options,
    });

  test('a child with lifecycleArtifactVersion other than 3 is unsupported and shows no nodes', () => {
    const view = build(root([member]), child({ lifecycleArtifactVersion: 4 }));
    assert.equal(view.unsupportedVersion, true);
    assert.deepEqual(view.nodes, []);
  });

  test('a root with no lifecycleArtifactVersion is supported', () => {
    const view = build(root([member]), child());
    assert.equal(view.unsupportedVersion, false);
    assert.equal(view.nodes.length, 1);
  });

  test('the same model in resolvedModel and requestedModel does not mismatch, a different one does', () => {
    const same = build(root([member]), child({ steps: [{ resolvedModel: { provider: 'anthropic', model: 'claude' }, requestedModel: 'anthropic/claude' }] }));
    assert.equal(same.nodes[0].modelMismatch, false);
    const diff = build(root([member]), child({ steps: [{ resolvedModel: { provider: 'openai', model: 'gpt' }, requestedModel: 'anthropic/claude' }] }));
    assert.equal(diff.nodes[0].modelMismatch, true);
    assert.equal(diff.nodes[0].model, 'openai/gpt');
    assert.equal(diff.nodes[0].requestedModel, 'anthropic/claude');
  });

  test('model names match ignoring case and surrounding whitespace, but a different model still mismatches', () => {
    const cased = build(root([member]), child({ steps: [{ resolvedModel: { provider: 'Anthropic', model: 'Claude' }, requestedModel: ' anthropic/claude ' }] }));
    assert.equal(cased.nodes[0].modelMismatch, false);
    const other = build(root([member]), child({ steps: [{ resolvedModel: { provider: 'Anthropic', model: 'Opus' }, requestedModel: ' anthropic/claude ' }] }));
    assert.equal(other.nodes[0].modelMismatch, true);
  });

  test('a dead top-level pid on a running child gives stale, and only running children are probed', () => {
    const probed = [];
    const view = build(root([member]), child({ state: 'running', pid: 77, endedAt: undefined }), {
      pidAlive: (pid) => { probed.push(pid); return false; },
    });
    assert.equal(view.nodes[0].state, 'stale');
    assert.deepEqual(probed, [77]);
    build(root([member]), child(), { pidAlive: (pid) => { probed.push(pid); return false; } });
    assert.deepEqual(probed, [77]);
  });

  test('a member with no status is listed as unknown; partial reflects inventoryComplete', () => {
    const view = build(root([member], { workflowChildren: { inventoryComplete: false, children: [member] } }), null);
    assert.equal(view.partial, true);
    assert.equal(view.nodes[0].state, 'unknown');
  });

  test('a null receipt entry gives hasReport false and no throw', () => {
    const view = build(root([member]), child(), { receipt: { entries: { a: null } } });
    assert.equal(view.nodes[0].hasReport, false);
  });

  test('a non-array children list is treated as empty and does not throw', () => {
    const view = build(root('nope'), child());
    assert.deepEqual(view.nodes, []);
  });

  test('a non-array steps list gives a node with no model and no throw', () => {
    const view = build(root([member]), child({ steps: { 0: { requestedModel: 'anthropic/claude', recentTools: [{ tool: 'read', endMs: 1 }] } } }));
    assert.equal(view.nodes[0].model, null);
    assert.deepEqual(view.nodes[0].recentTools, []);
  });

  test('a non-array recentTools gives an empty list and no throw', () => {
    const view = build(root([member]), child({ steps: [{ agent: 'scout', recentTools: 'nope' }] }));
    assert.deepEqual(view.nodes[0].recentTools, []);
  });

  test('an array member entry is not a member: no node and no throw', () => {
    const view = build(root([[]]), child());
    assert.deepEqual(view.nodes, []);
  });

  test('an array recentTools entry is dropped, not shown as an empty tool', () => {
    const view = build(root([member]), child({ steps: [{ agent: 'scout', recentTools: [[{ tool: 'read', endMs: 1 }]] }] }));
    assert.deepEqual(view.nodes[0].recentTools, []);
  });

  test('a non-array root steps gives a null label and no throw', () => {
    const view = build(root([member], { steps: {} }), child());
    assert.equal(view.nodes[0].label, null);
  });

  test('a null member is skipped and does not throw', () => {
    const view = build(root([null, member]), child());
    assert.equal(view.nodes.length, 1);
    assert.equal(view.nodes[0].key, 'a');
  });

  test('a null root step does not throw and gives a null label', () => {
    const view = build(root([member], { steps: [null] }), child());
    assert.equal(view.nodes[0].label, null);
  });

  test('a null recentTools entry is dropped and does not throw', () => {
    const view = build(root([member]), child({ steps: [{ agent: 'scout', recentTools: [null, { tool: 'read', endMs: 1 }] }] }));
    assert.deepEqual(view.nodes[0].recentTools, [{ tool: 'read', endMs: 1 }]);
  });

  test('a requestedModel with no resolvedModel is the model and never a mismatch', () => {
    const view = build(root([member]), child({ steps: [{ requestedModel: 'anthropic/claude' }] }));
    assert.equal(view.nodes[0].model, 'anthropic/claude');
    assert.equal(view.nodes[0].modelMismatch, false);
  });

  test('a stale child closes at its last activity, so the next stage is not held open', () => {
    const members = [
      { childId: 'scout', runId: 'c1', agent: 'scout' },
      { childId: 'reviewer', runId: 'c2', agent: 'reviewer' },
      { childId: 'verifier', runId: 'c3', agent: 'verifier' },
    ];
    const view = buildSwarm({
      root: root(members),
      children: new Map([
        ['c1', child({ runId: 'c1', startedAt: 0, endedAt: 100 })],
        ['c2', child({ runId: 'c2', state: 'running', pid: 2, startedAt: 100, endedAt: undefined, lastActivityAt: 150 })],
        ['c3', child({ runId: 'c3', startedAt: 200, endedAt: 250 })],
      ]),
      receipt: null,
      nowMs: NOW,
      pidAlive: () => false,
    });
    assert.deepEqual(view.nodes.map((n) => n.stage), [0, 1, 2]);
    assert.equal(view.nodes[1].state, 'stale');
    assert.equal(view.nodes[1].durationMs, 50);
  });

  test('a child that is not running and has no endedAt or lastActivityAt closes at lastUpdate', () => {
    const view = build(root([member]), child({ state: 'failed', endedAt: undefined, lastUpdate: 70 }));
    assert.equal(view.nodes[0].endedAt, 70);
    assert.equal(view.nodes[0].durationMs, 69);
  });

  test('a complete node closes at its own endedAt, not at lastActivityAt', () => {
    const view = build(root([member]), child({ state: 'complete', startedAt: 10, endedAt: 40, lastActivityAt: 30 }));
    assert.equal(view.nodes[0].endedAt, 40);
    assert.equal(view.nodes[0].durationMs, 30);
  });

  test('a running node keeps its raw endedAt rather than taking lastActivityAt', () => {
    const view = build(root([member]), child({ state: 'running', pid: 77, startedAt: 10, endedAt: 40, lastActivityAt: 30 }));
    assert.equal(view.nodes[0].state, 'running');
    assert.equal(view.nodes[0].endedAt, 40);
  });

  test('the view carries cwd, the repo the caller looked up, and round; cwd and repo are null when absent', () => {
    const repo = { name: 'proj', path: '/work/proj', branch: 'main', head: null };
    const view = build(root([member], { cwd: '/work/proj', workflow: { args: { round: 2 } } }), child(), { repo });
    assert.equal(view.cwd, '/work/proj');
    assert.deepEqual(view.repo, repo);
    assert.equal(view.round, 2);
    const bare = build(root([member]), child());
    assert.equal(bare.cwd, null);
    assert.equal(bare.repo, null);
    assert.equal(bare.scope, null);
  });

  test('scope is in the view only with showArgs, and the view never holds the other args key', () => {
    const rootStatus = root([member], { workflow: { args: { round: 1, scope: 'CANARY-SCOPE', prompt: 'CANARY-ARGKEY' } } });
    const quiet = build(rootStatus, child());
    assert.equal(quiet.scope, null);
    assert.equal(JSON.stringify(quiet).includes('CANARY-SCOPE'), false);
    const loud = build(rootStatus, child(), { showArgs: true });
    assert.equal(loud.scope, 'CANARY-SCOPE');
    assert.equal(JSON.stringify(loud).includes('CANARY-ARGKEY'), false);
  });

  test('a live running node has no end, and its duration runs up to now', () => {
    const view = build(root([member]), child({ state: 'running', pid: 77, startedAt: 10, endedAt: undefined, lastActivityAt: 150 }));
    assert.equal(view.nodes[0].state, 'running');
    assert.equal(view.nodes[0].endedAt, null);
    assert.equal(view.nodes[0].durationMs, NOW - 10);
  });
});
