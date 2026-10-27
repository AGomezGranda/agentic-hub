// Ports: what core needs from the outside world. Adapters implement these; core never imports them.

/**
 * @typedef {object} ArtifactStore
 * @property {() => Promise<string[]>} listRunIds
 * @property {(runId: string) => Promise<object|null>} readStatus
 * @property {(runId: string, file: string) => Promise<object|null>} readJson
 * @property {(runId: string, file: string, fromOffset: number|null) =>
 *   Promise<{records: object[], nextOffset: number|null, skipped: number}>} readEventsFrom
 * @property {(absPath: string, maxBytes: number) => Promise<string|null>} readText
 */

/** @typedef {{ isAlive: (pid: number) => boolean }} ProcessProbe */

/** @typedef {{ now: () => number }} Clock */

export {};
