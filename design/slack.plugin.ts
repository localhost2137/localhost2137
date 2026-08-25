/**
 * Proposed plugin-authoring contract, using Slack as the example.
 *
 * Shape notes (merged after review of two competing proposals):
 *
 * - `api` is a PLAIN module-level `new Hono()`. Familiarity wins: anyone who
 *   recognizes Hono already knows how to write handlers, and agents pattern-
 *   match on known libraries. A Hono app is a route table, not a server —
 *   the runtime mounts this same table under every instance and injects that
 *   instance's context into Hono variables before each request. Handlers
 *   access it via c.get("lh").
 *   RULE: handlers must never close over mutable module state — everything
 *   instance-specific comes from c.get("lh"). (Two-instance tests catch
 *   violations cheaply, since one table serves all instances.)
 * - `PluginEnv<…>` is ONLY a type helper for the c.get("lh") variable —
 *   the app itself is ordinary Hono, no wrapper, no dialect.
 * - Lifecycle: create -> update? -> start -> seed? -> stop.
 *   No migrate hook: how a plugin manages its own storage is its business;
 *   the runtime only tells it WHEN things happen.
 */
import { definePlugin, defineOperation } from "localhost2137";
import { Hono } from "hono";
import { z } from "zod";

// ── Configuration & seed schemas ────────────────────────────────────────
// config   → durable emulator behavior, read on every boot
// seed     → initial world data. NOT applied automatically — only when
//            someone runs `localhost seed` / localhost.seed(). Declared as
//            a schema so the envelope slot in localhost.config.ts is
//            validated and the runtime knows what "seeding" means for us.
const configSchema = z.object({
	workspaceName: z.string(),
	botToken: z.string().startsWith("xoxb-"),
	signingSecret: z.string(),
	// Where Events API payloads get POSTed. Explicit plugin-owned callback URL;
	// runtime callback composition/interception is deferred.
	eventsUrl: z.string().url().nullable().default(null),
});

const seedSchema = z.object({
	users: z
		.array(
			z.object({
				id: z.string().optional(), // deterministic ids welcome: "U_ALICE"
				name: z.string(),
				admin: z.boolean().default(false),
			}),
		)
		.default([]),
	channels: z
		.array(
			z.object({
				id: z.string().optional(),
				name: z.string(),
				members: z.array(z.string()).default([]),
			}),
		)
		.default([]),
});

type Config = z.infer<typeof configSchema>;
type Seed = z.infer<typeof seedSchema>;
type State = { db: Database };

// Bind plugin identity and runtime context once. Every operation below remains
// a standalone descriptor value without repeating State/Config generics.
const defineSlackOperation = defineOperation<"slack", State, Config>();

// ── Public emulated API (plain Hono route table) ───────────────────────
// Mounted at /{instance}/slack/* e.g. http://127.0.0.1:2137/dev/slack/api/…
// PluginEnv<…> only types the injected "lh" variable — otherwise this is
// stock Hono, exactly as it appears in any Hono tutorial.
const api = new Hono<PluginEnv<State, Config>>();

api.get("/health", (c) => c.json({ ok: true }));

api.post("/api/chat.postMessage", async (c) => {
	const { state, config, clock } = c.get("lh");
	const body = await c.req.json();
	if (!isAuthorized(c.req.header("Authorization"), config.botToken)) {
		return c.json({ ok: false, error: "invalid_auth" }, 401);
	}
	const message = await state.db.messages.insert({
		channel: body.channel,
		userId: await state.db.users.findByToken(config.botToken),
		text: body.text,
		ts: clock.now(), // virtual time, never Date.now()
	});
	return c.json({ ok: true, ts: message.ts });
});

api.get("/api/users.list", async (c) => {
	const { state } = c.get("lh");
	return c.json({ ok: true, members: await state.db.users.list() });
});

// ── Control-plane operations ───────────────────────────────────────────
// Privileged verbs for devs/tests/agents. Do NOT mirror real Slack endpoints.
// Source of truth for CLI, TS API, /_/v1 control HTTP, docs, MCP adapters.
const createUser = defineSlackOperation({
	description: "Create a user in the workspace",
	input: z.object({
		name: z.string().describe("Display name"),
		admin: z.boolean().default(false),
	}),
	output: z.object({ id: z.string(), name: z.string(), admin: z.boolean() }),
	run: async (ctx, input) => {
		const user = await ctx.state.db.users.insert({
			name: input.name,
			admin: input.admin,
		});
		return { id: user.id, name: user.name, admin: user.admin };
		// Generated CLI: localhost exec slack create-user --name Alice --admin --json
	},
});

const sendMessage = defineSlackOperation({
	description: "Send a message as if a user typed it (drives Events delivery)",
	input: z.object({
		channel: z.string(),
		from: z.string().describe("User id"),
		text: z.string(),
	}),
	output: z.object({ id: z.string() }),
	run: async (ctx, input) => {
		const message = await ctx.state.db.messages.insert({
			channel: input.channel,
			userId: input.from,
			text: input.text,
			ts: ctx.clock.now(),
		});
		if (ctx.config.eventsUrl) {
			// Outbound delivery is just HTTP — always through ctx.fetch so the
			// runtime can later intercept/route requests (see PluginContext).
			await ctx.fetch(ctx.config.eventsUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event("message", message)),
			});
		}
		return { id: message.id };
	},
});

const listMessages = defineSlackOperation({
	description: "Inspect messages in a channel",
	input: z.object({ channel: z.string() }),
	output: z.array(z.object({ id: z.string(), userId: z.string(), text: z.string() })),
	run: async (ctx, input) => ctx.state.db.messages.list(input.channel),
});

export const slack = definePlugin({
	id: "slack", // package identity; the services key in config names the mount
	stateVersion: 1, // storage compatibility, independent of package version
	description: "Stateful Slack emulator: users, channels, messages, events",

	configSchema,
	seedSchema,
	api,
	operations: { createUser, sendMessage, listMessages },

	lifecycle: {
		// Invoked ONCE when a new instance materializes this plugin (storage
		// empty). The right place for schema setup, initial migrations,
		// creating the database file, etc. How storage is managed internally
		// is entirely the plugin's business — the runtime only says WHEN.
		async create(ctx) {
			await createDb(ctx.storage.path("slack.db"));
		},

		// Invoked on an EXISTING instance when its stored integer state version
		// is lower than this plugin's stateVersion. Package releases do not
		// implicitly trigger persistence migrations.
		async update(ctx, version: { from: number; to: number }) {
			await migrateDb(ctx.storage.path("slack.db"), version);
		},

		// Interpret declared seed data into state. NEVER automatic — runs
		// only via `localhost seed` / localhost.seed(), BEFORE the config's
		// top-level scenario seed(localhost).
		async seed(ctx, seed: Seed) {
			const db = await openDb(ctx.storage.path("slack.db"));
			for (const user of seed.users) await db.users.insert(user);
			for (const ch of seed.channels) {
				const channel = await db.channels.insert(ch);
				for (const member of ch.members) await db.channels.addMember(channel.id, member);
			}
		},

		// Every boot. Open process-local resources; RETURN state (the
		// runtime attaches it and hands it to api handlers + operations).
		async start(ctx) {
			return { db: await openDb(ctx.storage.path("slack.db")) };
		},

		async stop(ctx) {
			await ctx.state.db.close();
		},
	},

	// ── Connection metadata ─────────────────────────────────────────────
	// `values`: typed metadata exposed as localhost.slack.connection.apiUrl
	// `env`:    env-var projection (aggregated into .localhost2137/.env,
	//           localhost env --json, and `localhost run -- <cmd>` injection).
	// If two slack mounts declare overlapping env names → boot-time error
	// telling you to wire those manually (multi-bot setups are hand-wired by nature).
	connection({ baseUrl, instanceId, serviceKey, config }) {
		const values = {
			apiUrl: `${baseUrl}/${instanceId}/${serviceKey}/api`,
			botToken: config.botToken,
			signingSecret: config.signingSecret,
		};
		return {
			values,
			env: {
				SLACK_API_URL: values.apiUrl,
				SLACK_BOT_TOKEN: values.botToken,
				SLACK_SIGNING_SECRET: values.signingSecret,
			},
		};
	},
});

// ── illustration-only helpers/stubs ──
declare function event(type: string, payload: unknown): unknown;
declare function isAuthorized(auth: string | undefined, botToken: string): boolean;
declare function createDb(path: string): Promise<void>;
declare function migrateDb(path: string, version: { from: number; to: number }): Promise<void>;
declare function openDb(path: string): Promise<Database>;

// What the runtime injects as c.get("lh") into every api handler, and what
// operations/lifecycle hooks receive as ctx. `fetch` is a runtime-provided,
// fetch()-compatible function for ALL plugin outbound requests (webhooks,
// token lookups): today it just performs the request; later it enables
// interception — e.g. rerouting deliveries aimed at your app's hostname so
// many parallel test worlds can share one port.
interface PluginContext<S, C> {
	state: S;
	config: C;
	clock: { now(): Date };
	storage: { path(relative: string): string };
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// Hono generic for the injected variable. Pure typing sugar — the app itself
// stays a plain `new Hono()`.
type PluginEnv<S, C> = {
	Variables: { lh: PluginContext<S, C> };
};

interface Database {
	close(): Promise<void>;
	users: {
		insert(row: unknown): Promise<{ id: string; name: string }>;
		findByToken(token: string): Promise<string>;
		list(): Promise<unknown[]>;
	};
	channels: {
		insert(row: unknown): Promise<{ id: string }>;
		addMember(channelId: string, userId: string): Promise<void>;
	};
	messages: {
		insert(row: unknown): Promise<{ id: string; ts: string }>;
		list(channel: string): Promise<Array<{ id: string; userId: string; text: string }>>;
	};
}
