import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
		},
		exclude: ["**/dist/**", "**/node_modules/**", "design/**"],
		include: ["packages/**/*.test.ts", "plugins/**/*.test.ts", "tests/**/*.test.ts"],
	},
});
