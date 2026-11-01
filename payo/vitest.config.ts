import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "core",
					environment: "node",
					exclude: [...configDefaults.exclude, "apps/web/**"],
				},
			},
			"apps/web/vite.config.ts",
		],
	},
});
