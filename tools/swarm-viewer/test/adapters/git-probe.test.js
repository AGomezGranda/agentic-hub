import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createGitProbe } from '../../src/adapters/outbound/git-probe.js';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });
const init = async (dir) => {
  await mkdir(dir, { recursive: true });
  await exec('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
};
const commit = (dir) => git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');

describe('git probe on real repositories', () => {
  let base;
  let root;
  let savedCeiling;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'git-probe-'));
    root = await realpath(base);
    // An ancestor repo above the temp root cannot answer for these directories.
    savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  });

  after(async () => {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    await rm(base, { recursive: true, force: true });
  });

  const probe = () => createGitProbe();

  test('a checked-out branch is reported by name, with no head', async () => {
    const dir = join(root, 'feat');
    await init(dir);
    await commit(dir);
    await git(dir, 'checkout', '-q', '-b', 'feature/x');
    assert.deepEqual(await probe().describe(dir), { name: 'feat', path: dir, branch: 'feature/x', head: null });
  });

  test('a detached HEAD has no branch and a short head hash', async () => {
    const dir = join(root, 'detached');
    await init(dir);
    await commit(dir);
    await git(dir, 'checkout', '-q', '--detach');
    const repo = await probe().describe(dir);
    assert.equal(repo.branch, null);
    assert.match(repo.head, /^[0-9a-f]{7,}$/);
  });

  test('a subdirectory resolves to the same top-level path and name', async () => {
    const dir = join(root, 'sub-repo');
    await init(dir);
    await commit(dir);
    const sub = join(dir, 'a', 'b');
    await mkdir(sub, { recursive: true });
    assert.deepEqual(await probe().describe(sub), { name: 'sub-repo', path: dir, branch: 'main', head: null });
  });

  test('an unborn branch reports its name and no head, without throwing', async () => {
    const dir = join(root, 'unborn');
    await init(dir);
    assert.deepEqual(await probe().describe(dir), { name: 'unborn', path: dir, branch: 'main', head: null });
  });

  test('GIT_DIR in the environment does not redirect the lookup to another repo', async () => {
    const mine = join(root, 'env-mine');
    const other = join(root, 'env-other');
    await init(mine);
    await commit(mine);
    await git(mine, 'checkout', '-q', '-b', 'feature/x');
    await init(other);
    await commit(other);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      assert.equal((await probe().describe(mine)).branch, 'feature/x');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test('a plain directory, a missing directory and a relative path give null', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    const p = probe();
    assert.equal(await p.describe(plain), null);
    assert.equal(await p.describe(join(root, 'missing')), null);
    assert.equal(await p.describe('relative/dir'), null);
  });
});

describe('git probe with a fake run', () => {
  const TOP = '/work/proj';
  const MAIN = { 'rev-parse --show-toplevel': `${TOP}\n`, 'symbolic-ref --quiet --short HEAD': 'main\n' };

  function fake(answers) {
    const calls = [];
    const run = async (args, cwd, timeoutMs) => {
      calls.push({ args, cwd, timeoutMs });
      const answer = answers[args.join(' ')];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unexpected: ${args.join(' ')}`);
      return answer;
    };
    return { run, calls };
  }

  test('runs exactly the three read-only queries, in order, in the given cwd', async () => {
    const { run, calls } = fake({
      'rev-parse --show-toplevel': `${TOP}\n`,
      'symbolic-ref --quiet --short HEAD': new Error('detached'),
      'rev-parse --short HEAD': 'abc1234\n',
    });
    const cwd = `${TOP}/src`;
    assert.deepEqual(await createGitProbe({ run, now: () => 0 }).describe(cwd), { name: 'proj', path: TOP, branch: null, head: 'abc1234' });
    assert.deepEqual(calls.map((c) => c.args), [
      ['rev-parse', '--show-toplevel'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['rev-parse', '--short', 'HEAD'],
    ]);
    assert.ok(calls.every((c) => c.cwd === cwd));
  });

  test('a named branch skips the head query', async () => {
    const { run, calls } = fake(MAIN);
    assert.deepEqual(await createGitProbe({ run, now: () => 0 }).describe(TOP), { name: 'proj', path: TOP, branch: 'main', head: null });
    assert.equal(calls.length, 2);
  });

  test('a relative path, or a non-string, gives null and spawns nothing', async () => {
    const { run, calls } = fake(MAIN);
    const p = createGitProbe({ run, now: () => 0 });
    assert.equal(await p.describe('proj'), null);
    assert.equal(await p.describe(undefined), null);
    assert.equal(calls.length, 0);
  });

  test('a second call inside the TTL runs nothing; after the TTL it runs again', async () => {
    let t = 0;
    const { run, calls } = fake(MAIN);
    const p = createGitProbe({ run, now: () => t, ttlMs: 10_000 });
    await p.describe(TOP);
    const first = calls.length;
    t = 9_999;
    await p.describe(TOP);
    assert.equal(calls.length, first);
    t = 10_000;
    await p.describe(TOP);
    assert.equal(calls.length, first * 2);
  });

  test('concurrent calls share one lookup', async () => {
    const { run, calls } = fake(MAIN);
    const p = createGitProbe({ run, now: () => 0 });
    const [a, b] = await Promise.all([p.describe(TOP), p.describe(TOP)]);
    assert.equal(calls.length, 2);
    assert.deepEqual(a, b);
  });

  test('a failed lookup is cached as null', async () => {
    const { run, calls } = fake({ 'rev-parse --show-toplevel': new Error('not a repo') });
    const p = createGitProbe({ run, now: () => 0 });
    assert.equal(await p.describe(TOP), null);
    assert.equal(await p.describe(TOP), null);
    assert.equal(calls.length, 1);
  });

  test('entries older than the TTL are dropped when a new one is inserted', async () => {
    let t = 0;
    const cache = new Map();
    const p = createGitProbe({ run: fake(MAIN).run, now: () => t, ttlMs: 10_000, cache });
    await p.describe('/a');
    assert.equal(cache.size, 1);
    t = 10_000;
    await p.describe('/b');
    assert.deepEqual([...cache.keys()], ['/b']);
  });

  test('a run that rejects or throws only fails its own query; describe still resolves', async () => {
    const run = (args) => {
      if (args[1] === '--show-toplevel') return Promise.resolve(`${TOP}\n`);
      if (args[0] === 'symbolic-ref') return Promise.reject(new Error('rejected'));
      throw new Error('thrown');
    };
    assert.deepEqual(await createGitProbe({ run, now: () => 0 }).describe(TOP), { name: 'proj', path: TOP, branch: null, head: null });
    const broken = createGitProbe({ run: () => { throw new Error('boom'); }, now: () => 0 });
    assert.equal(await broken.describe(TOP), null);
  });

  test('the three queries share one 2 s budget; a query past the deadline is not run', async () => {
    let t = 0;
    const calls = [];
    const run = async (args, cwd, timeoutMs) => {
      calls.push(timeoutMs);
      t += 1500;
      if (args[1] === '--show-toplevel') return `${TOP}\n`;
      if (args[0] === 'symbolic-ref') throw new Error('detached');
      return 'abc1234\n';
    };
    const repo = await createGitProbe({ run, now: () => t }).describe(TOP);
    assert.deepEqual(calls, [2000, 500]);
    assert.deepEqual(repo, { name: 'proj', path: TOP, branch: null, head: null });
  });
});
