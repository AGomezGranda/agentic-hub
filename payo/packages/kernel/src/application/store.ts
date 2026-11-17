import type {
	ArtifactRef,
	RunEvent,
	RunEventBody,
	RunId,
	RunIdInput,
} from "@payo/contracts";

export interface RunStore {
	/** Serializes acceptance within this store instance; a failure does not block later requests. */
	serializeAcceptance<T>(work: () => Promise<T>): Promise<T>;
	/** Appends bodies after `expectedSeq`; the store assigns `seq` and `at`. An empty batch is a no-op. */
	append(
		runId: RunIdInput,
		events: RunEventBody[],
		expectedSeq: number,
	): Promise<void>;
	/** Events with `seq >= fromSeq`, in seq order. */
	read(runId: RunIdInput, fromSeq?: number): Promise<RunEvent[]>;
	/** Every run with at least one event, in deterministic ascending ID order. */
	listRunIds(): Promise<RunId[]>;
	putArtifact(
		content: Uint8Array,
		meta: { kind: string; mediaType: string },
	): Promise<ArtifactRef>;
	readArtifact(sha256: string): Promise<Uint8Array>;
	close(): Promise<void>;
}

export class StaleSeqError extends Error {
	readonly expected: number;
	readonly actual: number;

	constructor(expected: number, actual: number) {
		super(`expected seq ${expected} but the log is at ${actual}`);
		this.name = "StaleSeqError";
		this.expected = expected;
		this.actual = actual;
	}
}
