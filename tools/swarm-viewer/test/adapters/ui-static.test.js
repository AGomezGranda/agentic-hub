import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/compose.js';

const UI_DIR = fileURLToPath(new URL('../../src/adapters/inbound/ui/', import.meta.url));
const HTTP_SOURCE = fileURLToPath(new URL('../../src/adapters/inbound/http.js', import.meta.url));
const read = (name) => readFile(UI_DIR + name, 'utf8');
const FORBIDDEN = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'];

describe('swarm viewer UI, static checks', () => {
  test('the page scripts render with DOM APIs and text nodes only', async () => {
    for (const file of ['app.js', 'activity.js']) {
      const js = await read(file);
      for (const token of FORBIDDEN) assert.equal(js.includes(token), false, `${file}: ${token}`);
    }
  });

  test('app.js falls back to the newest swarm when the hash is not listed', async () => {
    const js = await read('app.js');
    assert.match(js, /state\.swarms\.some\(\(swarm\) => swarm\.id === hash\) \? hash : state\.swarms\[0\]\?\.id;/);
  });

  test('app.js imports the activity cap, applies it per batch, and resets it on reconnect', async () => {
    const js = await read('app.js');
    assert.match(js, /import \{ keepNewestPerNode \} from '\.\/activity\.js';/);
    assert.match(js, /state\.activity = keepNewestPerNode\(state\.activity\.concat\(JSON\.parse\(event\.data\)\), MAX_ACTIVITY\);/);
    assert.match(js, /addEventListener\('open', \(\) => \{\s*state\.activity = \[\];/);
  });

  test('index.html has no inline script and no on* event attributes', async () => {
    const html = await read('index.html');
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false, 'inline script');
    assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(html), false, 'on* attribute');
  });

  test('the page, script, stylesheet and icon are served with the CSP header', async () => {
    const html = await read('index.html');
    assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
    const app = createApp({ artifactsRoot: '/nonexistent', piSessionsRoot: '/nonexistent' });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${app.server.address().port}`;
      for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/activity.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/favicon.svg', 'image/svg+xml']]) {
        const res = await fetch(base + path);
        assert.equal(res.status, 200, path);
        assert.ok(res.headers.get('content-type').startsWith(type), path);
        assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'", path);
      }
    } finally {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
  });

  test('every element app.js looks up by id exists in index.html', async () => {
    const js = await read('app.js');
    const html = await read('index.html');
    const ids = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 0);
    for (const id of new Set(ids)) assert.match(html, new RegExp(`id="${id}"`), id);
  });

  test('app.js listens for exactly the SSE events the server sends, plus the browser open event', async () => {
    const js = await read('app.js');
    const http = await readFile(HTTP_SOURCE, 'utf8');
    const listened = new Set([...js.matchAll(/addEventListener\('([a-z]+)'/g)].map((m) => m[1]));
    for (const dom of ['click', 'change']) listened.delete(dom);
    const sent = new Set([...http.matchAll(/event: ([a-z]+)\\n/g)].map((m) => m[1]));
    assert.ok(sent.size > 0);
    for (const name of sent) assert.ok(listened.has(name), `server sends ${name}, app.js ignores it`);
    for (const name of listened) assert.ok(name === 'open' || sent.has(name), `app.js listens for ${name}, server never sends it`);
  });

  test('gone and a closed stream clear the swarm so the list refresh reselects', async () => {
    const js = await read('app.js');
    const body = (event) => {
      const start = js.indexOf(`source.addEventListener('${event}'`);
      assert.notEqual(start, -1, event);
      return js.slice(start, js.indexOf('\n  });', start));
    };
    const gone = body('gone');
    assert.match(gone, /state\.swarmId = null;/);
    assert.match(gone, /state\.view = null;/);
    assert.match(gone, /render\(\);/);
    assert.match(js, /if \(!state\.swarmId\) \{/);
    const error = body('error');
    const closed = error.slice(error.indexOf('EventSource.CLOSED'));
    assert.match(closed, /^EventSource\.CLOSED\) \{\s*source\.close\(\);\s*state\.swarmId = null;\s*state\.view = null;\s*state\.activity = \[\];\s*setLink\([^)]*\);\s*render\(\);\s*\} else/);
    assert.match(gone, /state\.activity = \[\];/);
    assert.equal(error.slice(0, error.indexOf('EventSource.CLOSED')).includes('swarmId'), false);
    assert.equal(closed.slice(closed.indexOf('} else')).includes('swarmId'), false);
  });

  test('the link status is announced to assistive tech', async () => {
    assert.match(await read('index.html'), /<p id="link-status" class="link-status" role="status">/);
  });
});
