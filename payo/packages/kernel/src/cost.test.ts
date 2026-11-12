import {
	type CostAmount,
	CostSummary,
	moneyFromNumber,
	type RunEvent,
	type RunEventBody,
	type UsageRecord,
} from "@payo/contracts";
import { describe, expect, it } from "vitest";
import { projectRunCosts, sumCosts } from "./domain/cost.ts";
import { body, seqd } from "./testing.ts";

const bucket = (
	currency: string,
	basis: "estimated" | "provider-reported",
	amount: number,
): CostAmount => ({ currency, basis, amount: moneyFromNumber(amount) });

const money = (amounts: CostAmount[], complete: boolean): UsageRecord => ({
	tokensIn: 1,
	tokensOut: 1,
	cost: "unknown",
	costDetails: { amounts, complete },
});

const usageEvent = (attemptId: string, usage: UsageRecord): RunEventBody => ({
	type: "attempt.event",
	attemptId,
	event: { type: "usage", usage },
});

const finished = (
	attemptId: string,
	usage: UsageRecord,
	outcome: "succeeded" | "failed" = "succeeded",
): RunEventBody => ({
	type: "attempt.finished",
	attemptId,
	outcome,
	usage,
});

const summary = (value: unknown): CostSummary => CostSummary.parse(value);

describe("projectRunCosts", () => {
	it("counts replacement snapshots and the final usage once", () => {
		const partial = money([bucket("USD", "estimated", 0.1)], false);
		const complete = money([bucket("USD", "estimated", 0.25)], true);
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			usageEvent("a1", partial),
			usageEvent("a1", complete),
			finished("a1", complete),
			body.stepFinished("s1"),
			body.runEnded(),
		]);

		const tree = projectRunCosts(events);

		expect(tree.cost).toEqual({
			amounts: [bucket("USD", "estimated", 0.25)],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 1,
		});
		expect(tree.steps[0]?.attempts[0]?.usage).toEqual(complete);
		expect(tree.asOfSeq).toBe(events.length);
	});

	it("keeps a terminal-only legacy history readable without inventing currency", () => {
		const legacy: UsageRecord = { tokensIn: 5, tokensOut: 2, cost: 1.5 };
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			finished("a1", legacy),
			body.stepFinished("s1"),
			body.runEnded(),
		]);

		const tree = projectRunCosts(events);

		expect(tree.cost).toEqual({
			amounts: [],
			coverage: "unknown",
			incompleteAttempts: 1,
			attempts: 1,
		});
		expect(tree.steps[0]?.attempts[0]?.usage).toEqual(legacy);
	});

	it("counts duplicate identical rows and out-of-order delivery once", () => {
		const complete = money([bucket("USD", "estimated", 0.25)], true);
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			usageEvent("a1", complete),
			finished("a1", complete),
			body.stepFinished("s1"),
			body.runEnded(),
		]);
		const shuffled = [...events].reverse();

		const tree = projectRunCosts([
			...shuffled,
			...events.slice(3, 5),
			...events.slice(1, 2),
		]);

		expect(tree.cost.amounts).toEqual([bucket("USD", "estimated", 0.25)]);
		expect(tree.cost.attempts).toBe(1);
		expect(tree.asOfSeq).toBe(events.length);
	});

	it("rejects conflicting rows for one sequence", () => {
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			body.stepFinished("s1"),
		]);
		const conflict = {
			...seqd([body.stepStarted("s9")])[0],
			seq: events[3]?.seq,
			at: events[3]?.at,
		} as RunEvent;

		expect(() => projectRunCosts([...events, conflict])).toThrow(/conflicting/);
	});

	it("rejects a gap in the sequence", () => {
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			body.stepFinished("s1"),
		]);

		expect(() =>
			projectRunCosts(events.filter((event) => event.seq !== 3)),
		).toThrow(/gap/);
	});

	it("fails an invalid lifecycle history through the reducer", () => {
		const complete = money([bucket("USD", "estimated", 1)], true);
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			finished("a1", complete),
			finished("a1", complete),
		]);

		expect(() => projectRunCosts(events)).toThrow(/a1/);
	});

	it("totals multiple steps, retries, unknowns, a qualified zero and mixed currencies", () => {
		const first = money(
			[
				bucket("EUR", "provider-reported", 1.5),
				bucket("USD", "estimated", 0.1),
			],
			false,
		);
		const second = money([bucket("USD", "estimated", 0)], true);
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.attemptStarted("a1", "s1"),
			usageEvent("a1", first),
			finished("a1", first, "failed"),
			body.attemptStarted("a2", "s1"),
			usageEvent("a2", second),
			finished("a2", second),
			body.stepFinished("s1"),
			body.stepStarted("s2"),
			body.stepFinished("s2"),
			body.runEnded("approved"),
		]);
		const snapshot = structuredClone(events);

		const tree = projectRunCosts(events);

		const amounts = [
			bucket("EUR", "provider-reported", 1.5),
			bucket("USD", "estimated", 0.1),
		];
		expect(tree).toMatchObject({
			runId: "r1",
			status: "ended",
			outcome: "approved",
			asOfSeq: events.length,
		});
		expect(tree.steps.map((step) => step.stepId)).toEqual(["s1", "s2"]);
		expect(tree.steps[0]?.attempts.map((a) => a.attemptId)).toEqual([
			"a1",
			"a2",
		]);
		expect(tree.steps[0]?.cost).toEqual({
			amounts,
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 2,
		});
		expect(tree.steps[1]?.cost).toEqual({
			amounts: [],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 0,
		});
		expect(tree.cost).toEqual({
			amounts,
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 2,
		});
		expect(events).toEqual(snapshot);
	});

	it("reports a run with no attempts as empty and complete", () => {
		const events = seqd([
			body.runCreated("r1"),
			body.stepStarted("s1"),
			body.stepFinished("s1"),
			body.runEnded(),
		]);

		const tree = projectRunCosts(events);

		const empty = {
			amounts: [],
			coverage: "complete" as const,
			incompleteAttempts: 0,
			attempts: 0,
		};
		expect(tree.cost).toEqual(empty);
		expect(tree.steps[0]?.cost).toEqual(empty);
		expect(tree.steps[0]?.attempts).toEqual([]);
	});
});

describe("sumCosts", () => {
	it("returns the empty complete summary for no inputs", () => {
		expect(sumCosts([])).toEqual({
			amounts: [],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 0,
		});
	});

	it("merges buckets across currencies and bases in deterministic order", () => {
		const complete = summary({
			amounts: [
				bucket("USD", "estimated", 1),
				bucket("USD", "provider-reported", 2),
			],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 1,
		});
		const partial = summary({
			amounts: [bucket("EUR", "estimated", 4), bucket("USD", "estimated", 3)],
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 1,
		});

		const merged = sumCosts([partial, complete]);

		expect(merged).toEqual({
			amounts: [
				bucket("EUR", "estimated", 4),
				bucket("USD", "estimated", 4),
				bucket("USD", "provider-reported", 2),
			],
			coverage: "partial",
			incompleteAttempts: 1,
			attempts: 2,
		});
		expect(partial.amounts).toEqual([
			bucket("EUR", "estimated", 4),
			bucket("USD", "estimated", 3),
		]);
	});

	it("keeps an incomplete summary with no amounts unknown", () => {
		const unknown = summary({
			amounts: [],
			coverage: "unknown",
			incompleteAttempts: 1,
			attempts: 1,
		});

		expect(sumCosts([unknown])).toEqual(unknown);
	});

	it("adds decimal amounts exactly", () => {
		const tenth = summary({
			amounts: [bucket("USD", "estimated", 0.1)],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 1,
		});
		const fifth = summary({
			amounts: [bucket("USD", "estimated", 0.2)],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 1,
		});

		expect(sumCosts([tenth, fifth]).amounts[0]?.amount).toBe("0.3");
	});

	it("sums amounts beyond the binary number range exactly", () => {
		const huge = summary({
			amounts: [bucket("USD", "estimated", Number.MAX_VALUE)],
			coverage: "complete",
			incompleteAttempts: 0,
			attempts: 1,
		});

		expect(sumCosts([huge, huge]).amounts[0]?.amount).toBe(
			(BigInt(moneyFromNumber(Number.MAX_VALUE)) * 2n).toString(),
		);
	});
});
