import { createMemoryRunStore, type MemoryBacking } from "./store.ts";
import { runStoreContract } from "./testing.ts";

// A fresh backing per case; a reopen within one case reuses it, as a file would.
runStoreContract("memory", async () => {
	const backing: MemoryBacking = { events: new Map(), artifacts: new Map() };
	return {
		open: async () => createMemoryRunStore(backing),
		dispose: async () => {},
	};
});
