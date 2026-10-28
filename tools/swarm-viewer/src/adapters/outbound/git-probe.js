import { execFile } from 'node:child_process';
import path from 'node:path';

// Read-only queries only: no status, no diff, no shell. Each runs in the swarm's own cwd.
const BUDGET_MS = 2000;
const MAX_OUTPUT = 64 * 1024;
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];

function runGit(args, cwd, timeoutMs) {
  const env = { ...process.env };
  for (const key of GIT_REDIRECTS) delete env[key];
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * @returns {{describe: (cwd: string) => Promise<import('../../core/ports.js').Repo|null>}}
 */
export function createGitProbe({ run = runGit, now = Date.now, ttlMs = 10_000, cache = new Map() } = {}) {
  // One shared deadline for the three queries. A query that starts with no budget left is not run,
  // because a timeout of 0 would mean no timeout.
  async function lookup(cwd, start) {
    const git = async (args) => {
      const left = BUDGET_MS - (now() - start);
      if (left <= 0) return null;
      try {
        const out = await run(args, cwd, left);
        return typeof out === 'string' && out.trim() !== '' ? out.trim() : null;
      } catch {
        return null;
      }
    };
    const top = await git(['rev-parse', '--show-toplevel']);
    if (top === null) return null;
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
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
