import { readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

type Config = Readonly<Record<string, never>>;
type State = Readonly<{ valuePath: string }>;

const operation = defineOperation<"counter", State, Config>();
const increment = operation({
	description: "Increment this instance's counter",
	input: z.object({ by: z.int() }),
	output: z.object({ value: z.int() }),
	run: async (context, input) => {
		const value = (await readValue(context.state.valuePath)) + input.by;
		await writeFile(context.state.valuePath, String(value), "utf8");
		return { value };
	},
});
const read = operation({
	description: "Read this instance's counter",
	input: z.object({}),
	output: z.object({ value: z.int() }),
	run: async (context) => ({ value: await readValue(context.state.valuePath) }),
});

export const counterPlugin = definePlugin({
	api: new Hono<PluginEnv<State, Config>>(),
	configSchema: z.object({}),
	connection: ({ baseUrl, instanceId, serviceKey }) => ({
		env: { COUNTER_API_URL: `${baseUrl}/${instanceId}/${serviceKey}` },
		values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}` },
	}),
	description: "Parallel testing example counter",
	id: "counter",
	lifecycle: {
		create: async (context) => writeFile(context.storage.path("value"), "0", "utf8"),
		start: (context): State => ({ valuePath: context.storage.path("value") }),
	},
	operations: { increment, read },
	stateVersion: 1,
});

async function readValue(path: string): Promise<number> {
	return Number(await readFile(path, "utf8"));
}
