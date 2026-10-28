import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/compose.js';
import { materializeFixtures } from './helpers/fixtures.js';

const CANARIES = ['CANARY-SYSTEM', 'CANARY-THINKING', 'CANARY-TOOLARG', 'CANARY-TOOLOUT', 'CANARY-RESULT', 'CANARY-UPDATE', 'CANARY-SCOPE', 'CANARY-ARGKEY'];
const exec = promisify(execFile);
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
// Only streams from the default app join `seen`, so the canary sweep never sees other apps' text.
function readStream(path, origin = base) {
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = () => {
      clearTimeout(timer);
      req.destroy();
      if (origin === base) seen.push(text);
      resolve(text);
    };
    const req = http.get(origin + path, (res) => {
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

  test('the list row carries the fixture cwd, no repo (the path does not exist), and round', async () => {
    const [row] = JSON.parse((await get('/api/swarms')).body);
    assert.equal(row.cwd, '/fixture/repo');
    assert.equal(row.repo, null);
    assert.equal(row.round, 1);
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

  test('a swarm whose cwd is a git repo on feature/x shows that repo and branch', async () => {
    const copy = await materializeFixtures();
    const repoDir = await mkdtemp(join(tmpdir(), 'swarm-viewer-repo-'));
    let wired;
    try {
      await exec('git', ['init', '-q'], { cwd: repoDir });
      await exec('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature/x'], { cwd: repoDir });
      const statusFile = join(copy.artifactsRoot, ROOT, 'status.json');
      const root = JSON.parse(await readFile(statusFile, 'utf8'));
      await writeFile(statusFile, JSON.stringify({ ...root, cwd: repoDir }));
      wired = createApp({ artifactsRoot: copy.artifactsRoot, piSessionsRoot: copy.sessionsRoot });
      await new Promise((resolve) => wired.server.listen(0, '127.0.0.1', resolve));
      const res = await fetch(`http://127.0.0.1:${wired.server.address().port}/api/swarms/${ROOT}`);
      const view = await res.json();
      assert.equal(view.repo.branch, 'feature/x');
      assert.equal(view.repo.name, basename(repoDir));
    } finally {
      wired?.server.closeAllConnections();
      await new Promise((resolve) => (wired ? wired.server.close(resolve) : resolve()));
      await copy.cleanup();
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test('with showArgs the swarm view carries the launch scope, and the other args key never appears', async () => {
    const copy = await materializeFixtures();
    let loud;
    try {
      loud = createApp({ artifactsRoot: copy.artifactsRoot, piSessionsRoot: copy.sessionsRoot, showArgs: true });
      await new Promise((resolve) => loud.server.listen(0, '127.0.0.1', resolve));
      const body = await (await fetch(`http://127.0.0.1:${loud.server.address().port}/api/swarms/${ROOT}`)).text();
      assert.equal(JSON.parse(body).scope, 'CANARY-SCOPE fixture scope');
      assert.equal(body.includes('CANARY-ARGKEY'), false);
      const stream = await readStream(`/api/swarms/${ROOT}/events`, `http://127.0.0.1:${loud.server.address().port}`);
      assert.match(stream, /"scope":"CANARY-SCOPE fixture scope"/);
      assert.equal(stream.includes('CANARY-ARGKEY'), false);
    } finally {
      loud?.server.closeAllConnections();
      await new Promise((resolve) => (loud ? loud.server.close(resolve) : resolve()));
      await copy.cleanup();
    }
  });
});
