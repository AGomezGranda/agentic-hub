import { describe, expect, it } from "vitest";
import { createLimiter, fanOut } from "./fanout.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("createLimiter", () => {
	it("never runs more than the limit at once, across five tasks", async () => {
		const limiter = createLimiter(2);
		let inFlight = 0;
		let peak = 0;
		const task = () =>
			limiter.run(async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await tick();
				inFlight--;
			});

		await Promise.all([1, 2, 3, 4, 5].map(task));

		expect(peak).toBe(2);
	});

	it("starts queued tasks in FIFO order", async () => {
		const limiter = createLimiter(1);
		const started: number[] = [];
		const task = (n: number) =>
			limiter.run(async () => {
				started.push(n);
				await tick();
			});

		await Promise.all([task(1), task(2), task(3)]);

		expect(started).toEqual([1, 2, 3]);
	});

	it("starts queued tasks in FIFO order when two permits are available", async () => {
		const limiter = createLimiter(2);
		const started: number[] = [];
		const task = (n: number) =>
			limiter.run(async () => {
				started.push(n);
				await tick();
			});

		await Promise.all([task(1), task(2), task(3), task(4)]);

		expect(started).toEqual([1, 2, 3, 4]);
	});

	it("releases its permit when a task rejects, so the next task still runs", async () => {
		const limiter = createLimiter(1);
		const failed = limiter.run(async () => {
			throw new Error("nope");
		});
		const next = limiter.run(async () => "ran");

		await expect(failed).rejects.toThrow("nope");
		await expect(next).resolves.toBe("ran");
	});

	it.each([0, 1.5, -1, Number.NaN])("throws RangeError for max %s", (max) => {
		expect(() => createLimiter(max)).toThrow(RangeError);
	});
});

describe("fanOut", () => {
	it("reports each child in input order and keeps siblings running", async () => {
		const results = await fanOut([
			async () => {
				await tick();
				return "a";
			},
			async () => {
				throw new Error("boom");
			},
			async () => "c",
		]);

		expect(results).toEqual([
			{ status: "checked", value: "a" },
			{ status: "unchecked", reason: "boom" },
			{ status: "checked", value: "c" },
		]);
	});

	it("reports non-Error rejections without failing the fan-out", async () => {
		const results = await fanOut([
			async () => {
				throw Object.create(null);
			},
			async () => {
				throw { code: 1 };
			},
			async () => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				throw cyclic;
			},
			async () => {
				throw "plain string";
			},
			async () => {
				throw undefined;
			},
			async () => "ok",
		]);

		expect(results).toEqual([
			{ status: "unchecked", reason: "{}" },
			{ status: "unchecked", reason: '{"code":1}' },
			{ status: "unchecked", reason: "non-Error rejection" },
			{ status: "unchecked", reason: "plain string" },
			{ status: "unchecked", reason: "non-Error rejection" },
			{ status: "checked", value: "ok" },
		]);
	});

	it("names an Error with an empty message by its class", async () => {
		const results = await fanOut([
			async () => {
				throw new TypeError();
			},
		]);

		expect(results).toEqual([{ status: "unchecked", reason: "TypeError" }]);
	});

	it("reports a task that throws synchronously as unchecked", async () => {
		const results = await fanOut([
			() => {
				throw new Error("sync boom");
			},
		]);

		expect(results).toEqual([{ status: "unchecked", reason: "sync boom" }]);
	});
});
