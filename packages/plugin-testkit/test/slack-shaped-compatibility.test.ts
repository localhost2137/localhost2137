import { Hono } from "hono";
import { defineConfig, defineOperation, definePlugin, type PluginEnv } from "localhost2137";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPluginContractCases, type PluginContractFixture } from "../src/index.js";

type SlackConfig = Readonly<{ eventsUrl: string; token: string }>;
type SlackState = { readonly conversations: string[]; readonly users: string[] };

const slackConfig = createSlackConfig("http://127.0.0.1:1/events");
type SlackServices = typeof slackConfig.services;

const slackShapedFixture = {
	authoring: { exportName: "slackConfig", module: new URL(import.meta.url) },
	connection: { environmentName: "SLACK_API_URL", valueKey: "apiUrl" as const },
	durability: {
		configModule: new URL(import.meta.url),
		expectedInitial: {},
		expectedPersisted: {},
		expectedWrite: {},
		read: { input: { name: "general" }, operation: "createConversation" as const },
		versions: { current: 2, future: 3, old: 1 },
		write: { input: { name: "general" }, operation: "createConversation" as const },
	},
	faults: {
		invalidOutput: {
			input: { channel: "C1", text: "hello" },
			operation: "sendMessage" as const,
		},
		storageEscape: {
			input: { channel: "C1", text: "hello" },
			operation: "sendMessage" as const,
		},
	},
	harness: {
		createConfig: ({ resources }) => createSlackConfig(resources.deliveryUrl),
		createInvalidConfig: (_kind: "config" | "seed", resources) =>
			createSlackConfig(resources.deliveryUrl),
		createService: (resources) => createSlackService(resources.deliveryUrl),
		pluginId: "slack-shaped",
		stateVersion: 1,
	},
	hono: {
		arrange: {
			first: {
				expected: { id: "U1", name: "Ada" },
				invoke: { input: { name: "Ada" }, operation: "createUser" as const },
			},
			second: {
				expected: { id: "U1", name: "Grace" },
				invoke: { input: { name: "Grace" }, operation: "createUser" as const },
			},
		},
		expected: {
			first: { data: [{ id: "U1", name: "Ada" }], status: 200 },
			second: { data: [{ id: "U1", name: "Grace" }], status: 200 },
		},
		normalize: (body: unknown) =>
			typeof body === "object" && body !== null ? Reflect.get(body, "members") : undefined,
		request: (connection) => ({
			headers: { authorization: `Bearer ${connection.token}` },
			responseBody: "json" as const,
			url: `${connection.apiUrl}/api/users.list`,
		}),
	},
	invalid: { configPath: ["token"], seedPath: ["users"] },
	isolation: {
		expectedFresh: { id: "U1", name: "Ada" },
		expectedMutated: { id: "U1", name: "Grace" },
		mutate: { input: { name: "Grace" }, operation: "createUser" as const },
		read: { input: { name: "Ada" }, operation: "createUser" as const },
	},
	operations: [
		{
			cli: "flags" as const,
			expected: { id: "C1", name: "general" },
			input: { name: "general" },
			key: "createConversation" as const,
		},
		{
			cli: "flags" as const,
			expected: { id: "U1", name: "Ada" },
			input: { name: "Ada" },
			key: "createUser" as const,
		},
		{
			cli: "flags" as const,
			expected: { ok: true as const },
			input: { channel: "C1", text: "hello" },
			key: "sendMessage" as const,
		},
	],
	reset: {
		expectedEmpty: { id: "U1", name: "Ada" },
		expectedSeeded: { id: "U1", name: "Grace" },
		mutate: { input: { name: "Grace" }, operation: "createUser" as const },
		read: { input: { name: "Ada" }, operation: "createUser" as const },
	},
	serviceKey: "slack" as const,
	trackedFetch: {
		expected: { ok: true as const },
		invoke: {
			input: { channel: "C1", text: "tracked delivery" },
			operation: "sendMessage" as const,
		},
	},
} satisfies PluginContractFixture<SlackServices>;

describe("Slack-shaped contract compatibility", () => {
	const cases = createPluginContractCases(slackShapedFixture);

	it("uses a real users API to prove instance context isolation", async () => {
		await contractCase(cases, "public Hono routes receive instance context").run();
	});

	it("uses config-time eventsUrl with a real sendMessage operation", async () => {
		await contractCase(cases, "tracked fetch work is drained by idle").run();
	});

	it("contains no test-only operation or instance response field", () => {
		expect(slackShapedFixture.operations.map(({ key }) => key)).toEqual([
			"createConversation",
			"createUser",
			"sendMessage",
		]);
		expect(slackShapedFixture.hono.expected.first.data).toEqual([{ id: "U1", name: "Ada" }]);
	});
});

function createSlackConfig(eventsUrl: string) {
	return defineConfig({ services: { slack: createSlackService(eventsUrl) } });
}

function createSlackService(eventsUrl: string) {
	return createSlackShapedPlugin()({
		config: { eventsUrl, token: "xoxb-local" },
	});
}

function createSlackShapedPlugin() {
	const bind = defineOperation<"slack-shaped", SlackState, SlackConfig>();
	const createConversation = bind({
		description: "Create a conversation",
		input: z.object({ name: z.string() }),
		output: z.object({ id: z.string(), name: z.string() }),
		run: (context, input) => {
			context.state.conversations.push(input.name);
			return { id: `C${context.state.conversations.length}`, name: input.name };
		},
	});
	const createUser = bind({
		description: "Create a user",
		input: z.object({ name: z.string() }),
		output: z.object({ id: z.string(), name: z.string() }),
		run: (context, input) => {
			context.state.users.push(input.name);
			return { id: `U${context.state.users.length}`, name: input.name };
		},
	});
	const sendMessage = bind({
		description: "Send a message",
		input: z.object({ channel: z.string(), text: z.string() }),
		output: z.object({ ok: z.literal(true) }),
		run: (context, input): { readonly ok: true } => {
			const delivery = context
				.fetch(context.config.eventsUrl, {
					body: JSON.stringify(input),
					headers: { "content-type": "application/json" },
					method: "POST",
				})
				.then((response) => response.arrayBuffer())
				.then(() => undefined);
			void context.tasks.track("Slack event delivery", delivery).catch(() => undefined);
			return { ok: true };
		},
	});
	const api = new Hono<PluginEnv<SlackState, SlackConfig>>();
	api.get("/api/users.list", (context) => {
		const runtime = context.get("lh");
		if (context.req.header("authorization") !== `Bearer ${runtime.config.token}`) {
			return context.json({ error: "invalid_auth", ok: false }, 401);
		}
		return context.json({
			members: runtime.state.users.map((name, index) => ({ id: `U${index + 1}`, name })),
			ok: true,
		});
	});
	return definePlugin({
		api,
		configSchema: z.object({ eventsUrl: z.url(), token: z.string() }),
		connection: ({ baseUrl, config, instanceId, serviceKey }) => ({
			env: {
				SLACK_API_URL: `${baseUrl}/${instanceId}/${serviceKey}`,
				SLACK_TOKEN: config.token,
			},
			values: { apiUrl: `${baseUrl}/${instanceId}/${serviceKey}`, token: config.token },
		}),
		description: "Slack-shaped compatibility plugin",
		id: "slack-shaped",
		lifecycle: {
			create: () => undefined,
			start: (): SlackState => ({ conversations: [], users: [] }),
		},
		operations: { createConversation, createUser, sendMessage },
		stateVersion: 1,
	});
}

function contractCase(
	cases: readonly Readonly<{ name: string; run(): Promise<void> }>[],
	name: string,
) {
	const selected = cases.find((candidate) => candidate.name === name);
	if (!selected) throw new TypeError(`Missing contract case ${name}.`);
	return selected;
}
