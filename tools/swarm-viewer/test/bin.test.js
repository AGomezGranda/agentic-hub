import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/swarm-viewer.js', import.meta.url));

// No case here serves requests: each exits before listen() or on EADDRINUSE.
function runBin(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 10_000 });
}

describe('bin/swarm-viewer.js', () => {
  test('a non-numeric --port exits 1 and names the bad value', () => {
    const result = runBin('--port', 'abc');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid --port: abc/);
  });

  test('an unknown flag exits 1 and prints usage', () => {
    const result = runBin('--bogus-flag');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  });

  test('--help exits 0 and prints usage on stdout', () => {
    const result = runBin('--help');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /usage/);
  });

  test('a --port that is already held exits 1 and says it is busy', async () => {
    const holder = net.createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    try {
      const result = runBin('--port', String(holder.address().port));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /is busy/);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
