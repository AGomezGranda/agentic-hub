#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../src/compose.js';
import { defaultArtifactsRoot } from '../src/adapters/outbound/system.js';

const USAGE = `usage: swarm-viewer [options]

  --artifacts-dir <dir>  pi-subagents async run directory (default: from TMPDIR and your uid)
  --sessions-dir <dir>   pi sessions directory (default: ~/.pi/agent/sessions)
  --port <n>             port on 127.0.0.1 (default: 4317)
  --show-args            show tool arguments
  --show-output          show node tool output (off by default)
  -h, --help             show this help`;

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        'artifacts-dir': { type: 'string' },
        'sessions-dir': { type: 'string' },
        port: { type: 'string', default: '4317' },
        'show-args': { type: 'boolean', default: false },
        'show-output': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 1;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
    console.error(`invalid --port: ${values.port}`);
    return 1;
  }
  let artifactsRoot;
  try {
    artifactsRoot = values['artifacts-dir'] ? path.resolve(values['artifacts-dir']) : defaultArtifactsRoot();
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (values['show-args']) console.error('warning: tool arguments are shown');
  if (values['show-output']) console.error('warning: node tool output is shown');

  const { server } = createApp({
    artifactsRoot,
    piSessionsRoot: path.resolve(values['sessions-dir'] || path.join(os.homedir(), '.pi', 'agent', 'sessions')),
    showArgs: values['show-args'],
    showOutput: values['show-output'],
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `port ${port} is busy; pass --port <n>` : err.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`swarm-viewer on http://127.0.0.1:${port}/ (read-only)`);
  });
  return null;
}

const code = main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
