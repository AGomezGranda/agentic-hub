import os from 'node:os';
import path from 'node:path';

const RUNS_DIR = 'async-subagent-runs';

// EPERM means the process exists under another user.
export const processProbe = {
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err.code === 'EPERM') return true;
      if (err.code === 'ESRCH') return false;
      throw err;
    }
  },
};

export const systemClock = { now: () => Date.now() };

// Mirrors pi-subagents (src/shared/types.js): PI_SUBAGENTS_TEMP_ROOT, else <tmpdir>/pi-subagents-uid-<uid>.
export function defaultArtifactsRoot(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return path.join(path.resolve(configured), RUNS_DIR);
  const getuid = Object.hasOwn(options, 'getuid') ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid !== 'function') throw new Error('process.getuid is unavailable on this platform; pass --artifacts-dir');
  const tmp = (options.tmpdir ?? os.tmpdir)();
  return path.join(tmp, `pi-subagents-uid-${getuid()}`, RUNS_DIR);
}
