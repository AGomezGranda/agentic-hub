import { describe, expect, it } from "vitest";
import {
	addMoney,
	CostAmount,
	Money,
	moneyFromNumber,
	RunEventSchema,
} from "./index.ts";

describe("decimal money", () => {
	it("adds exactly and independently of grouping", () => {
		expect(addMoney("0.1", "0.2")).toBe("0.3");
		expect(addMoney(addMoney("0.1", "0.2"), "0.000000000001")).toBe(
			addMoney("0.1", addMoney("0.2", "0.000000000001")),
		);
		expect(addMoney("999999999999999999999999", "0.1")).toBe(
			"999999999999999999999999.1",
		);
	});
	it.each([
		[1e-7, "0.0000001"],
		[1e21, "1000000000000000000000"],
		[0.0000000000005, "0.000000000001"],
		[0.0000000000004, "0"],
		[1.1234567890125, "1.123456789013"],
		[0.9999999999995, "1"],
		[0, "0"],
		[Number.MIN_VALUE, "0"],
	])("normalizes %s with half-up rounding", (input, expected) => {
		expect(moneyFromNumber(input)).toBe(expected);
	});
	it.each([-1, Infinity, NaN])(
		"rejects invalid provider amounts %s",
		(value) => {
			expect(() => moneyFromNumber(value)).toThrow();
		},
	);
	it.each(["-1", "1e3", "0.0000000000001", "NaN", "01", "", "1."])(
		"rejects invalid decimal text %s",
		(value) => {
			expect(Money.safeParse(value).success).toBe(false);
		},
	);
	it("reads numeric historical events without changing the original payload", () => {
		const original = {
			type: "attempt.finished",
			attemptId: "a1",
			outcome: "succeeded",
			seq: 4,
			at: "2026-11-12T00:00:00.000Z",
			usage: {
				tokensIn: 1,
				tokensOut: 2,
				cost: 0.1,
				costDetails: {
					complete: true,
					amounts: [{ currency: "USD", basis: "estimated", amount: 0.1 }],
				},
			},
		};
		const parsed = RunEventSchema.parse(original);
		expect(
			parsed.type === "attempt.finished" &&
				parsed.usage.costDetails?.amounts[0]?.amount,
		).toBe("0.1");
		expect(original.usage.costDetails.amounts[0]?.amount).toBe(0.1);
		expect(
			CostAmount.parse({
				currency: "USD",
				basis: "estimated",
				amount: "0.000000000001",
			}).amount,
		).toBe("0.000000000001");
	});
});
