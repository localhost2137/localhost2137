import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBEDDED_DEMO_NAMES, findEmbeddedDemo } from "../../src/node/demo-registry.js";

describe("embedded demo registry", () => {
	it("exposes one versioned package-relative Slack demo with an explicit file map", async () => {
		expect(EMBEDDED_DEMO_NAMES).toEqual(["slack-ping-bot"]);
		const demo = findEmbeddedDemo("slack-ping-bot");
		expect(demo).toMatchObject({ name: "slack-ping-bot", version: 1 });
		expect(demo?.assets).toEqual([
			{ source: "gitignore.template", target: ".gitignore" },
			{ source: "localhost.config.ts", target: "localhost.config.ts" },
			{ source: "package.json", target: "package.json" },
			{ source: "pnpm-workspace.yaml", target: "pnpm-workspace.yaml" },
			{ source: "README.md", target: "README.md" },
			{ source: "src/bot.ts", target: "src/bot.ts" },
			{ source: "src/main.ts", target: "src/main.ts" },
			{ source: "test/ping-pong.test.ts", target: "test/ping-pong.test.ts" },
			{ source: "tsconfig.json", target: "tsconfig.json" },
			{ source: "vitest.config.ts", target: "vitest.config.ts" },
		]);
		for (const asset of demo?.assets ?? []) {
			expect((await lstat(join(demo?.assetDirectory ?? "", asset.source))).isFile()).toBe(true);
		}
		expect(findEmbeddedDemo("slack")).toBeUndefined();
	});
});
