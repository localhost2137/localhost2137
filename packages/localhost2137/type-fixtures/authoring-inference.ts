import { Hono } from "hono";
import { z } from "zod";
import {
	defineConfig,
	defineOperation,
	definePlugin,
	type InstanceFacade,
	type PluginEnv,
} from "./proposed-contract.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? true
		: false;
type Expect<Value extends true> = Value;

const configSchema = z.object({
	botToken: z.string().startsWith("xoxb-"),
	eventsUrl: z.url().nullable().default(null),
	workspaceName: z.string(),
});

const seedSchema = z.object({
	users: z.array(z.object({ id: z.string().optional(), name: z.string() })).default([]),
});

type SlackConfig = z.output<typeof configSchema>;
type SlackState = { readonly started: true };

const api = new Hono<PluginEnv<SlackState, typeof configSchema>>();
api.get("/health", (context) => {
	const { config, state } = context.get("lh");
	return context.json({ started: state.started, workspace: config.workspaceName });
});

const createUser = defineOperation({
	description: "Create a user in the workspace",
	input: z.object({
		admin: z.boolean().default(false),
		name: z.string(),
	}),
	output: z.object({
		admin: z.boolean(),
		id: z.string(),
		name: z.string(),
	}),
	run: (_context, input) => ({ id: "U000001", ...input }),
});

const slack = definePlugin({
	api,
	configSchema,
	connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
		env: {
			SLACK_API_URL: `${baseUrl}/${instanceId}/${serviceKey}/api`,
			SLACK_BOT_TOKEN: config.botToken,
		},
		values: {
			apiUrl: `${baseUrl}/${instanceId}/${serviceKey}/api`,
			botToken: config.botToken,
		},
	}),
	description: "Stateful Slack emulator",
	id: "slack",
	lifecycle: {
		create: (_context) => undefined,
		start: async (_context): Promise<SlackState> => ({ started: true }),
		stop: (_context) => undefined,
	},
	operations: { createUser },
	seedSchema,
	stateVersion: 1,
});

const config = defineConfig({
	clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
	host: "127.0.0.1",
	port: 2137,
	services: {
		slack: slack({
			config: {
				botToken: "xoxb-local-acme",
				workspaceName: "Acme Dev",
			},
			seed: { users: [{ name: "Alice" }] },
		}),
	},
	async seed(localhost) {
		const alice = await localhost.slack.createUser({ name: "Alice" });
		const apiUrl: string = localhost.slack.connection.apiUrl;
		void alice;
		void apiUrl;
	},
	storage: { dir: ".localhost2137" },
});

declare const instance: InstanceFacade<typeof config.services>;
const alice = instance.slack.createUser({ name: "Alice" });

type _ConfigOutput = Expect<Equal<SlackConfig["eventsUrl"], string | null>>;
type _OperationOutput = Expect<
	Equal<Awaited<typeof alice>, { admin: boolean; id: string; name: string }>
>;

// @ts-expect-error required plugin configuration remains required in the envelope
slack({ config: { botToken: "xoxb-local-acme" } });

// @ts-expect-error operation inputs reject undeclared fields
instance.slack.createUser({ name: "Alice", owner: true });
