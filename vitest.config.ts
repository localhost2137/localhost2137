import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			include: ["packages/*/src/**/*.ts", "plugins/*/src/**/*.ts"],
			provider: "v8",
			reporter: ["text", "json-summary"],
			thresholds: {
				branches: 75,
				functions: 80,
				lines: 80,
				statements: 80,
			},
		},
		exclude: ["**/demo-assets/**", "**/dist/**", "**/node_modules/**", "design/**"],
		include: ["packages/**/*.test.ts", "plugins/**/*.test.ts", "tests/**/*.test.ts"],
	},
});
