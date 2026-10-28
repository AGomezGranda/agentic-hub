// Pure domain: raw pi-subagents artifacts in, UI-safe view out. No I/O.
// Redaction for events and status lives here (summarizeEvent, buildSwarm nodes). Report text is served as-is by reportFor.

const LIFECYCLE_VERSION = 3;
const STATES = {
  running: 'running',
  complete: 'completed',
  completed: 'completed',
  failed: 'failed',
  paused: 'paused',
  stopped: 'stopped',
};
const LIFECYCLE_EVENTS = new Set([
  'subagent.step.started', 'subagent.step.completed', 'subagent.step.failed', 'subagent.step.paused', 'subagent.step.stopped',
  'subagent.run.started', 'subagent.run.completed', 'subagent.run.stopped',
]);

export function normalizeState(raw) {
  return Object.hasOwn(STATES, raw) ? STATES[raw] : 'unknown';
}

export function nodeState(status, { pidAlive }) {
  const state = normalizeState(status?.state);
  return state === 'running' && pidAlive === false ? 'stale' : state;
}

export function reportReference(receipt, key) {
  const entries = receipt?.entries ?? {};
  if (!Object.hasOwn(entries, key)) return null;
  const outputReference = entries[key]?.outputReference;
  return typeof outputReference === 'string' ? outputReference : null;
}

function isRecord(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function membersOf(root) {
  const children = root.workflowChildren?.children;
  return Array.isArray(children) ? children.filter(isRecord) : [];
}

export function inferStages(nodes) {
  const timed = nodes.filter((node) => typeof node.startedAt === 'number').sort((a, b) => a.startedAt - b.startedAt);
  const stageOf = new Map();
  let stage = -1;
  let stageEnd = -Infinity;
  for (const node of timed) {
    if (node.startedAt >= stageEnd) {
      stage += 1;
      stageEnd = -Infinity;
    }
    stageOf.set(node, stage);
    stageEnd = Math.max(stageEnd, node.endedAt ?? Infinity);
  }
  return nodes.map((node) => ({ ...node, stage: stageOf.get(node) ?? null }));
}

export function summarizeEvent(raw, { showArgs = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.type) {
    case 'tool_execution_start': {
      const summary = { type: raw.type, tool: raw.toolName ?? null };
      if (showArgs) summary.args = raw.args;
      return summary;
    }
    case 'tool_execution_end':
      return { type: raw.type, tool: raw.toolName ?? null, isError: raw.isError === true, durationMs: raw.durationMs ?? null };
    case 'turn_end': {
      const message = raw.message ?? {};
      const usage = message.usage ?? {};
      return {
        type: raw.type,
        model: modelName(message.provider, message.model),
        usage: {
          input: usage.input ?? null,
          output: usage.output ?? null,
          cacheRead: usage.cacheRead ?? null,
          cacheWrite: usage.cacheWrite ?? null,
          costUsd: usage.cost?.total ?? null,
        },
      };
    }
    default: {
      if (!LIFECYCLE_EVENTS.has(raw.type)) return null;
      const summary = { type: raw.type, ts: raw.ts ?? null };
      if (raw.stepIndex !== undefined) summary.stepIndex = raw.stepIndex;
      if (raw.agent !== undefined) summary.agent = raw.agent;
      return summary;
    }
  }
}

export function cwdOf(root) {
  return typeof root?.cwd === 'string' ? root.cwd : null;
}

// Round is always kept. Scope is caller-written text, so it needs showArgs. No other args key is read.
export function workflowArgs(root, { showArgs = false } = {}) {
  const args = root?.workflow?.args;
  if (!isRecord(args)) return { round: null, scope: null };
  return {
    round: Number.isInteger(args.round) ? args.round : null,
    scope: showArgs && typeof args.scope === 'string' ? args.scope : null,
  };
}

// children: Map<runId, status | null>, one entry per member of root.workflowChildren.
export function buildSwarm({ root, children, receipt, nowMs, pidAlive, showArgs = false, showOutput = false, repo = null }) {
  const members = membersOf(root);
  const statuses = [...children.values()];
  const unsupportedVersion = statuses.some((status) => status !== null && status.lifecycleArtifactVersion !== LIFECYCLE_VERSION);
  const built = unsupportedVersion
    ? []
    : members.map((member) => buildNode({ member, status: children.get(member.runId) ?? null, root, receipt, nowMs, pidAlive, showArgs, showOutput }));
  const nodes = inferStages(built);
  const { round, scope } = workflowArgs(root, { showArgs });
  return {
    id: root.runId,
    state: normalizeState(root.state),
    cwd: cwdOf(root),
    repo,
    round,
    scope,
    startedAt: numberOrNull(root.startedAt),
    endedAt: numberOrNull(root.endedAt),
    durationMs: durationOf(root, nowMs),
    unsupportedVersion,
    partial: root.workflowChildren?.inventoryComplete !== true,
    totals: { tokens: root.totalTokens?.total ?? null, costUsd: root.totalCost?.costUsd ?? null },
    nodes,
    stageCount: nodes.reduce((max, node) => (node.stage === null ? max : Math.max(max, node.stage + 1)), 0),
  };
}

function buildNode({ member, status, root, receipt, nowMs, pidAlive, showArgs, showOutput }) {
  const steps = Array.isArray(status?.steps) ? status.steps : [];
  const step = steps[0] ?? {};
  const pid = status?.pid;
  const probe = normalizeState(status?.state) === 'running' && typeof pid === 'number' ? pidAlive(pid) : undefined;
  const requestedModel = typeof step.requestedModel === 'string' ? step.requestedModel : null;
  const resolvedModel = modelName(step.resolvedModel?.provider, step.resolvedModel?.model);
  const state = status ? nodeState(status, { pidAlive: probe }) : 'unknown';
  const startedAt = numberOrNull(status?.startedAt);
  const endedAt = numberOrNull(status?.endedAt) ?? (state === 'running' ? null : (numberOrNull(status?.lastActivityAt) ?? numberOrNull(status?.lastUpdate)));
  const node = {
    key: member.childId,
    runId: member.runId,
    agent: member.agent ?? null,
    label: (Array.isArray(root.steps) ? root.steps : []).find((s) => s?.workflowKey === member.childId)?.label ?? null,
    state,
    startedAt,
    endedAt,
    durationMs: durationOf({ startedAt, endedAt }, nowMs),
    model: resolvedModel ?? requestedModel,
    requestedModel,
    modelMismatch: resolvedModel !== null && requestedModel !== null && normalizeModel(resolvedModel) !== normalizeModel(requestedModel),
    tokens: status?.totalTokens?.total ?? null,
    costUsd: status?.totalCost?.costUsd ?? null,
    toolCount: status?.toolCount ?? null,
    turnCount: status?.turnCount ?? null,
    hasReport: reportReference(receipt, member.childId) !== null,
    recentTools: (Array.isArray(step.recentTools) ? step.recentTools : [])
      .filter(isRecord)
      .map((t) => (showArgs ? { tool: t.tool, endMs: t.endMs, args: t.args } : { tool: t.tool, endMs: t.endMs })),
  };
  if (showOutput) node.recentOutput = step.recentOutput ?? [];
  return node;
}

function modelName(provider, model) {
  if (typeof model !== 'string') return null;
  return typeof provider === 'string' ? `${provider}/${model}` : model;
}

function normalizeModel(value) {
  return value.trim().toLowerCase();
}

export function numberOrNull(value) {
  return typeof value === 'number' ? value : null;
}

function durationOf({ startedAt, endedAt }, nowMs) {
  const start = numberOrNull(startedAt);
  return start === null ? null : (numberOrNull(endedAt) ?? nowMs) - start;
}
