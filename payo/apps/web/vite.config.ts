import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { "@web": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: { host: "127.0.0.1", port: 5173, strictPort: true },
	test: {
		name: "web",
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
	},
});
