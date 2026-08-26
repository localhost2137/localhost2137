import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

const configSchema = z.object({ label: z.string() });
const seedSchema = z.object({ value: z.int() });
type Config = z.output<typeof configSchema>;
type State = Readonly<{ filePath: string }>;

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
		value: await changeValue(context.state.filePath, input.by),
	}),
});
const read = operation({
	description: "Read the isolated counter",
	input: z.object({}),
	output: z.object({ value: z.int() }),
	run: async (context) => ({ value: await readValue(context.state.filePath) }),
});

const api = new Hono<PluginEnv<State, Config>>();
api.get("/value", async (context) => {
	const runtime = context.get("lh");
	return context.json({
		instanceId: runtime.instanceId,
		label: runtime.config.label,
		value: await readValue(runtime.state.filePath),
	});
});

export const fixturePlugin = definePlugin({
	api,
	configSchema,
	connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
		env: { FIXTURE_API_URL: `${baseUrl}/${instanceId}/${serviceKey}` },
		values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}`, label: config.label },
	}),
	description: "Minimal contract fixture",
	id: "fixture",
	lifecycle: {
		create: async (context) => writeFile(context.storage.path("counter.json"), "0", "utf8"),
		seed: async (context, seed) => writeValue(context.state.filePath, seed.value),
		start: (context): State => Object.freeze({ filePath: context.storage.path("counter.json") }),
	},
	operations: { deliver, increment, read },
	seedSchema,
	stateVersion: 1,
});

export const fixtureConfig = defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-02T03:04:05.000Z" },
	services: {
		fixture: fixturePlugin({ config: { label: "isolated" }, seed: { value: 7 } }),
	},
});

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
