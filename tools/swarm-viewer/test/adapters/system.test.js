import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultArtifactsRoot, processProbe, systemClock } from '../../src/adapters/outbound/system.js';

describe('processProbe', () => {
  test('the running test process is alive', () => {
    assert.equal(processProbe.isAlive(process.pid), true);
  });

  test('the pid of a child that has already exited is not alive', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(processProbe.isAlive(child.pid), false);
  });

  test('pids that cannot name a process are not alive', () => {
    assert.equal(processProbe.isAlive(0), false);
    assert.equal(processProbe.isAlive(-1), false);
    assert.equal(processProbe.isAlive(Number.NaN), false);
  });

  test('a pid beyond the 31-bit range is not alive and does not throw', () => {
    assert.equal(processProbe.isAlive(2 ** 40), false);
  });
});

describe('systemClock', () => {
  test('now is the wall clock in milliseconds', () => {
    assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000);
  });
});

describe('defaultArtifactsRoot', () => {
  const tmpdir = () => '/tmp/fake';

  test('unset env gives <tmp>/pi-subagents-uid-<uid>/async-subagent-runs', () => {
    assert.equal(
      defaultArtifactsRoot({ env: {}, tmpdir, getuid: () => 502 }),
      join('/tmp/fake', 'pi-subagents-uid-502', 'async-subagent-runs'),
    );
  });

  test('PI_SUBAGENTS_TEMP_ROOT is used as the temp root, trimmed and resolved', () => {
    assert.equal(
      defaultArtifactsRoot({ env: { PI_SUBAGENTS_TEMP_ROOT: '  /x  ' }, tmpdir, getuid: () => 502 }),
      join('/x', 'async-subagent-runs'),
    );
  });

  test('without a uid and without the env override it throws, asking for --artifacts-dir', () => {
    assert.throws(() => defaultArtifactsRoot({ env: {}, tmpdir, getuid: undefined }), /--artifacts-dir/);
  });

  test('the env override needs no uid', () => {
    assert.equal(
      defaultArtifactsRoot({ env: { PI_SUBAGENTS_TEMP_ROOT: '/x' }, tmpdir, getuid: undefined }),
      join('/x', 'async-subagent-runs'),
    );
  });
});
