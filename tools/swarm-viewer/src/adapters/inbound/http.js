import { readFile } from 'node:fs/promises';

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const TEXT = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const REPORT_PATH = /^\/api\/swarms\/([^/]+)\/nodes\/([^/]+)\/report$/;
const EVENTS_PATH = /^\/api\/swarms\/([^/]+)\/events$/;
const SWARM_PATH = /^\/api\/swarms\/([^/]+)$/;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Inbound HTTP adapter. Talks to the swarm service only; never touches the filesystem except for UI files.
 * @param {{service: object, uiFiles?: Map<string, {file: string, contentType: string}>,
 *   getPort: () => number|undefined, pollMs?: number, pingMs?: number, stallMs?: number,
 *   log?: (...args: unknown[]) => void}} options
 */
export function createHttpHandler({ service, uiFiles = new Map(), getPort, pollMs = 1000, pingMs = 15000, stallMs = 60_000, log = console.error }) {
  return async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      if (!hostAllowed(req.headers.host, getPort())) return sendBody(req, res, 403, { 'Content-Type': TEXT }, 'forbidden');
      const pathname = req.url.split('?')[0];
      const allowed = EVENTS_PATH.test(pathname) ? ['GET'] : ['GET', 'HEAD'];
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        return sendBody(req, res, 405, { 'Content-Type': TEXT }, 'method not allowed');
      }
      return await route(req, res, pathname);
    } catch (err) {
      log('swarm-viewer: request failed', err);
      if (res.headersSent) return res.end();
      return sendBody(req, res, 500, { 'Content-Type': TEXT }, 'internal error');
    }
  };

  async function route(req, res, pathname) {
    if (uiFiles.has(pathname)) return serveUi(req, res, uiFiles.get(pathname));
    if (pathname === '/api/swarms') return sendJson(req, res, await service.listSwarms());

    let match = REPORT_PATH.exec(pathname);
    if (match) {
      const [, id, key] = match;
      if (!ID.test(id) || !ID.test(key)) return notFound(req, res);
      return serveReport(req, res, id, key);
    }
    match = EVENTS_PATH.exec(pathname);
    if (match) {
      if (!ID.test(match[1])) return notFound(req, res);
      return streamEvents(req, res, match[1]);
    }
    match = SWARM_PATH.exec(pathname);
    if (match && ID.test(match[1])) {
      const view = await service.getSwarm(match[1]);
      return view ? sendJson(req, res, view) : notFound(req, res);
    }
    return notFound(req, res);
  }

  async function serveUi(req, res, { file, contentType }) {
    let body;
    try {
      body = await readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') return notFound(req, res);
      throw err;
    }
    return sendBody(req, res, 200, { 'Content-Type': contentType }, body);
  }

  async function serveReport(req, res, id, key) {
    let text;
    try {
      text = await service.reportFor(id, key);
    } catch (err) {
      if (err.message !== 'forbidden') throw err;
      text = null;
    }
    return text === null ? notFound(req, res) : sendBody(req, res, 200, { 'Content-Type': TEXT }, text);
  }

  // Each connection keeps its own cursors. One poll runs at a time, so slow polls never overlap.
  async function streamEvents(req, res, id) {
    let cursors = {};
    let lastView = null;
    let closed = false;
    let busy = false;
    let stalledSince = null;
    const timers = [];

    const write = (chunk) => {
      if (!closed) res.write(chunk);
    };
    const apply = ({ view, activity }) => {
      const json = JSON.stringify(view);
      if (json !== lastView) {
        lastView = json;
        write(`event: snapshot\ndata: ${json}\n\n`);
      }
      if (activity.length) write(`event: activity\ndata: ${JSON.stringify(activity)}\n\n`);
    };
    const stop = () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      res.end();
    };
    const tick = async () => {
      if (busy || closed) return;
      // A slow client: skip polls; cursors stay put, so a skip loses nothing. A client that never drains is
      // cut off; end() alone would wait on the unread bytes, so the socket is destroyed.
      // shortcut: records still queued for that client are lost; its reconnect replays only the 2 MiB tail per member.
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        stalledSince ??= Date.now();
        if (Date.now() - stalledSince >= stallMs) {
          stop();
          res.destroy();
        }
        return;
      }
      stalledSince = null;
      busy = true;
      try {
        const next = await service.followSwarm(id, cursors);
        if (closed) return;
        if (!next.view) {
          write('event: gone\ndata: {}\n\n');
          stop();
          return;
        }
        cursors = next.cursors;
        apply(next);
      } catch (err) {
        log('swarm-viewer: poll failed', err);
        write('event: error\ndata: {"message":"poll failed"}\n\n');
      } finally {
        busy = false;
      }
    };

    res.on('close', stop);
    const first = await service.followSwarm(id, cursors);
    if (closed) return;
    if (!first.view) return notFound(req, res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    cursors = first.cursors;
    apply(first);
    timers.push(setInterval(tick, pollMs), setInterval(() => write(': ping\n\n'), pingMs));
  }
}

function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function sendJson(req, res, body) {
  return sendBody(req, res, 200, { 'Content-Type': JSON_TYPE }, JSON.stringify(body));
}

function notFound(req, res) {
  return sendBody(req, res, 404, { 'Content-Type': TEXT }, 'not found');
}

function sendBody(req, res, status, headers, body = '') {
  const buffer = Buffer.from(body);
  res.writeHead(status, { ...headers, 'Content-Length': buffer.length });
  res.end(req.method === 'HEAD' ? undefined : buffer);
}
