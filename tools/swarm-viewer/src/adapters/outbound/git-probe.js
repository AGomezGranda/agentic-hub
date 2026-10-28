import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

// Read-only queries only: no status, no diff, no shell. Each runs in the swarm's own cwd.
const BUDGET_MS = 2000;
const MAX_OUTPUT = 64 * 1024;
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
const execFileAsync = promisify(execFile);

async function runGit(args, cwd, timeoutMs) {
  const env = { ...process.env };
  for (const key of GIT_REDIRECTS) delete env[key];
  const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true });
  return stdout;
}

/**
 * @returns {{describe: (cwd: string) => Promise<import('../../core/ports.js').Repo|null>}}
 */
export function createGitProbe({ run = runGit, now = () => performance.now(), ttlMs = 10_000, cache = new Map() } = {}) {
  // One shared deadline for the three queries. A query that starts with no budget left is not run,
  // because a timeout of 0 would mean no timeout. The left budget is floored because execFile
  // rejects fractional timeouts. The race stops a child that never exits from hanging describe.
  async function lookup(cwd, start) {
    const git = async (args) => {
      const left = Math.floor(BUDGET_MS - (now() - start));
      if (left <= 0) return null;
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, left, null);
      });
      try {
        return (await Promise.race([run(args, cwd, left), deadline]))?.trim() || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    const top = await git(['rev-parse', '--show-toplevel']);
    if (top === null) return null;
    // The full ref, not --short: --short prints 'heads/main' when a tag shares the branch name.
    const ref = await git(['symbolic-ref', '--quiet', 'HEAD']);
    const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    const head = branch === null ? await git(['rev-parse', '--short', 'HEAD']) : null;
    return { name: path.basename(top), path: top, branch, head };
  }

  return {
    async describe(cwd) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
      const t = now();
      const hit = cache.get(cwd);
      if (hit && t - hit.at < ttlMs) return hit.promise;
      for (const [key, entry] of cache) if (t - entry.at >= ttlMs) cache.delete(key);
      const promise = lookup(cwd, t);
      cache.set(cwd, { at: t, promise });
      return promise;
    },
  };
}
