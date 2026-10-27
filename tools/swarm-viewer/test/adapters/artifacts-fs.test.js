import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from '../../src/adapters/outbound/artifacts-fs.js';

const MiB = 1024 * 1024;
let dir;
let runs;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artifacts-fs-'));
  runs = join(dir, 'async-subagent-runs');
  await mkdir(runs);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const store = (extra = {}) => createArtifactStore({ root: runs, allowedRoots: [runs], ...extra });
const line = (obj) => `${JSON.stringify(obj)}\n`;

describe('listRunIds', () => {
  test('a missing root gives an empty list', async () => {
    const missing = createArtifactStore({ root: join(dir, 'nope'), allowedRoots: [] });
    assert.deepEqual(await missing.listRunIds(), []);
  });

  test('plain files and unsafe names are ignored', async () => {
    await mkdir(join(runs, 'run-a'));
    await mkdir(join(runs, 'run-b'));
    await writeFile(join(runs, 'stray.txt'), 'x');
    await mkdir(join(runs, 'has space'));
    assert.deepEqual((await store().listRunIds()).sort(), ['run-a', 'run-b']);
  });
});

describe('readStatus and readJson', () => {
  test('a malformed status.json reads as null and does not throw', async () => {
    await mkdir(join(runs, 'r1'));
    await writeFile(join(runs, 'r1', 'status.json'), '{"state": "run');
    assert.equal(await store().readStatus('r1'), null);
  });

  test('a missing status.json reads as null', async () => {
    await mkdir(join(runs, 'r1'));
    assert.equal(await store().readStatus('r1'), null);
  });

  test('a status.json that turns malformed keeps the last valid value', async () => {
    await mkdir(join(runs, 'r1'));
    const path = join(runs, 'r1', 'status.json');
    await writeFile(path, JSON.stringify({ state: 'running' }));
    const s = store();
    assert.equal((await s.readStatus('r1')).state, 'running');
    await writeFile(path, '{"state": "comp');
    assert.deepEqual(await s.readStatus('r1'), { state: 'running' });
  });

  test('a status.json that is a directory reads as null and does not throw', async () => {
    await mkdir(join(runs, 'r1', 'status.json'), { recursive: true });
    assert.equal(await store().readStatus('r1'), null);
  });

  test('a run path that is a regular file (ENOTDIR) reads as null and does not throw', async () => {
    await writeFile(join(runs, 'r1'), 'not a directory');
    assert.equal(await store().readStatus('r1'), null);
  });

  test('a status.json that becomes unreadable (EACCES) keeps the last valid value', { skip: process.getuid?.() === 0 }, async () => {
    await mkdir(join(runs, 'r1'));
    const path = join(runs, 'r1', 'status.json');
    await writeFile(path, JSON.stringify({ state: 'running' }));
    const s = store();
    assert.equal((await s.readStatus('r1')).state, 'running');
    await writeFile(path, JSON.stringify({ state: 'complete', endedAt: 5 }));
    await chmod(path, 0o000);
    assert.deepEqual(await s.readStatus('r1'), { state: 'running' });
  });

  test('a status.json symlink loop (ELOOP) keeps the last valid value', async () => {
    await mkdir(join(runs, 'r1'));
    const path = join(runs, 'r1', 'status.json');
    await writeFile(path, JSON.stringify({ state: 'running' }));
    const s = store();
    assert.equal((await s.readStatus('r1')).state, 'running');
    await rm(path);
    await symlink(path, path);
    assert.deepEqual(await s.readStatus('r1'), { state: 'running' });
  });

  test('a status.json symlink loop with no earlier read reads as null and does not throw', async () => {
    await mkdir(join(runs, 'r1'));
    const path = join(runs, 'r1', 'status.json');
    await symlink(path, path);
    assert.equal(await store().readStatus('r1'), null);
  });

  test('a non-string run id reads as null and does not throw', async () => {
    assert.equal(await store().readStatus(undefined), null);
    assert.equal(await store().readStatus(5), null);
  });

  test('a changed status.json is re-read', async () => {
    await mkdir(join(runs, 'r1'));
    const path = join(runs, 'r1', 'status.json');
    await writeFile(path, JSON.stringify({ state: 'running' }));
    const s = store();
    assert.equal((await s.readStatus('r1')).state, 'running');
    await writeFile(path, JSON.stringify({ state: 'complete', endedAt: 5 }));
    assert.equal((await s.readStatus('r1')).state, 'complete');
  });

  test('an unsafe run id never reads outside the root', async () => {
    assert.equal(await store().readStatus('..'), null);
    assert.equal(await store().readStatus('../r1'), null);
  });
});

describe('readEventsFrom', () => {
  test('a partial trailing line waits for its newline; the next read returns only new records', async () => {
    await mkdir(join(runs, 'r1'));
    const file = join(runs, 'r1', 'events.jsonl');
    await writeFile(file, line({ n: 1 }) + '{"n":2');
    const s = store();
    const first = await s.readEventsFrom('r1', 'events.jsonl', null);
    assert.deepEqual(first.records, [{ n: 1 }]);
    await appendFile(file, ',"x":1}\n' + line({ n: 3 }));
    const second = await s.readEventsFrom('r1', 'events.jsonl', first.nextOffset);
    assert.deepEqual(second.records, [{ n: 2, x: 1 }, { n: 3 }]);
  });

  test('a file shorter than the saved offset restarts from 0', async () => {
    await mkdir(join(runs, 'r1'));
    const file = join(runs, 'r1', 'events.jsonl');
    await writeFile(file, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
    const s = store();
    const first = await s.readEventsFrom('r1', 'events.jsonl', null);
    await writeFile(file, line({ fresh: true }));
    const after = await s.readEventsFrom('r1', 'events.jsonl', first.nextOffset);
    assert.deepEqual(after.records, [{ fresh: true }]);
  });

  test('a backlog on a 3 MiB file returns only whole lines, from the last 2 MiB', async () => {
    await mkdir(join(runs, 'r1'));
    const file = join(runs, 'r1', 'events.jsonl');
    const pad = 'x'.repeat(1000);
    const count = Math.ceil((3 * MiB) / Buffer.byteLength(line({ i: 0, pad })));
    const text = Array.from({ length: count }, (_, i) => line({ i, pad })).join('');
    await writeFile(file, text);
    const page = await store().readEventsFrom('r1', 'events.jsonl', null);
    assert.ok(page.records.length > 0);
    assert.ok(page.records[0].i > 0, 'the backlog must not start at the top of the file');
    assert.equal(page.records.at(-1).i, count - 1);
    assert.equal(page.nextOffset, Buffer.byteLength(text));
    assert.equal(page.skipped, 0);
  });

  test('a malformed line is skipped and counted, and reading carries on', async () => {
    await mkdir(join(runs, 'r1'));
    await writeFile(join(runs, 'r1', 'events.jsonl'), line({ n: 1 }) + 'not json\n' + line({ n: 2 }));
    const page = await store().readEventsFrom('r1', 'events.jsonl', null);
    assert.deepEqual(page.records, [{ n: 1 }, { n: 2 }]);
    assert.equal(page.skipped, 1);
  });

  test('a missing events file reads as an empty page with a null cursor', async () => {
    assert.deepEqual(await store().readEventsFrom('nope', 'events.jsonl', null), { records: [], nextOffset: null, skipped: 0 });
  });

  test('an events path that is a directory reads as an empty page and does not throw', async () => {
    await mkdir(join(runs, 'r1', 'events.jsonl'), { recursive: true });
    assert.deepEqual(await store().readEventsFrom('r1', 'events.jsonl', null), { records: [], nextOffset: null, skipped: 0 });
  });

  test('after a failed read, a null cursor still gets the 2 MiB tail, not a replay from byte 0', async () => {
    await mkdir(join(runs, 'r1'));
    const file = join(runs, 'r1', 'events.jsonl');
    await mkdir(file);
    const s = store();
    const failed = await s.readEventsFrom('r1', 'events.jsonl', null);
    assert.deepEqual(failed, { records: [], nextOffset: null, skipped: 0 });
    await rm(file, { recursive: true });
    const pad = 'x'.repeat(1000);
    const lineBytes = Buffer.byteLength(line({ i: 0, pad }));
    const count = Math.ceil((3 * MiB) / lineBytes);
    await writeFile(file, Array.from({ length: count }, (_, i) => line({ i, pad })).join(''));
    const page = await s.readEventsFrom('r1', 'events.jsonl', failed.nextOffset);
    assert.ok(page.records[0].i > 0, 'the backlog must not restart from byte 0');
    assert.ok(page.records.length * lineBytes <= 2 * MiB, 'the backlog must be capped at 2 MiB');
  });

  test('an unreadable events file reads as an empty page at the saved offset', { skip: process.getuid?.() === 0 }, async () => {
    await mkdir(join(runs, 'r1'));
    const file = join(runs, 'r1', 'events.jsonl');
    await writeFile(file, line({ n: 1 }));
    await chmod(file, 0o000);
    assert.deepEqual(await store().readEventsFrom('r1', 'events.jsonl', 9), { records: [], nextOffset: 9, skipped: 0 });
  });

  test('an unsafe run id reads as an empty page and never reads outside the root', async () => {
    await writeFile(join(dir, 'events.jsonl'), line({ outside: true }));
    await mkdir(join(dir, 'r1'));
    await writeFile(join(dir, 'r1', 'events.jsonl'), line({ outside: true }));
    assert.deepEqual(await store().readEventsFrom('..', 'events.jsonl', null), { records: [], nextOffset: null, skipped: 0 });
    assert.deepEqual(await store().readEventsFrom('../r1', 'events.jsonl', null), { records: [], nextOffset: null, skipped: 0 });
  });
});

describe('readText', () => {
  let outside;
  let sessions;
  beforeEach(async () => {
    outside = join(dir, 'outside');
    sessions = join(dir, 'sessions');
    await mkdir(outside);
    await mkdir(sessions);
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
  });

  const reader = () => createArtifactStore({ root: runs, allowedRoots: [runs, sessions] });

  test('a symlink inside an allowed root that points outside is forbidden', async () => {
    await symlink(join(outside, 'secret.txt'), join(sessions, 'link.md'));
    await assert.rejects(reader().readText(join(sessions, 'link.md'), 100), { message: 'forbidden' });
  });

  test('a path outside every allowed root is forbidden', async () => {
    await assert.rejects(reader().readText(join(outside, 'secret.txt'), 100), { message: 'forbidden' });
  });

  test('a sibling directory that shares the allowed root name as a prefix is forbidden', async () => {
    const evil = join(dir, 'sessions-evil');
    await mkdir(evil);
    await writeFile(join(evil, 'secret.md'), 'SECRET');
    await assert.rejects(reader().readText(join(evil, 'secret.md'), 100), { message: 'forbidden' });
  });

  test('a file under an allowed root is read, capped at maxBytes', async () => {
    const report = join(sessions, 'report.md');
    await writeFile(report, 'a'.repeat(50));
    assert.equal(await reader().readText(report, 10), 'a'.repeat(10));
    assert.equal(await reader().readText(report, 1000), 'a'.repeat(50));
  });

  test('a missing file reads as null', async () => {
    assert.equal(await reader().readText(join(sessions, 'gone.md'), 10), null);
  });

  test('a report path that is a symlink loop reads as null', async () => {
    const loop = join(sessions, 'loop.md');
    await symlink(loop, loop);
    assert.equal(await reader().readText(loop, 100), null);
  });

  test('a report path that is a directory reads as null', async () => {
    await mkdir(join(sessions, 'report.md'));
    assert.equal(await reader().readText(join(sessions, 'report.md'), 100), null);
  });

  test('an unreadable report reads as null', { skip: process.getuid?.() === 0 }, async () => {
    const report = join(sessions, 'locked.md');
    await writeFile(report, 'hidden');
    await chmod(report, 0o000);
    assert.equal(await reader().readText(report, 100), null);
  });

  test('a file cut mid-character by maxBytes still returns valid text (no throw)', async () => {
    const report = join(sessions, 'utf.md');
    await writeFile(report, 'é'.repeat(10));
    const text = await reader().readText(report, 3);
    assert.equal(typeof text, 'string');
    assert.ok(text.length >= 1);
  });
});
