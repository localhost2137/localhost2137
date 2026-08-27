import { fileURLToPath } from "node:url";

interface EmbeddedDemoAsset {
	readonly source: string;
	readonly target: string;
}

export interface EmbeddedDemo {
	readonly assetDirectory: string;
	readonly assets: readonly EmbeddedDemoAsset[];
	readonly name: string;
	readonly version: 1;
}

const slackPingBot: EmbeddedDemo = Object.freeze({
	assetDirectory: fileURLToPath(new URL("../../demo-assets/v1/slack-ping-bot/", import.meta.url)),
	assets: Object.freeze([
		Object.freeze({ source: "gitignore.template", target: ".gitignore" }),
		Object.freeze({ source: "localhost.config.ts", target: "localhost.config.ts" }),
		Object.freeze({ source: "package.json", target: "package.json" }),
		Object.freeze({ source: "pnpm-workspace.yaml", target: "pnpm-workspace.yaml" }),
		Object.freeze({ source: "README.md", target: "README.md" }),
		Object.freeze({ source: "src/bot.ts", target: "src/bot.ts" }),
		Object.freeze({ source: "src/main.ts", target: "src/main.ts" }),
		Object.freeze({ source: "test/ping-pong.test.ts", target: "test/ping-pong.test.ts" }),
		Object.freeze({ source: "tsconfig.json", target: "tsconfig.json" }),
		Object.freeze({ source: "vitest.config.ts", target: "vitest.config.ts" }),
	]),
	name: "slack-ping-bot",
	version: 1,
});

const demos: ReadonlyMap<string, EmbeddedDemo> = new Map([[slackPingBot.name, slackPingBot]]);

export const EMBEDDED_DEMO_NAMES: readonly string[] = Object.freeze([...demos.keys()]);

export function findEmbeddedDemo(name: string): EmbeddedDemo | undefined {
	return demos.get(name);
}
