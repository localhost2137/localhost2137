import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin } from "localhost2137";
import { z } from "zod";

const operation = defineOperation();
const echo = operation({
	description: "Echo a message",
	input: z.object({ message: z.string(), count: z.number().int().min(1).default(1) }),
	output: z.object({ message: z.string() }),
	run: (_context, input) => ({ message: input.message.repeat(input.count) }),
});
const fixture = definePlugin({
	api: new Hono(),
	configSchema: z.object({ token: z.string() }),
	connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
		env: {
			FIXTURE_TOKEN: config.token,
			FIXTURE_URL: [baseUrl, instanceId, serviceKey].join("/"),
		},
		values: {
			token: config.token,
			url: [baseUrl, instanceId, serviceKey].join("/"),
		},
	}),
	description: "Fixture service",
	id: "fixture",
	lifecycle: { create: () => undefined, start: () => ({}) },
	operations: { echo },
	stateVersion: 1,
});

export default defineConfig({
	host: "127.0.0.1",
	port: 2137,
	services: { fixture: fixture({ config: { token: "fixture-secret-value" } }) },
	storage: { dir: ".localhost2137" },
});
