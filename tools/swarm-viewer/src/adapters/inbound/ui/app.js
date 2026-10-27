// Swarm viewer UI. Talks only to the JSON and SSE API. Renders with DOM APIs; data never becomes markup.
import { keepNewestPerNode } from './activity.js';

const LIST_REFRESH_MS = 5000;
const TIMELINE_ROWS = 300;
const MAX_ACTIVITY = TIMELINE_ROWS; // per node; the timeline window is global, so no shown row is lost
const DRAWER_ROWS = 50;
const STATE_NOTES = {
  stale: 'The process is gone but the run never reached a final state.',
  unknown: 'The status file for this node could not be read.',
};

const state = {
  swarms: [],
  swarmId: null,
  view: null,
  selectedKey: null,
  activity: [],
  reports: new Map(),
  filterKeys: null,
  source: null,
};

const $ = (id) => document.getElementById(id);

// Strings become text nodes. Nothing from the server is parsed as markup.
function h(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

// Rebuilds a container but keeps its scroll position and focused control, so the refresh does not jump.
function rerender(container, build) {
  const { scrollTop } = container;
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
  // replaceChildren would turn a null placeholder into the text "null".
  container.replaceChildren(...build().filter((child) => child !== null && child !== false));
  container.scrollTop = scrollTop;
  if (focused !== undefined) container.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
}

const fmtTime = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleTimeString() : '—');
const fmtDuration = (ms) => {
  if (typeof ms !== 'number') return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtUsd = (usd) => (typeof usd === 'number' ? `$${usd.toFixed(4)}` : '—');
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const badge = (name) => h('span', `badge badge-${name}`, name);
const argsText = (args) => (typeof args === 'string' ? args : JSON.stringify(args));
const outputText = (output) => (Array.isArray(output) ? output.map(String).join('\n') : String(output));
const modelText = (node) => (node.modelMismatch ? `${node.requestedModel} → ${node.model}` : (node.model ?? '—'));

function summaryText(item) {
  const at = typeof item.ts === 'number' ? `${fmtTime(item.ts)} ` : '';
  switch (item.type) {
    case 'tool_execution_start':
      return `${at}tool start ${item.tool ?? ''}${item.args === undefined ? '' : ` ${argsText(item.args)}`}`;
    case 'tool_execution_end':
      return `${at}tool end ${item.tool ?? ''}${item.isError ? ' (error)' : ''}${typeof item.durationMs === 'number' ? ` ${item.durationMs} ms` : ''}`;
    case 'turn_end':
      return `${at}turn end${item.model ? ` ${item.model}` : ''}${typeof item.usage?.costUsd === 'number' ? ` est. ${fmtUsd(item.usage.costUsd)}` : ''}`;
    default:
      return `${at}${item.type.replace('subagent.', '')}${item.agent ? ` ${item.agent}` : ''}`;
  }
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Writes only on change, so the 1 s snapshot refresh does not touch the DOM.
function setLink(text) {
  const link = $('link-status');
  if (link.textContent !== text) link.textContent = text;
}

async function refreshList() {
  try {
    state.swarms = await getJson('/api/swarms');
  } catch {
    setLink('cannot reach the viewer');
    return;
  }
  if (!state.swarmId) {
    // A link to a swarm that is no longer listed (pruned, or past the 20-item list) opens the newest.
    const hash = location.hash.slice(1);
    const first = state.swarms.some((swarm) => swarm.id === hash) ? hash : state.swarms[0]?.id;
    if (first) select(first);
  }
  renderList();
}

function select(id) {
  if (id === state.swarmId) return;
  state.source?.close();
  Object.assign(state, { swarmId: id, view: null, selectedKey: null, activity: [], reports: new Map(), filterKeys: null });
  history.replaceState(null, '', `#${id}`);
  const source = new EventSource(`/api/swarms/${encodeURIComponent(id)}/events`);
  state.source = source;
  setLink('connecting…');
  source.addEventListener('open', () => {
    state.activity = []; // the server replays the backlog on every new connection
    setLink('live');
  });
  source.addEventListener('snapshot', (event) => {
    state.view = JSON.parse(event.data);
    setLink('live');
    render();
  });
  source.addEventListener('activity', (event) => {
    state.activity = keepNewestPerNode(state.activity.concat(JSON.parse(event.data)), MAX_ACTIVITY);
    renderTimeline();
    renderDrawer();
  });
  source.addEventListener('gone', () => {
    source.close();
    setLink('swarm no longer available');
  });
  // Server-sent "error" carries data; a connection error does not.
  source.addEventListener('error', (event) => {
    if (typeof event.data === 'string') setLink('poll failed; the server retries');
    else if (source.readyState === EventSource.CLOSED) setLink('swarm not found');
    else setLink('reconnecting…');
  });
  render();
}

function render() {
  renderList();
  renderTotals();
  renderBanner();
  renderStages();
  renderFilter();
  renderTimeline();
  renderDrawer();
}

function renderList() {
  rerender($('swarm-list'), () => state.swarms.map((swarm) => {
    const item = h('button', 'swarm-item',
      h('span', null, `${swarm.id.slice(0, 8)} · ${fmtTime(swarm.startedAt)}`),
      h('span', null, badge(swarm.state), ` ${swarm.memberCount} nodes`));
    item.type = 'button';
    item.dataset.focusKey = swarm.id;
    item.setAttribute('aria-pressed', String(swarm.id === state.swarmId));
    item.addEventListener('click', () => select(swarm.id));
    return h('li', null, item);
  }));
}

function renderTotals() {
  const view = state.view;
  $('totals').textContent = view
    ? `${view.state} · ${fmtDuration(view.durationMs)} · est. tokens ${fmtNum(view.totals.tokens)} · est. cost ${fmtUsd(view.totals.costUsd)}`
    : '';
}

function renderBanner() {
  const messages = [];
  if (state.view?.unsupportedVersion) messages.push('A child run uses an artifact version this viewer does not read. Its nodes are hidden.');
  if (state.view?.partial) messages.push('The member list is incomplete; some nodes may be missing.');
  const banner = $('banner');
  banner.hidden = messages.length === 0;
  banner.replaceChildren(...messages.map((text) => h('p', null, text)));
}

function renderStages() {
  const view = state.view;
  rerender($('stages'), () => {
    if (!view) return [h('p', 'empty', 'Select a swarm.')];
    if (view.nodes.length === 0) return [h('p', 'empty', view.unsupportedVersion ? 'Nodes are hidden for this version.' : 'No nodes yet.')];
    const columns = Array.from({ length: view.stageCount }, (_, stage) => ({
      title: `Stage ${stage + 1}`,
      nodes: view.nodes.filter((node) => node.stage === stage),
    }));
    const unscheduled = view.nodes.filter((node) => node.stage === null);
    if (unscheduled.length) columns.push({ title: 'Start time unknown', nodes: unscheduled });
    return columns.map(({ title, nodes }) => h('section', 'stage', h('h3', null, `${title} · ${nodes.length}`), ...nodes.map(card)));
  });
}

function card(node) {
  const button = h('button', node.key === state.selectedKey ? 'card selected' : 'card',
    h('span', 'row', h('strong', null, node.label ?? node.key), badge(node.state)),
    h('span', 'meta', [node.agent, modelText(node)].filter(Boolean).join(' · ')),
    h('span', 'meta', `${fmtDuration(node.durationMs)} · est. ${fmtUsd(node.costUsd)} · ${fmtNum(node.toolCount)} tools`),
    node.modelMismatch ? h('span', 'warn', 'model differs from the request') : null);
  button.type = 'button';
  button.dataset.focusKey = node.key;
  button.addEventListener('click', () => {
    state.selectedKey = node.key;
    renderStages();
    renderDrawer();
  });
  return button;
}

// Rebuilding the select would drop focus, so it is rebuilt only when the node set changes.
function renderFilter() {
  const nodes = state.view?.nodes ?? [];
  const keys = nodes.map((node) => node.key).join('\n');
  if (keys === state.filterKeys) return;
  state.filterKeys = keys;
  const select = $('timeline-filter');
  const current = select.value;
  select.replaceChildren(new Option('All nodes', ''), ...nodes.map((node) => new Option(node.label ?? node.key, node.key)));
  select.value = nodes.some((node) => node.key === current) ? current : '';
}

function renderTimeline() {
  const filter = $('timeline-filter').value;
  const items = state.activity.filter((item) => !filter || item.nodeKey === filter).slice(-TIMELINE_ROWS).reverse();
  rerender($('timeline'), () => items.map((item) => h('li', null, h('span', 'key', item.nodeKey), ' ', summaryText(item))));
}

function renderDrawer() {
  const node = state.view?.nodes.find((candidate) => candidate.key === state.selectedKey) ?? null;
  $('drawer').hidden = node === null;
  if (node === null) return;
  loadReport(node);
  rerender($('drawer-body'), () => drawerContent(node));
}

function drawerContent(node) {
  const rows = [
    ['Agent', node.agent],
    ['Run', node.runId],
    ['Model', modelText(node)],
    ['Started', fmtTime(node.startedAt)],
    ['Ended', fmtTime(node.endedAt)],
    ['Duration', fmtDuration(node.durationMs)],
    ['Est. tokens', fmtNum(node.tokens)],
    ['Est. cost', fmtUsd(node.costUsd)],
    ['Tools', fmtNum(node.toolCount)],
    ['Turns', fmtNum(node.turnCount)],
  ];
  const items = state.activity.filter((item) => item.nodeKey === node.key).slice(-DRAWER_ROWS).reverse();
  return [
    h('h2', null, node.label ?? node.key),
    h('p', null, badge(node.state), ` ${node.key}`),
    STATE_NOTES[node.state] ? h('p', 'warn', STATE_NOTES[node.state]) : null,
    h('dl', null, ...rows.flatMap(([term, value]) => [h('dt', null, term), h('dd', null, value ?? '—')])),
    h('h3', null, 'Recent tools'),
    node.recentTools.length
      ? h('ul', null, ...node.recentTools.map((tool) => h('li', null, h('code', null, tool.tool ?? '—'), ` ${fmtTime(tool.endMs)}`, tool.args === undefined ? null : ` ${argsText(tool.args)}`)))
      : h('p', 'meta', 'None yet.'),
    ...(node.recentOutput === undefined ? [] : [h('h3', null, 'Recent output'), h('pre', null, outputText(node.recentOutput))]),
    h('h3', null, 'Report'),
    reportBlock(node),
    h('h3', null, 'Activity'),
    items.length ? h('ul', 'activity', ...items.map((item) => h('li', null, summaryText(item)))) : h('p', 'meta', 'None yet.'),
  ];
}

function reportBlock(node) {
  if (!node.hasReport) return h('p', 'meta', 'No report for this node.');
  const report = state.reports.get(node.key);
  if (!report || report.status === 'loading') return h('p', 'meta', 'Loading report…');
  if (report.status === 'failed') return h('p', 'meta', 'Report unavailable.');
  return h('pre', null, report.text);
}

async function loadReport(node) {
  if (!node.hasReport || state.reports.has(node.key)) return;
  const reports = state.reports;
  const swarmId = state.swarmId;
  reports.set(node.key, { status: 'loading' });
  try {
    const res = await fetch(`/api/swarms/${encodeURIComponent(swarmId)}/nodes/${encodeURIComponent(node.key)}/report`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reports.set(node.key, { status: 'ok', text: await res.text() });
  } catch {
    reports.set(node.key, { status: 'failed' });
  }
  if (swarmId === state.swarmId && state.selectedKey === node.key) renderDrawer();
}

$('drawer-close').addEventListener('click', () => {
  state.selectedKey = null;
  renderStages();
  renderDrawer();
});
$('timeline-filter').addEventListener('change', renderTimeline);
refreshList();
setInterval(refreshList, LIST_REFRESH_MS);
