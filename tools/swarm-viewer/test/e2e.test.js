import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/compose.js';
import { materializeFixtures } from './helpers/fixtures.js';

const CANARIES = ['CANARY-SYSTEM', 'CANARY-THINKING', 'CANARY-TOOLARG', 'CANARY-TOOLOUT', 'CANARY-RESULT', 'CANARY-UPDATE'];
const ROOT = '00000000-0000-4000-8000-000000000001';
const SCOUT = '00000000-0000-4000-8000-000000000002';
const FIXTURE_REPORT = fileURLToPath(new URL('./fixtures/sessions/subagent-artifacts/outputs/00000000-0000-4000-8000-000000000001/swarm/r1-scout.md', import.meta.url));

let fixture;
let app;
let base;
const seen = [];

before(async () => {
  fixture = await materializeFixtures();
  app = createApp({ artifactsRoot: fixture.artifactsRoot, piSessionsRoot: fixture.sessionsRoot });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app?.server.closeAllConnections();
  await new Promise((resolve) => (app ? app.server.close(resolve) : resolve()));
  await fixture?.cleanup();
});

async function get(path) {
  const res = await fetch(base + path);
  const body = await res.text();
  seen.push(body);
  return { status: res.status, headers: res.headers, body };
}

// Reads the SSE stream until an activity frame arrives or 2 s pass, then closes it.
function readStream(path) {
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = () => {
      clearTimeout(timer);
      req.destroy();
      seen.push(text);
      resolve(text);
    };
    const req = http.get(base + path, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.includes('event: activity')) finish();
      });
    });
    req.on('error', reject);
    const timer = setTimeout(finish, 2000);
  });
}

describe('swarm viewer end to end, on the copied fixture', () => {
  test('the list shows only the fixture swarm', async () => {
    const res = await get('/api/swarms');
    assert.equal(res.status, 200);
    const list = JSON.parse(res.body);
    assert.deepEqual(list.map((s) => s.id), [ROOT]);
    assert.equal(list[0].memberCount, 4);
  });

  test('the swarm view has stale, finished and unknown nodes and stays free of canaries', async () => {
    const view = JSON.parse((await get(`/api/swarms/${ROOT}`)).body);
    const states = Object.fromEntries(view.nodes.map((n) => [n.key, n.state]));
    assert.deepEqual(states, {
      'scout-r1': 'completed',
      'correctness-r1': 'completed',
      'architecture-r1': 'stale',
      'verify-r1': 'unknown',
    });
    assert.equal(view.stageCount, 2);
  });

  test('a finished node report is the fixture file, served as plain text', async () => {
    const res = await get(`/api/swarms/${ROOT}/nodes/scout-r1/report`);
    assert.equal(res.status, 200);
    assert.equal(res.body, await readFile(FIXTURE_REPORT, 'utf8'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('a node with no report is 404', async () => {
    assert.equal((await get(`/api/swarms/${ROOT}/nodes/architecture-r1/report`)).status, 404);
  });

  test('the event stream opens with a snapshot and an activity event, with no tool args', async () => {
    const text = await readStream(`/api/swarms/${ROOT}/events`);
    assert.match(text, /^event: snapshot/m);
    assert.match(text, /^event: activity/m);
    assert.match(text, /"nodeKey":"scout-r1"/);
  });

  test('no canary string appears in any response body, including the stream', async () => {
    await get('/api/swarms');
    await get(`/api/swarms/${ROOT}`);
    await get(`/api/swarms/${ROOT}/nodes/scout-r1/report`);
    const stream = await readStream(`/api/swarms/${ROOT}/events`);
    assert.match(stream, /event: snapshot/);
    const everything = seen.join('\n');
    for (const canary of CANARIES) assert.equal(everything.includes(canary), false, canary);
  });

  test('a foreign Host header is refused by the real app', async () => {
    const port = app.server.address().port;
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/swarms', headers: { Host: 'evil.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
    });
    assert.equal(status, 403);
  });

  test('a member run id is not a swarm; only workflow roots are', async () => {
    assert.equal((await get(`/api/swarms/${SCOUT}`)).status, 404);
  });
});
