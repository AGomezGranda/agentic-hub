import {
	ArtifactRef as ArtifactRefSchema,
	type RunEvent,
	RunEventBody,
} from "@payo/contracts";
import { type RunStore, StaleSeqError } from "../application/store.ts";
import { assertSha256, sha256Hex } from "../domain/artifacts.ts";

export interface MemoryBacking {
	events: Map<string, RunEvent[]>;
	artifacts: Map<string, Uint8Array>;
}

export function createMemoryRunStore(
	backing: MemoryBacking = { events: new Map(), artifacts: new Map() },
): RunStore {
	return {
		async append(runId, events, expectedSeq) {
			if (events.length === 0) return;
			const parsed = events.map((body) => RunEventBody.parse(body));
			// Yield like real I/O, so concurrent appends interleave and the contract race is real.
			await Promise.resolve();
			const log = backing.events.get(runId) ?? [];
			const actual = log.at(-1)?.seq ?? 0;
			if (actual !== expectedSeq) throw new StaleSeqError(expectedSeq, actual);
			const at = new Date().toISOString();
			// JSON round-trip copies the caller's data, so stored rows are independent of the caller's objects.
			const rows = parsed.map(
				(body, i) =>
					JSON.parse(
						JSON.stringify({ ...body, seq: expectedSeq + i + 1, at }),
					) as RunEvent,
			);
			backing.events.set(runId, [...log, ...rows]);
		},

		async read(runId, fromSeq = 1) {
			return (backing.events.get(runId) ?? [])
				.filter((event) => event.seq >= fromSeq)
				.map((event) => structuredClone(event));
		},

		async listRunIds() {
			return [...backing.events.keys()].sort();
		},

		async putArtifact(content, meta) {
			// Validate before storing, so rejected metadata leaves no readable bytes behind.
			const ref = ArtifactRefSchema.parse({
				sha256: sha256Hex(content),
				size: content.byteLength,
				kind: meta.kind,
				mediaType: meta.mediaType,
			});
			if (!backing.artifacts.has(ref.sha256))
				backing.artifacts.set(ref.sha256, new Uint8Array(content));
			return ref;
		},

		async readArtifact(sha256) {
			assertSha256(sha256);
			const bytes = backing.artifacts.get(sha256);
			if (!bytes) throw new Error(`artifact ${sha256} not found`);
			return new Uint8Array(bytes);
		},

		async close() {},
	};
}
