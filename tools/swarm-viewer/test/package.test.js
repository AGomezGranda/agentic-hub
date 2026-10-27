import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package declares no runtime or dev dependencies', () => {
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(key in pkg, false, `unexpected ${key}`);
  }
});

test('package is an ES module that requires Node 22 or newer', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22');
});

test('the bin entry exists on disk', async () => {
  await access(new URL('../bin/swarm-viewer.js', import.meta.url));
  assert.equal(pkg.bin['swarm-viewer'], 'bin/swarm-viewer.js');
});
