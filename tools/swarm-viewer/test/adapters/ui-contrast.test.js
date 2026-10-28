import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STYLES = fileURLToPath(new URL('../../src/adapters/inbound/ui/styles.css', import.meta.url));
const MIN_RATIO = 4.5;
const PAIRS = [
  ['run', 'panel-2'],
  ['ok', 'panel-2'],
  ['fail', 'panel-2'],
  ['stale', 'panel-2'],
  ['paused', 'panel-2'],
  ['muted', 'panel-2'],
  ['muted', 'panel'],
  ['fg', 'panel'],
  ['fg', 'panel-2'],
  ['warn', 'panel'],
  ['muted', 'bg'],
  ['fg', 'bg'],
];
const LIGHT_ROOT = /^:root\s*\{([^}]*)\}/m;
const DARK_ROOT = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
const DECLARATION = /--([\w-]+)\s*:\s*([^;]+);/g;
const HEX = /^#[0-9a-f]{6}$/i;

function declarations(block) {
  return Object.fromEntries([...block.matchAll(DECLARATION)].map(([, name, value]) => [name, value.trim()]));
}

function colour(tokens, name) {
  const value = tokens[name] ?? '';
  assert.match(value, HEX, `--${name} must be a #rrggbb colour`);
  return value;
}

// WCAG 2.x relative luminance of a #rrggbb colour.
function luminance(hex) {
  const digits = hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('swarm viewer stylesheet contrast', () => {
  test('every text pair reaches 4.5:1 in the light and the dark scheme', () => {
    const css = readFileSync(STYLES, 'utf8');
    assert.ok(css.match(LIGHT_ROOT), 'light-scheme :root block not found');
    assert.ok(css.match(DARK_ROOT), 'dark-scheme :root block not found');
    const light = declarations(css.match(LIGHT_ROOT)[1]);
    const dark = { ...light, ...declarations(css.match(DARK_ROOT)[1]) };
    const failures = [];
    for (const [scheme, tokens] of [['light', light], ['dark', dark]]) {
      for (const [text, background] of PAIRS) {
        const ratio = contrast(colour(tokens, text), colour(tokens, background));
        const line = `${scheme} --${text} on --${background}: ${ratio.toFixed(2)}:1`;
        console.log(line);
        if (ratio < MIN_RATIO) failures.push(line);
      }
    }
    assert.deepEqual(failures, []);
  });
});
