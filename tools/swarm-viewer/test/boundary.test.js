import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = join(ROOT, 'src/core');
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(path)));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('core imports no node built-ins, no adapters and no composition root', async () => {
  const files = await jsFiles(CORE);
  assert.ok(files.length >= 3, 'expected the core modules to be found');
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const where = `${relative(ROOT, file)} -> ${specifier}`;
      if (specifier.startsWith('node:') || builtinModules.includes(specifier)) violations.push(where);
      if (/adapters\//.test(specifier) || /compose(\.js)?$/.test(specifier)) violations.push(where);
    }
  }
  assert.deepEqual(violations, []);
});
