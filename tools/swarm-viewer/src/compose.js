import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpHandler } from './adapters/inbound/http.js';
import { createArtifactStore } from './adapters/outbound/artifacts-fs.js';
import { createGitProbe } from './adapters/outbound/git-probe.js';
import { processProbe, systemClock } from './adapters/outbound/system.js';
import { createSwarmService } from './core/use-cases.js';

const UI_DIR = fileURLToPath(new URL('./adapters/inbound/ui/', import.meta.url));
const UI_FILES = new Map([
  ['/', { file: join(UI_DIR, 'index.html'), contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: join(UI_DIR, 'app.js'), contentType: 'text/javascript; charset=utf-8' }],
  ['/activity.js', { file: join(UI_DIR, 'activity.js'), contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: join(UI_DIR, 'styles.css'), contentType: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: join(UI_DIR, 'favicon.svg'), contentType: 'image/svg+xml' }],
]);

// The only file that wires concrete adapters into core. Returns a server that is not yet listening.
export function createApp({ artifactsRoot, piSessionsRoot, showArgs = false, showOutput = false, repoProbe = createGitProbe() }) {
  const store = createArtifactStore({ root: artifactsRoot, allowedRoots: [artifactsRoot, piSessionsRoot] });
  const service = createSwarmService({ store, probe: processProbe, repoProbe, clock: systemClock, showArgs, showOutput });
  const server = createServer(createHttpHandler({ service, uiFiles: UI_FILES, getPort: () => server.address()?.port }));
  return { server };
}
