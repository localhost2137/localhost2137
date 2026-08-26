import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: true,
		globalSetup: "./test/global-setup.ts",
		include: ["test/workers/*.test.ts"],
		maxWorkers: 4,
		pool: "forks",
	},
});
