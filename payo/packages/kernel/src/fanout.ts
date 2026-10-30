export interface Limiter {
	run<T>(task: () => Promise<T>): Promise<T>;
}

/** FIFO limiter: at most `max` tasks run at once; a permit is released even when a task rejects. */
export function createLimiter(max: number): Limiter {
	if (!Number.isInteger(max) || max < 1) {
		throw new RangeError(`max must be a positive integer, got ${max}`);
	}
	let active = 0;
	const queue: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (active < max) {
			active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			queue.push(() => {
				active++;
				resolve();
			});
		});
	};
	const release = () => {
		active--;
		queue.shift()?.();
	};

	return {
		async run(task) {
			await acquire();
			try {
				return await task();
			} finally {
				release();
			}
		},
	};
}

export type ChildResult<T> =
	| { status: "checked"; value: T }
	| { status: "unchecked"; reason: string };

/** Runs every task to completion; a failing child is reported, never fails its siblings. */
export async function fanOut<T>(
	tasks: ReadonlyArray<() => Promise<T>>,
): Promise<ChildResult<T>[]> {
	const settled = await Promise.allSettled(tasks.map(async (task) => task()));
	return settled.map((result): ChildResult<T> => {
		if (result.status === "fulfilled") {
			return { status: "checked", value: result.value };
		}
		return { status: "unchecked", reason: describeReason(result.reason) };
	});
}

// String(x) throws on a null-prototype object, which would reject the whole fanOut.
export function describeReason(reason: unknown): string {
	if (reason instanceof Error) return reason.message || reason.name;
	if (typeof reason === "string") return reason;
	try {
		return JSON.stringify(reason) ?? "non-Error rejection";
	} catch {
		return "non-Error rejection";
	}
}
