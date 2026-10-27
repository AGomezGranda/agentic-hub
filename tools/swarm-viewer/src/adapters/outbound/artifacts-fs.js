import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TAIL_BYTES = 2 * 1024 * 1024;
const NEWLINE = 0x0a;

const isSafeId = (id) => typeof id === 'string' && SAFE_ID.test(id) && id !== '.' && id !== '..';

/**
 * Filesystem implementation of the ArtifactStore port.
 * @param {{root: string, allowedRoots: string[]}} options root is the async-subagent-runs directory.
 */
export function createArtifactStore({ root, allowedRoots }) {
  const jsonCache = new Map();

  // A failed read or parse means "unreadable this poll" (a live writer, a loop, a lock), not an error.
  async function readJson(runId, file) {
    if (!isSafeId(runId)) return null;
    const abs = path.join(root, runId, file);
    try {
      const info = await fs.stat(abs);
      const hit = jsonCache.get(abs);
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value;
      const value = JSON.parse(await fs.readFile(abs, 'utf8'));
      jsonCache.set(abs, { mtimeMs: info.mtimeMs, size: info.size, value });
      return value;
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err.code)) return null;
      if (err instanceof SyntaxError || typeof err.code === 'string') return jsonCache.get(abs)?.value ?? null;
      throw err;
    }
  }

  async function listRunIds() {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map((entry) => entry.name);
  }

  // Returns complete lines only. Starts 2 MiB from the end when fromOffset is null.
  async function readEventsFrom(runId, file, fromOffset) {
    const empty = { records: [], nextOffset: fromOffset, skipped: 0 };
    if (!isSafeId(runId)) return empty;
    let handle;
    try {
      handle = await fs.open(path.join(root, runId, file), 'r');
    } catch (err) {
      if (typeof err.code === 'string') return empty;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      let start = fromOffset ?? Math.max(0, size - TAIL_BYTES);
      if (start > size) start = 0; // truncated or rotated
      let text = await readRange(handle, start, size - start);
      let base = start;
      if (fromOffset === null && start > 0) {
        const newline = text.indexOf(NEWLINE);
        if (newline === -1) return { records: [], nextOffset: size, skipped: 0 };
        base = start + newline + 1;
        text = text.subarray(newline + 1);
      }
      const last = text.lastIndexOf(NEWLINE);
      if (last === -1) return { records: [], nextOffset: base, skipped: 0 };
      const records = [];
      let skipped = 0;
      for (const lineText of text.subarray(0, last + 1).toString('utf8').split('\n')) {
        if (lineText === '') continue;
        try {
          records.push(JSON.parse(lineText));
        } catch {
          skipped += 1;
        }
      }
      return { records, nextOffset: base + last + 1, skipped };
    } catch (err) {
      if (typeof err.code === 'string') return empty;
      throw err;
    } finally {
      await handle.close();
    }
  }

  // Reads a report, but only from a file whose realpath sits under an allowed root.
  async function readText(absPath, maxBytes) {
    let real;
    try {
      real = await fs.realpath(absPath);
    } catch (err) {
      if (typeof err.code === 'string') return null;
      throw err;
    }
    if (!(await isUnderAllowedRoot(real))) throw new Error('forbidden');
    let handle;
    try {
      handle = await fs.open(real, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buf = await readRange(handle, 0, length);
      return buf.toString('utf8');
    } catch (err) {
      if (typeof err.code === 'string') return null;
      throw err;
    } finally {
      await handle?.close();
    }
  }

  async function isUnderAllowedRoot(real) {
    for (const allowed of allowedRoots) {
      let base;
      try {
        base = await fs.realpath(allowed);
      } catch {
        continue; // a missing root cannot contain the path
      }
      if (real.startsWith(base + path.sep)) return true;
    }
    return false;
  }

  return {
    listRunIds,
    readStatus: (runId) => readJson(runId, 'status.json'),
    readJson,
    readEventsFrom,
    readText,
  };
}

async function readRange(handle, position, length) {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buf.subarray(0, filled);
}
