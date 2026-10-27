// Copies test/fixtures (scrubbed from a real swarm, canaries planted) into a temp dir.
// Receipts hold a {{SESSIONS_ROOT}} placeholder; it is replaced with the copy's sessions dir.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export async function materializeFixtures() {
  const base = await mkdtemp(join(tmpdir(), 'swarm-viewer-fixture-'));
  await cp(FIXTURES, base, { recursive: true });
  const sessionsRoot = join(base, 'sessions');
  await replacePlaceholder(join(base, 'artifacts'), '{{SESSIONS_ROOT}}', JSON.stringify(sessionsRoot).slice(1, -1));
  return {
    artifactsRoot: join(base, 'artifacts', 'async-subagent-runs'),
    sessionsRoot,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function replacePlaceholder(dir, from, to) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await replacePlaceholder(path, from, to);
    else if (entry.name.endsWith('.json')) {
      const text = await readFile(path, 'utf8');
      if (text.includes(from)) await writeFile(path, text.split(from).join(to));
    }
  }
}
