import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

type State = Readonly<{ path: string }>;
type Config = Readonly<{ eventsPath: string; failUpdate: boolean }>;

export function durabilityPlugin(stateVersion: number) {
	const bind = defineOperation<"durable", State, Config>();
	const setValue = bind({
		description: "Set durable fixture value",
		input: z.object({ value: z.int() }),
		output: z.object({ value: z.int() }),
		run: async (context, input) => {
			await writeFile(context.state.path, String(input.value), "utf8");
			return input;
		},
	});
	const readValue = bind({
		description: "Read durable fixture value",
		input: z.object({}),
		output: z.object({ value: z.int() }),
		run: async (context) => ({ value: Number(await readFile(context.state.path, "utf8")) }),
	});
	return definePlugin({
		api: new Hono<PluginEnv<State, Config>>(),
		configSchema: z.object({ eventsPath: z.string(), failUpdate: z.boolean() }),
		connection: () => ({ env: {}, values: {} }),
		description: "Durability contract fixture",
		id: "durable",
		lifecycle: {
			create: async (context) => writeFile(context.storage.path("value"), "0", "utf8"),
			start: (context): State => ({ path: context.storage.path("value") }),
			update: async (context, version) => {
				await appendFile(
					context.config.eventsPath,
					`update:${version.from}:${version.to}\n`,
					"utf8",
				);
				if (context.config.failUpdate) throw new Error("injected update failure");
			},
		},
		operations: { readValue, setValue },
		stateVersion,
	});
}
