import { Hono } from "hono";
import {
	defineConfig,
	defineOperation,
	definePlugin,
	type InstanceClockStatus,
	type InstanceClockAdvanceResult,
	type InstanceHandle,
	LocalhostError,
	type PluginEnv,
	type ReservedOperationKey,
	type ReservedServiceKey,
	type ScenarioFacade,
} from "localhost2137";
import { z } from "zod";

const expectedPluginError = new LocalhostError("USER_EXISTS", "That user already exists.", {
	status: 409,
});
type _ExpectedPluginErrorCode = Expect<Equal<typeof expectedPluginError.code, "USER_EXISTS">>;

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

const api = new Hono<PluginEnv<SlackState, SlackConfig>>();
api.get("/health", (context) => {
	const { config, state } = context.get("lh");
	return context.json({ started: state.started, workspace: config.workspaceName });
});

// One identity/context binding per plugin; every resulting operation remains a
// plain descriptor value with no operation-specific generic arguments.
const defineSlackOperation = defineOperation<"slack", SlackState, SlackConfig>();

const createUser = defineSlackOperation({
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
	run: (context, input) => {
		const started: true = context.state.started;
		const workspaceName: string = context.config.workspaceName;

		// @ts-expect-error Slack state has no Stripe-like customer repository
		context.state.customers;
		// @ts-expect-error Slack config has no Stripe API key
		context.config.apiKey;

		return { id: `${workspaceName}-${started ? "U000001" : "unreachable"}`, ...input };
	},
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
		seed: (context, seed) => {
			const started: true = context.state.started;
			const firstUserName: string | undefined = seed.users[0]?.name;
			void firstUserName;
			void started;
		},
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
	async seed(scenario) {
		const alice = await scenario.slack.createUser({ name: "Alice" });
		const apiUrl: string = scenario.slack.connection.apiUrl;
		void alice;
		void apiUrl;

		// @ts-expect-error scenario seeding already owns the exclusive lease
		await scenario.idle();
		// @ts-expect-error scenario seeding cannot access external clock capabilities
		await scenario.clock.status();
		// @ts-expect-error scenario seed cannot destroy its owning instance
		await scenario.destroy();
		// @ts-expect-error connection env belongs to an external instance handle
		scenario.env;
	},
	storage: { dir: ".localhost2137" },
});

declare const scenario: ScenarioFacade<typeof config.services>;
declare const instance: InstanceHandle<typeof config.services>;
const alice = instance.slack.createUser({ name: "Alice" });
const instanceEnvironment: Readonly<Record<string, string>> = instance.env;
const clockStatus: Promise<InstanceClockStatus> = instance.clock.status();
const clockAdvance: Promise<InstanceClockAdvanceResult> = instance.clock.advance("1h");
const destroyResult: Promise<void> = instance.destroy();
const idleResult: Promise<void> = instance.idle();
const resetResult: Promise<void> = instance.reset({ seed: true });
void instanceEnvironment;
void clockStatus;
void clockAdvance;
void destroyResult;
void idleResult;
void resetResult;
void scenario.slack.connection.apiUrl;

type _ConfigOutput = Expect<Equal<SlackConfig["eventsUrl"], string | null>>;
type _OperationOutput = Expect<
	Equal<Awaited<typeof alice>, { admin: boolean; id: string; name: string }>
>;
type _ReservedOperationKey = Expect<Equal<ReservedOperationKey, "connection">>;
type _ReservedServiceKey = Expect<
	Equal<ReservedServiceKey, "_" | "clock" | "destroy" | "env" | "idle" | "reset" | "seed">
>;
// @ts-expect-error required plugin configuration remains required in the envelope
slack({ config: { botToken: "xoxb-local-acme" } });

// @ts-expect-error operation inputs retain their schema-derived field types
instance.slack.createUser({ name: 2137 });

const unseededApi = new Hono<PluginEnv<SlackState, SlackConfig>>();
const unseededSlack = definePlugin({
	api: unseededApi,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Unseeded fixture",
	id: "slack",
	lifecycle: {
		create: () => undefined,
		start: (): SlackState => ({ started: true }),
	},
	operations: { createUser },
	stateVersion: 1,
});

unseededSlack({
	config: { botToken: "xoxb-local", workspaceName: "Unseeded" },
});

const defineForeignOperation = defineOperation<
	"invalid-context",
	{ readonly customers: readonly string[] },
	{ readonly apiKey: string }
>();
const foreignOperation = defineForeignOperation({
	description: "Foreign operation",
	input: z.object({}),
	output: z.object({ count: z.number() }),
	run: (context) => ({ count: context.state.customers.length + context.config.apiKey.length }),
});

definePlugin({
	api: unseededApi,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Invalid mixed-context fixture",
	id: "invalid-context",
	lifecycle: {
		create: () => undefined,
		start: (): SlackState => ({ started: true }),
	},
	// @ts-expect-error plugin records cannot mix another bound State/Config context
	operations: { foreignOperation },
	stateVersion: 1,
});

const defineOtherSlackOperation = defineOperation<"other-slack", SlackState, SlackConfig>();
const sameShapeForeignOperation = defineOtherSlackOperation({
	description: "Same context shape owned by another plugin",
	input: z.object({}),
	output: z.object({ ok: z.literal(true) }),
	run: (): { readonly ok: true } => ({ ok: true }),
});

definePlugin({
	api: unseededApi,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Invalid operation ownership fixture",
	id: "slack",
	lifecycle: {
		create: () => undefined,
		start: (): SlackState => ({ started: true }),
	},
	// @ts-expect-error matching State/Config shapes cannot cross literal plugin IDs
	operations: { sameShapeForeignOperation },
	stateVersion: 1,
});

const reservedConnectionOperation = defineSlackOperation({
	description: "Reserved facade collision fixture",
	input: z.object({}),
	output: z.object({ ok: z.literal(true) }),
	run: (): { readonly ok: true } => ({ ok: true }),
});

definePlugin({
	api: unseededApi,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Invalid operation key fixture",
	id: "slack",
	lifecycle: {
		create: () => undefined,
		start: (): SlackState => ({ started: true }),
	},
	// @ts-expect-error connection is reserved for generated connection metadata
	operations: { connection: reservedConnectionOperation },
	stateVersion: 1,
});

unseededSlack({
	config: { botToken: "xoxb-local", workspaceName: "Unseeded" },
	// @ts-expect-error an unseeded plugin envelope cannot accept seed data
	seed: { users: [] },
});

// @ts-expect-error seedSchema requires a matching lifecycle.seed hook
definePlugin({
	api,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Invalid seeded fixture",
	id: "slack",
	lifecycle: {
		create: () => undefined,
		start: (): SlackState => ({ started: true }),
	},
	operations: { createUser },
	seedSchema,
	stateVersion: 1,
});

// @ts-expect-error lifecycle.seed is forbidden without seedSchema
definePlugin({
	api,
	configSchema,
	connection: () => ({ env: {}, values: {} }),
	description: "Invalid unseeded fixture",
	id: "slack",
	lifecycle: {
		create: () => undefined,
		seed: (_context, _seed) => undefined,
		start: (): SlackState => ({ started: true }),
	},
	operations: { createUser },
	stateVersion: 1,
});

defineConfig({
	clock: {
		mode: "real",
		// @ts-expect-error real clock mode cannot carry a pinned start instant
		startAt: "2026-01-01T00:00:00.000Z",
	},
	services: { slack: unseededSlack({ config: { botToken: "xoxb-local", workspaceName: "Real" } }) },
});

defineConfig({
	services: {
		// @ts-expect-error clock is reserved for the instance clock capability
		clock: unseededSlack({ config: { botToken: "xoxb-local", workspaceName: "Reserved" } }),
	},
});
