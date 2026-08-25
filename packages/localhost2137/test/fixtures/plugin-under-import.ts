import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

const configSchema = z.object({ greeting: z.string() });
type Config = z.output<typeof configSchema>;
type State = { readonly ready: true };
const api = new Hono<PluginEnv<State, Config>>();
const operation = defineOperation<"sample", State, Config>();
const greet = operation({
	description: "Return a greeting",
	input: z.object({ name: z.string() }),
	output: z.object({ greeting: z.string() }),
	run: (context, input) => ({ greeting: `${context.config.greeting}, ${input.name}` }),
});

export const samplePlugin = definePlugin({
	api,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Import side-effect fixture",
	id: "sample",
	lifecycle: {
		create: () => undefined,
		start: (): State => ({ ready: true }),
	},
	operations: { greet },
	stateVersion: 1,
});
