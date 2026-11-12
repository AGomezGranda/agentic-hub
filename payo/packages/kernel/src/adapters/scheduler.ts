import type { Scheduler } from "../application/agent-step.ts";

export const systemScheduler: Scheduler = {
	after(ms, task) {
		const timer = setTimeout(task, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
	yield: () => new Promise((resolve) => setImmediate(resolve)),
};
