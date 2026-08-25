import { Hono } from "hono";
import { defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { z } from "zod";

const configSchema = z.object({
	label: z.string(),
	nested: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
	token: z.string().startsWith("local-"),
});
const seedSchema = z.object({ names: z.array(z.string()).default([]) });

type Config = z.output<typeof configSchema>;
type State = { readonly ready: true };

const operation = defineOperation<"fixture", State, Config>();
const createThing = operation({
	description: "Create a thing",
	input: z.object({
		count: z.int().default(1),
		name: z.string().meta({ description: "Thing name" }),
	}),
	output: z.object({ id: z.string() }),
	run: (_context, input) => ({ id: `${input.name}-${input.count}` }),
});

const api = new Hono<PluginEnv<State, Config>>();
api.get("/health", (context) => context.json({ ready: context.get("lh").state.ready }));

export const configurablePlugin = definePlugin({
	api,
	configSchema,
	connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
		env: {
			FIXTURE_BASE_URL: `${baseUrl}/${instanceId}/${serviceKey}`,
			FIXTURE_TOKEN: config.token,
		},
		values: {
			baseUrl: `${baseUrl}/${instanceId}/${serviceKey}`,
			token: config.token,
		},
	}),
	description: "Config resolver fixture",
	id: "fixture",
	lifecycle: {
		create: () => undefined,
		seed: () => undefined,
		start: (): State => ({ ready: true }),
	},
	operations: { createThing },
	seedSchema,
	stateVersion: 2,
});
