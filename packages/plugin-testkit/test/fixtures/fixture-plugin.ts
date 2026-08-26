import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

export type FixtureLifecycleEvent =
	| "create"
	| "seed"
	| "start"
	| "stop"
	| `update:${number}:${number}`;

export interface FixturePluginDependencies {
	readonly eventsPath?: string;
	readonly failCreateOnce?: () => void;
	readonly failUpdate?: boolean;
	readonly invalidOutput?: boolean;
	readonly record?: (event: FixtureLifecycleEvent) => void;
	readonly stateVersion?: number;
	readonly storageEscape?: boolean;
}

const configSchema = z.object({ label: z.string() });
const seedSchema = z.object({ value: z.int() });
type Config = z.output<typeof configSchema>;
type State = Readonly<{ filePath(): string }>;

export function createFixturePlugin(dependencies: FixturePluginDependencies = {}) {
	const operation = defineOperation<"fixture", State, Config>();
	const deliver = operation({
		description: "Queue one tracked outbound fetch",
		input: z.object({ url: z.url() }),
		output: z.object({ queued: z.literal(true) }),
		run: (context, input): { readonly queued: true } => {
			const delivery = context
				.fetch(input.url)
				.then((response) => response.arrayBuffer())
				.then(() => undefined);
			void context.tasks.track("fixture delivery body", delivery).catch(() => undefined);
			return { queued: true };
		},
	});
	const increment = operation({
		description: "Increment the isolated counter",
		input: z.object({ by: z.int().default(1) }),
		output: z.object({ label: z.string(), value: z.int() }),
		run: async (context, input) => ({
			label: context.config.label,
			value: await changeValue(context.state.filePath(), input.by),
		}),
	});
	const read = operation({
		description: "Read the isolated counter",
		input: z.object({}),
		output: z.object({ value: z.int() }),
		run: async (context) => ({
			value: dependencies.invalidOutput ? Number.NaN : await readValue(context.state.filePath()),
		}),
	});

	const api = new Hono<PluginEnv<State, Config>>();
	api.get("/value", async (context) => {
		const runtime = context.get("lh");
		return context.json({
			instanceId: runtime.instanceId,
			label: runtime.config.label,
			value: await readValue(runtime.state.filePath()),
		});
	});

	return definePlugin({
		api,
		configSchema,
		connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
			env: { FIXTURE_API_URL: `${baseUrl}/${instanceId}/${serviceKey}` },
			values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}`, label: config.label },
		}),
		description: "Minimal contract fixture",
		id: "fixture",
		lifecycle: {
			create: async (context) => {
				dependencies.record?.("create");
				dependencies.failCreateOnce?.();
				await writeFile(context.storage.path("counter.json"), "0", "utf8");
			},
			seed: async (context, seed) => {
				dependencies.record?.("seed");
				await writeValue(context.state.filePath(), seed.value);
			},
			start: (context): State => {
				dependencies.record?.("start");
				return Object.freeze({
					filePath: () =>
						context.storage.path(dependencies.storageEscape ? "../escape" : "counter.json"),
				});
			},
			stop: () => {
				dependencies.record?.("stop");
			},
			update: async (context, version) => {
				const event = `update:${version.from}:${version.to}` as const;
				dependencies.record?.(event);
				if (dependencies.eventsPath) {
					await appendFile(dependencies.eventsPath, `${event}\n`, "utf8");
				}
				if (dependencies.failUpdate) throw new Error("injected update failure");
				void context;
			},
		},
		operations: { deliver, increment, read },
		seedSchema,
		stateVersion: dependencies.stateVersion ?? 2,
	});
}

export const fixturePlugin = createFixturePlugin();

export const fixtureConfig = defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-02T03:04:05.000Z" },
	services: {
		fixture: fixturePlugin({ config: { label: "isolated" }, seed: { value: 7 } }),
	},
});

export function createFixtureConfig(dependencies: FixturePluginDependencies = {}) {
	return defineConfig({
		clock: { mode: "pinned", startAt: "2026-01-02T03:04:05.000Z" },
		services: {
			fixture: createFixturePlugin(dependencies)({
				config: { label: "isolated" },
				seed: { value: 7 },
			}),
		},
	});
}

export function createFixtureService() {
	return createFixturePlugin()({
		config: { label: "isolated" },
		seed: { value: 7 },
	});
}

export function createInvalidFixtureConfig(kind: "config" | "seed"): unknown {
	const envelope =
		kind === "config"
			? { config: { label: 2137 }, seed: { value: 7 } }
			: { config: { label: "isolated" }, seed: { value: "invalid" } };
	return {
		services: {
			fixture: Reflect.apply(createFixturePlugin(), undefined, [envelope]),
		},
	};
}

async function changeValue(filePath: string, difference: number): Promise<number> {
	const value = (await readValue(filePath)) + difference;
	await writeValue(filePath, value);
	return value;
}

async function readValue(filePath: string): Promise<number> {
	return Number(await readFile(filePath, "utf8"));
}

async function writeValue(filePath: string, value: number): Promise<void> {
	await writeFile(filePath, String(value), "utf8");
}
