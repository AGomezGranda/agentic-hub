import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./swarm.js", import.meta.url), "utf8");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)("args", "runs", source);

for (const plan of [undefined, "plan.md phase 1"]) {
  test(`review groups preserve all lenses (plan: ${Boolean(plan)})`, async () => {
    let active = 0;
    let peak = 0;
    const tasks = [];
    const run = async (key, spec) => {
      active++;
      peak = Math.max(peak, active);
      tasks.push({ key, ...spec });
      assert.match(spec.task, /never spawn agents/);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { ok: key !== "design-simplicity-r1", output: key, outputReference: spec.output };
    };
    const result = await execute({ scope: "diff vs main", plan }, {
      run,
      all: (specs) => Promise.all(specs.map((spec) => run(spec.key, spec))),
    });
    assert.equal(peak, 3);
    assert.equal(tasks.length, 3);
    assert.equal(result.status, "requires-parent-verification");
    assert.equal("verified" in result, false);
    assert.match(result.reports, /RUN FAILED, unchecked/);
    const assigned = tasks.flatMap(({ task }) =>
      [...task.matchAll(/Lens: ([\w-]+)\./g)].map((match) => match[1]));
    const expected = ["correctness", "architecture", "quality", "tests", "simplicity", "security"];
    if (plan) expected.push("plan-conformance");
    assert.deepEqual(assigned.sort(), expected.sort());
    assert.deepEqual(result.failedLenses, ["architecture", "quality", "simplicity"]);
  });
}

test("a selected subset does not launch empty groups", async () => {
  let count = 0;
  const result = await execute({ lenses: ["tests"] }, {
    run: async () => ({ ok: true, output: "evidence" }),
    all: async (specs) => {
      count = specs.length;
      assert.match(specs[0].task, /Lens: tests/);
      return specs.map(() => ({ ok: true, output: "review" }));
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(result.failedLenses, []);
});


test("code-quality workflow launches only three children total", async () => {
  const source = await readFile(new URL("./cq-payo.js", import.meta.url), "utf8");
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)("runs", source);
  let active = 0;
  let peak = 0;
  let total = 0;
  const result = await execute({
    all: (specs) => Promise.all(specs.map(async (spec) => {
      total++;
      active++;
      peak = Math.max(peak, active);
      assert.match(spec.task, /never spawn agents/);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { ok: true, output: spec.key };
    })),
  });
  assert.equal(peak, 3);
  assert.equal(total, 3);
  assert.deepEqual(result.map((item) => item.key), [
    "factory", "packages-adapters", "apps",
  ]);
  assert.ok(result.every((item) => item.output === "cq-" + item.key));
});

for (const args of [{ lenses: [] }, { lenses: ["typo"] }, { lenses: ["plan-conformance"] }]) {
  test(`invalid selection never launches children: ${JSON.stringify(args)}`, async () => {
    await assert.rejects(execute(args, {
      all: () => assert.fail("must reject before dispatch"),
    }), /known review lens|requires a plan/);
  });
}
