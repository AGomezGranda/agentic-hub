import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpHandler } from '../../src/adapters/inbound/http.js';

const CSP = "default-src 'self'; frame-ancestors 'none'";
const servers = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Fake service: the handler only sees the port, so the swarm and its activity are plain data.
// gate, when given, holds the first followSwarm call until it resolves.
// delayMs, when given, makes every followSwarm call take that long.
function fakeService({ gate = null, delayMs = 0 } = {}) {
  const service = {
    swarm: { id: 'known', state: 'running', nodes: [{ key: 'scout-r1', state: 'running' }] },
    activity: [],
    reports: { 'known/scout-r1': 'plain report text' },
    reportError: null,
    failNextFollow: false,
    follows: 0,
    inFlight: 0,
    maxInFlight: 0,
    cursorsSeen: [],
    async listSwarms() {
      return [{ id: 'known', state: 'running' }];
    },
    async getSwarm(id) {
      return id === 'known' ? service.swarm : null;
    },
    async reportFor(id, key) {
      if (service.reportError) throw service.reportError;
      return service.reports[`${id}/${key}`] ?? null;
    },
    async followSwarm(id, cursors) {
      service.follows += 1;
      service.cursorsSeen.push(cursors);
      service.inFlight += 1;
      service.maxInFlight = Math.max(service.maxInFlight, service.inFlight);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (service.follows === 1 && gate) await gate;
        if (service.failNextFollow) {
          service.failNextFollow = false;
          throw new Error('poll exploded');
        }
        if (id !== 'known') return { view: null, activity: [], cursors: {} };
        const activity = service.activity.splice(0);
        return { view: service.swarm, activity, cursors: { polls: service.follows } };
      } finally {
        service.inFlight -= 1;
      }
    },
  };
  return service;
}

async function start(options = {}) {
  const service = options.service ?? fakeService();
  const uiFiles = options.uiFiles ?? new Map();
  const server = http.createServer(
    createHttpHandler({ service, uiFiles, log: options.log, getPort: () => server.address()?.port, pollMs: 20, pingMs: 60_000 }),
  );
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, service, port: server.address().port };
}

// host: null omits the Host header entirely.
function request(port, { method = 'GET', path = '/', host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const omitHost = host === null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, setHost: !omitHost, headers: omitHost ? headers : { Host: host ?? `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Opens an SSE stream and resolves with a collector once the predicate passes or the timeout expires.
function openStream(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const stream = { status: res.statusCode, headers: res.headers, text: '', ended: false, req };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.text += chunk;
      });
      res.on('end', () => {
        stream.ended = true;
      });
      resolve(stream);
    });
    req.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const snapshots = (text) => text.split('\n\n').filter((frame) => frame.startsWith('event: snapshot'));

describe('host and method guards', () => {
  test('a foreign Host header gets 403', async () => {
    const { port } = await start();
    assert.equal((await request(port, { host: 'evil.example' })).status, 403);
  });

  test('a localhost Host with the right port is allowed, a wrong port is not', async () => {
    const { port } = await start();
    assert.equal((await request(port, { host: `localhost:${port}`, path: '/api/swarms' })).status, 200);
    assert.equal((await request(port, { host: '127.0.0.1:1', path: '/api/swarms' })).status, 403);
  });

  test('a missing Host header is refused (Node rejects HTTP/1.1 without Host with 400 before the handler)', async () => {
    const { port } = await start();
    assert.ok([400, 403].includes((await request(port, { host: null })).status));
  });

  test('POST gets 405 and names the allowed methods', async () => {
    const { port } = await start();
    const res = await request(port, { method: 'POST', path: '/api/swarms' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  });

  test('HEAD returns headers and no body', async () => {
    const { port } = await start();
    const res = await request(port, { method: 'HEAD', path: '/api/swarms' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });
});

describe('routing', () => {
  test('traversal-style paths and unknown routes get 404', async () => {
    const { port } = await start();
    for (const path of ['/../etc/passwd', '/%2e%2e/x', '/nope']) {
      assert.equal((await request(port, { path })).status, 404, path);
    }
  });

  test('GET /api/swarms returns the list as JSON', async () => {
    const { port } = await start();
    const res = await request(port, { path: '/api/swarms' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), [{ id: 'known', state: 'running' }]);
  });

  test('GET /api/swarms/:id returns JSON, 404 for an unknown id, 404 for an id with a slash', async () => {
    const { port } = await start();
    assert.equal(JSON.parse((await request(port, { path: '/api/swarms/known' })).body).id, 'known');
    assert.equal((await request(port, { path: '/api/swarms/other' })).status, 404);
    assert.equal((await request(port, { path: '/api/swarms/a%2Fb' })).status, 404);
    assert.equal((await request(port, { path: '/api/swarms/bad$id' })).status, 404);
  });

  test('the UI files come from a fixed map; a missing file is 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'http-ui-'));
    try {
      await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
      const uiFiles = new Map([
        ['/', { file: join(dir, 'index.html'), contentType: 'text/html; charset=utf-8' }],
        ['/app.js', { file: join(dir, 'missing.js'), contentType: 'text/javascript; charset=utf-8' }],
      ]);
      const { port } = await start({ uiFiles });
      const page = await request(port, { path: '/' });
      assert.equal(page.status, 200);
      assert.equal(page.body, '<h1>hi</h1>');
      assert.equal((await request(port, { path: '/app.js' })).status, 404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('report route', () => {
  test('returns the text as text/plain with nosniff', async () => {
    const { port } = await start();
    const res = await request(port, { path: '/api/swarms/known/nodes/scout-r1/report' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    const headerNames = res.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
    assert.equal(headerNames.filter((name) => name === 'x-content-type-options').length, 1);
    assert.equal(res.body, 'plain report text');
  });

  test('a key with no report is 404', async () => {
    const { port } = await start();
    assert.equal((await request(port, { path: '/api/swarms/known/nodes/review-r1/report' })).status, 404);
  });

  test('a forbidden path from the store is 404, and any other failure is 500', async () => {
    const forbidden = fakeService();
    forbidden.reportError = new Error('forbidden');
    assert.equal((await request((await start({ service: forbidden })).port, { path: '/api/swarms/known/nodes/scout-r1/report' })).status, 404);

    const broken = fakeService();
    broken.reportError = new Error('disk on fire');
    assert.equal((await request((await start({ service: broken })).port, { path: '/api/swarms/known/nodes/scout-r1/report' })).status, 500);
  });
});

describe('events stream', () => {
  test('an unknown swarm is 404, not a stream', async () => {
    const { port } = await start();
    assert.equal((await request(port, { path: '/api/swarms/other/events' })).status, 404);
  });

  test('HEAD on the stream is refused so it cannot hang', async () => {
    const { port } = await start();
    assert.equal((await request(port, { method: 'HEAD', path: '/api/swarms/known/events' })).status, 405);
  });

  test('HEAD on the stream gets 405 with Allow: GET', async () => {
    const { port } = await start();
    const res = await request(port, { method: 'HEAD', path: '/api/swarms/known/events' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  });

  test('POST on the stream gets 405 with Allow: GET', async () => {
    const { port } = await start();
    const res = await request(port, { method: 'POST', path: '/api/swarms/known/events' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
  });

  test('a snapshot arrives on connect and again within 2 s when the view changes', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      await waitFor(() => snapshots(stream.text).length >= 1);
      assert.match(stream.headers['content-type'], /^text\/event-stream/);
      service.swarm = { ...service.swarm, state: 'complete' };
      await waitFor(() => snapshots(stream.text).length >= 2);
      assert.match(snapshots(stream.text)[1], /"state":"complete"/);
    } finally {
      stream.req.destroy();
    }
  });

  test('new activity is sent as an activity event', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      service.activity.push({ type: 'tool_execution_end', tool: 'read', nodeKey: 'scout-r1' });
      await waitFor(() => stream.text.includes('event: activity'));
      assert.match(stream.text, /"nodeKey":"scout-r1"/);
    } finally {
      stream.req.destroy();
    }
  });

  test('each poll receives the cursors the previous poll returned', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      await waitFor(() => service.follows >= 3);
      assert.deepEqual(service.cursorsSeen[0], {});
      assert.deepEqual(service.cursorsSeen[1], { polls: 1 });
      assert.deepEqual(service.cursorsSeen[2], { polls: 2 });
    } finally {
      stream.req.destroy();
    }
  });

  test('closing the connection stops further polls', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    await waitFor(() => service.follows >= 2);
    stream.req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = service.follows;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(service.follows, after);
  });

  test('polls never overlap, even when a poll takes longer than the interval', async () => {
    const service = fakeService({ delayMs: 60 });
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.req.destroy();
    assert.equal(service.maxInFlight, 1);
    assert.ok(service.follows >= 2, `expected overlapping ticks to be tried, saw ${service.follows} follows`);
  });

  test('a client that disconnects during the first poll stops the timers', async () => {
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const service = fakeService({ gate });
    const { server, port } = await start({ service });
    let serverSocketClosed = false;
    server.on('connection', (socket) => {
      socket.on('close', () => {
        serverSocketClosed = true;
      });
    });
    const req = http.get({ host: '127.0.0.1', port, path: '/api/swarms/known/events', headers: { Host: `127.0.0.1:${port}` } });
    req.on('error', () => {});
    try {
      await waitFor(() => service.follows === 1);
      req.destroy();
      await waitFor(() => serverSocketClosed);
      openGate();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(service.follows, 1);
    } finally {
      // A leaked poll loop would keep the test process alive; a gone swarm ends it on the next poll.
      service.swarm = null;
    }
  });
});

describe('events stream lifecycle', () => {
  test('a view that disappears mid-stream sends a gone event and ends the stream', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      await waitFor(() => snapshots(stream.text).length >= 1);
      service.swarm = null;
      await waitFor(() => stream.ended);
      assert.match(stream.text, /event: gone\ndata: \{\}\n\n$/);
    } finally {
      stream.req.destroy();
    }
  });

  test('a poll that throws sends an error event, and a later poll still streams', async () => {
    const service = fakeService();
    const logged = [];
    const { port } = await start({ service, log: (...args) => logged.push(args) });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      await waitFor(() => snapshots(stream.text).length >= 1);
      service.failNextFollow = true;
      await waitFor(() => stream.text.includes('event: error'));
      service.activity.push({ type: 'tool_execution_end', tool: 'read', nodeKey: 'scout-r1' });
      await waitFor(() => stream.text.includes('event: activity'));
      assert.equal(logged.length, 1);
    } finally {
      stream.req.destroy();
    }
  });

  test('an unchanged view is sent as one snapshot however many polls run', async () => {
    const service = fakeService();
    const { port } = await start({ service });
    const stream = await openStream(port, '/api/swarms/known/events');
    try {
      await waitFor(() => service.follows >= 4);
      assert.equal(snapshots(stream.text).length, 1);
    } finally {
      stream.req.destroy();
    }
  });
});

describe('security headers', () => {
  test('every response carries the CSP, no-store and no-referrer headers', async () => {
    const { port } = await start();
    const responses = [
      await request(port, { path: '/api/swarms' }),
      await request(port, { path: '/nope' }),
      await request(port, { host: 'evil.example' }),
      await request(port, { method: 'POST', path: '/api/swarms' }),
    ];
    for (const res of responses) {
      assert.equal(res.headers['content-security-policy'], CSP);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
    }
  });
});
