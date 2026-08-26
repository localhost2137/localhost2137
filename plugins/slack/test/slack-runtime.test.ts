import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { defineConfig } from "localhost2137";
import { createTestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SlackSeed } from "../src/config.js";
import { verifySlackRequestSignature } from "../src/events/request-signature.js";
import { slack } from "../src/index.js";
import { createSlackPlugin } from "../src/plugin.js";
import { expectedSlackResponses, normalizeSlackResponse } from "./compatibility-fixtures.js";

const ownedServers: Array<ReturnType<typeof createServer>> = [];
const ownedRuntimes: Array<Awaited<ReturnType<typeof createTestRuntime>>> = [];

afterEach(async () => {
	await Promise.all(ownedRuntimes.splice(0).map((runtime) => runtime.close()));
	await Promise.all(
		ownedServers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((cause) => (cause ? reject(cause) : resolve())),
					),
			),
	);
});

describe("Slack runtime integration", () => {
	it("matches normalized compatibility fixtures for every supported Web API method", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ admin: true, name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "General" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });
			await instance.slack.sendMessage({ channel: channel.id, from: ada.id, text: "ping" });

			await expectFixture(
				"auth.test",
				await slackRequest(instance.slack.connection.apiUrl, "auth.test", {
					token: instance.slack.connection.botToken,
				}),
			);
			await expectFixture(
				"users.list",
				await slackRequest(instance.slack.connection.apiUrl, "users.list", {
					token: instance.slack.connection.botToken,
				}),
			);
			await expectFixture(
				"conversations.list",
				await slackRequest(instance.slack.connection.apiUrl, "conversations.list", {
					token: instance.slack.connection.botToken,
					types: "public_channel",
				}),
			);
			await expectFixture(
				"conversations.members",
				await slackGet(instance.slack.connection.apiUrl, "conversations.members", {
					channel: channel.id,
					token: instance.slack.connection.botToken,
				}),
			);
			await expectFixture(
				"chat.postMessage",
				await slackJson(
					instance.slack.connection.apiUrl,
					"chat.postMessage",
					{
						channel: channel.id,
						text: "pong",
					},
					instance.slack.connection.botToken,
				),
			);
			await expectFixture(
				"conversations.history",
				await slackGet(instance.slack.connection.apiUrl, "conversations.history", {
					channel: channel.id,
					token: instance.slack.connection.botToken,
				}),
			);
		} finally {
			await instance.destroy();
		}
	});

	it("shares one world across typed operations and Slack-compatible HTTP", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ admin: true, name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "General" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });

			const invalid = await slackRequest(instance.slack.connection.apiUrl, "users.list", {
				token: "bad-token",
			});
			expect(invalid.status).toBe(200);
			expect(await invalid.json()).toEqual({ error: "invalid_auth", ok: false });

			const users = await slackRequest(instance.slack.connection.apiUrl, "users.list", {
				token: instance.slack.connection.botToken,
			});
			expect(await users.json()).toMatchObject({
				members: [
					{ id: "U000000", is_bot: true },
					{ id: ada.id, is_admin: true, name: "Ada" },
				],
				ok: true,
				response_metadata: { next_cursor: "" },
			});

			const posted = await slackRequest(instance.slack.connection.apiUrl, "chat.postMessage", {
				channel: channel.id,
				text: "pong",
				token: instance.slack.connection.botToken,
			});
			expect(await posted.json()).toMatchObject({
				channel: channel.id,
				message: { bot_id: "B000001", subtype: "bot_message", text: "pong" },
				ok: true,
			});

			const messages = await instance.slack.listMessages({ channel: "general" });
			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({ text: "pong", userId: "U000000" });
			expect(messages[0]).not.toHaveProperty("eventId");
		} finally {
			await instance.destroy();
		}
	});

	it("preserves surrounding message whitespace across control, form, and JSON paths", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const channel = await instance.slack.createChannel({ name: "general" });
			const controlled = await instance.slack.sendMessage({
				channel: channel.id,
				from: "U000000",
				text: "  control text  ",
			});
			expect(controlled.text).toBe("  control text  ");

			const form = await slackRequest(instance.slack.connection.apiUrl, "chat.postMessage", {
				channel: channel.id,
				text: "  form text  ",
				token: instance.slack.connection.botToken,
			});
			expect(await form.json()).toMatchObject({ message: { text: "  form text  " }, ok: true });

			const json = await slackJson(
				instance.slack.connection.apiUrl,
				"chat.postMessage",
				{ channel: channel.id, text: "  JSON text  " },
				instance.slack.connection.botToken,
			);
			expect(await json.json()).toMatchObject({ message: { text: "  JSON text  " }, ok: true });

			expect(
				(await instance.slack.listMessages({ channel: channel.id })).map(({ text }) => text),
			).toEqual(["  JSON text  ", "  form text  ", "  control text  "]);
		} finally {
			await instance.destroy();
		}
	});

	it("accepts form-token authentication and rejects malformed request transports", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const apiUrl = instance.slack.connection.apiUrl;
			const formAuthenticated = await fetch(`${apiUrl}auth.test`, {
				body: new URLSearchParams({ token: instance.slack.connection.botToken }),
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			});
			expect(await formAuthenticated.json()).toMatchObject({ ok: true, user_id: "U000000" });

			const malformedRequests: readonly Readonly<{
				error: string;
				init?: RequestInit;
				path: string;
			}>[] = [
				{ error: "not_authed", path: "auth.test" },
				{
					error: "invalid_auth",
					init: { headers: { authorization: "Basic credentials" } },
					path: "auth.test",
				},
				{
					error: "invalid_arguments",
					init: {
						body: "ignored",
						headers: { "content-type": "text/plain" },
						method: "POST",
					},
					path: "auth.test",
				},
				{
					error: "invalid_arguments",
					init: {
						body: "{",
						headers: { "content-type": "application/json" },
						method: "POST",
					},
					path: "auth.test",
				},
				{
					error: "invalid_arguments",
					init: {
						body: "[]",
						headers: { "content-type": "application/json" },
						method: "POST",
					},
					path: "auth.test",
				},
				{
					error: "invalid_arguments",
					init: {
						body: JSON.stringify({ exclude_archived: [] }),
						headers: {
							authorization: `Bearer ${instance.slack.connection.botToken}`,
							"content-type": "application/json",
						},
						method: "POST",
					},
					path: "conversations.list",
				},
				{
					error: "invalid_arguments",
					init: {
						headers: { authorization: `Bearer ${instance.slack.connection.botToken}` },
					},
					path: "users.list?limit=1&limit=2",
				},
				{
					error: "invalid_types",
					init: {
						headers: { authorization: `Bearer ${instance.slack.connection.botToken}` },
					},
					path: "conversations.list?types=private_channel",
				},
				{
					error: "invalid_arguments",
					init: {
						headers: { authorization: `Bearer ${instance.slack.connection.botToken}` },
					},
					path: "conversations.list?exclude_archived=sometimes",
				},
			];
			for (const request of malformedRequests) {
				const response = await fetch(`${apiUrl}${request.path}`, request.init);
				expect(response.status, request.path).toBe(200);
				expect(await response.json(), request.path).toEqual({ error: request.error, ok: false });
			}
		} finally {
			await instance.destroy();
		}
	});

	it("requires exact stored channel IDs at every public Web API boundary", async () => {
		const runtime = await startRuntime(slack, null, {
			channels: [{ id: "C_GENERAL", members: ["U_ADA"], name: "general" }],
			users: [{ admin: false, id: "U_ADA", name: "Ada" }],
		});
		const instance = await runtime.createInstance({ seed: true });
		try {
			const connection = instance.slack.connection;
			const exactMembers = await slackGet(connection.apiUrl, "conversations.members", {
				channel: "C_GENERAL",
				token: connection.botToken,
			});
			expect(await exactMembers.json()).toMatchObject({
				members: ["U000000", "U_ADA"],
				ok: true,
			});
			const exactHistory = await slackGet(connection.apiUrl, "conversations.history", {
				channel: "C_GENERAL",
				token: connection.botToken,
			});
			expect(await exactHistory.json()).toMatchObject({ messages: [], ok: true });
			const exactPost = await slackRequest(connection.apiUrl, "chat.postMessage", {
				channel: "C_GENERAL",
				text: "stored semantic IDs remain valid",
				token: connection.botToken,
			});
			expect(await exactPost.json()).toMatchObject({ channel: "C_GENERAL", ok: true });

			for (const method of ["conversations.members", "conversations.history"] as const) {
				const response = await slackGet(connection.apiUrl, method, {
					channel: "general",
					token: connection.botToken,
				});
				expect(await response.json(), method).toEqual({ error: "channel_not_found", ok: false });
			}
			const namedPost = await slackRequest(connection.apiUrl, "chat.postMessage", {
				channel: "general",
				text: "must not be posted",
				token: connection.botToken,
			});
			expect(await namedPost.json()).toEqual({ error: "channel_not_found", ok: false });
		} finally {
			await instance.destroy();
		}
	});

	it("uses stable method-bound cursor pagination", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			await instance.slack.createUser({ name: "Ada" });
			await instance.slack.createUser({ name: "Grace" });
			const first = await slackGet(instance.slack.connection.apiUrl, "users.list", {
				limit: "1",
				token: instance.slack.connection.botToken,
			});
			const firstBody = await first.json();
			expect(firstBody).toMatchObject({ members: [{ id: "U000000" }], ok: true });
			const cursor = responseCursor(firstBody);
			expect(cursor).not.toBe("");

			const second = await slackGet(instance.slack.connection.apiUrl, "users.list", {
				cursor,
				limit: "1",
				token: instance.slack.connection.botToken,
			});
			expect(await second.json()).toMatchObject({ members: [{ id: "U000001" }], ok: true });

			const wrongMethod = await slackGet(instance.slack.connection.apiUrl, "conversations.list", {
				cursor,
				token: instance.slack.connection.botToken,
			});
			expect(await wrongMethod.json()).toEqual({ error: "invalid_cursor", ok: false });
		} finally {
			await instance.destroy();
		}
	});

	it("applies exact inclusive history boundaries", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const channel = await instance.slack.createChannel({ name: "general" });
			const first = await instance.slack.sendMessage({
				channel: channel.id,
				from: "U000000",
				text: "first",
			});
			const second = await instance.slack.sendMessage({
				channel: channel.id,
				from: "U000000",
				text: "second",
			});
			const third = await instance.slack.sendMessage({
				channel: channel.id,
				from: "U000000",
				text: "third",
			});
			const connection = instance.slack.connection;

			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["third"],
				oldest: second.ts,
			});
			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["third", "second"],
				inclusive: "true",
				oldest: second.ts,
			});
			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["first"],
				latest: second.ts,
			});
			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["second", "first"],
				inclusive: "true",
				latest: second.ts,
			});
			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["second"],
				latest: third.ts,
				oldest: first.ts,
			});
			await expectHistory(connection.apiUrl, connection.botToken, channel.id, {
				expected: ["third", "second", "first"],
				inclusive: "true",
				latest: third.ts,
				oldest: first.ts,
			});

			const outsideSqliteRange = await slackGet(connection.apiUrl, "conversations.history", {
				channel: channel.id,
				latest: "9223372036854.775808",
				token: connection.botToken,
			});
			expect(await outsideSqliteRange.json()).toEqual({ error: "invalid_ts_latest", ok: false });
		} finally {
			await instance.destroy();
		}
	});

	it("paginates timestamp-ordered history without duplicates or skips", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const channel = await instance.slack.createChannel({ name: "general" });
			for (const text of ["first", "second", "third", "fourth", "fifth"]) {
				await instance.slack.sendMessage({ channel: channel.id, from: "U000000", text });
			}
			const collected: string[] = [];
			let cursor = "";
			for (let page = 0; page < 3; page += 1) {
				const response = await slackGet(instance.slack.connection.apiUrl, "conversations.history", {
					channel: channel.id,
					...(cursor ? { cursor } : {}),
					limit: "2",
					token: instance.slack.connection.botToken,
				});
				const body = (await response.json()) as {
					messages: Array<{ text: string }>;
					response_metadata: { next_cursor: string };
				};
				collected.push(...body.messages.map(({ text }) => text));
				cursor = body.response_metadata.next_cursor;
			}
			expect(cursor).toBe("");
			expect(collected).toEqual(["fifth", "fourth", "third", "second", "first"]);
			expect(new Set(collected).size).toBe(collected.length);

			const firstPage = await slackGet(instance.slack.connection.apiUrl, "conversations.history", {
				channel: channel.id,
				limit: "2",
				token: instance.slack.connection.botToken,
			});
			const opaqueCursor = responseCursor(await firstPage.json());
			const invalidCursor = withCursorKey(opaqueCursor, "1767225600.0");
			const invalid = await slackGet(instance.slack.connection.apiUrl, "conversations.history", {
				channel: channel.id,
				cursor: invalidCursor,
				token: instance.slack.connection.botToken,
			});
			expect(await invalid.json()).toEqual({ error: "invalid_cursor", ok: false });
		} finally {
			await instance.destroy();
		}
	});

	it("maps Slack world invariant failures to stable control errors", async () => {
		const runtime = await startRuntime(slack, null);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "general" });
			await expect(instance.slack.createUser({ name: "Ada" })).rejects.toMatchObject({
				code: "SLACK_NAME_TAKEN",
				status: 409,
			});
			await expect(instance.slack.createChannel({ name: "GENERAL" })).rejects.toMatchObject({
				code: "SLACK_NAME_TAKEN",
				status: 409,
			});
			await expect(
				instance.slack.addUserToChannel({ channel: channel.id, user: "missing" }),
			).rejects.toMatchObject({ code: "SLACK_USER_NOT_FOUND", status: 404 });
			await expect(
				instance.slack.addUserToChannel({ channel: "missing", user: ada.id }),
			).rejects.toMatchObject({ code: "SLACK_CHANNEL_NOT_FOUND", status: 404 });
			await expect(
				instance.slack.sendMessage({ channel: channel.id, from: ada.id, text: "ping" }),
			).rejects.toMatchObject({ code: "SLACK_NOT_IN_CHANNEL", status: 409 });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });
			await expect(
				instance.slack.sendMessage({ channel: channel.id, from: ada.id, text: "   " }),
			).rejects.toMatchObject({ code: "SLACK_INVALID_ARGUMENTS", status: 400 });
			await expect(
				instance.slack.sendMessage({
					channel: channel.id,
					from: ada.id,
					text: "reply",
					threadTs: "1.000001",
				}),
			).rejects.toMatchObject({ code: "SLACK_INVALID_ARGUMENTS", status: 400 });
			await expect(instance.slack.createChannel({ name: "invalid channel" })).rejects.toMatchObject(
				{ code: "SLACK_INVALID_ARGUMENTS", status: 400 },
			);
		} finally {
			await instance.destroy();
		}
	});

	it("delivers a correctly signed stable message event and drains it with idle", async () => {
		const received = deferred<ReceivedRequest>();
		const receiver = await startReceiver(async (request, response) => {
			received.resolve(await readRequest(request));
			response.writeHead(204).end();
		});
		const runtime = await startRuntime(slack, receiver.url);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "general" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });
			const message = await instance.slack.sendMessage({
				channel: channel.id,
				from: ada.id,
				text: "  signed ping  ",
			});
			await instance.idle();
			const delivery = await received.promise;
			const timestamp = requiredHeader(delivery.headers, "x-slack-request-timestamp");
			const signature = requiredHeader(delivery.headers, "x-slack-signature");
			expect(
				verifySlackRequestSignature({
					body: delivery.body,
					secret: instance.slack.connection.signingSecret,
					signature,
					timestamp,
				}),
			).toBe(true);
			expect(JSON.parse(delivery.body)).toMatchObject({
				event: { channel: channel.id, text: "  signed ping  ", ts: message.ts, user: ada.id },
				event_id: message.eventId,
				type: "event_callback",
			});
			const logs = await runtime.control.logs(await instanceIdFrom(runtime), {
				service: "slack",
			});
			expect(logs).toMatchObject({
				entries: expect.arrayContaining([
					expect.objectContaining({
						attributes: {
							eventId: message.eventId,
							outcome: "succeeded",
							statusCode: 204,
						},
						kind: "plugin",
						message: "Slack event delivery completed.",
						serviceKey: "slack",
					}),
				]),
			});
		} finally {
			await instance.destroy();
		}
	});

	it.each([
		{ name: "non-2xx", status: 503 },
		{ name: "timeout", status: undefined },
	])("records and surfaces a single $name delivery failure", async ({ status }) => {
		const receiver = await startReceiver(async (_request, response) => {
			if (status === undefined) await new Promise<void>(() => undefined);
			response.writeHead(status ?? 204).end();
		});
		const runtime = await startRuntime(createSlackPlugin({ deliveryTimeoutMs: 30 }), receiver.url);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "general" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });
			const message = await instance.slack.sendMessage({
				channel: channel.id,
				from: ada.id,
				text: "ping",
			});
			await expect(instance.idle()).rejects.toThrow(/tracked task|failed/i);
			const logs = await runtime.control.logs(await instanceIdFrom(runtime), {
				service: "slack",
			});
			expect(logs).toMatchObject({
				entries: expect.arrayContaining([
					expect.objectContaining({
						attributes: {
							...(status === undefined ? {} : { statusCode: status }),
							error: status === undefined ? "timeout" : "non_success_status",
							eventId: message.eventId,
							outcome: "failed",
						},
						kind: "plugin",
						message: "Slack event delivery completed.",
						serviceKey: "slack",
					}),
				]),
			});
		} finally {
			await instance.destroy();
		}
	});
});

async function startRuntime(plugin: typeof slack, eventsUrl: string | null, seed?: SlackSeed) {
	const runtime = await createTestRuntime({
		config: defineConfig({
			clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
			services: {
				slack: plugin({
					config: {
						botToken: "xoxb-local-test",
						eventsUrl,
						signingSecret: "local-signing-secret",
						workspaceName: "Local Test",
					},
					...(seed ? { seed } : {}),
				}),
			},
		}),
		port: 0,
		storage: "temporary",
	});
	ownedRuntimes.push(runtime);
	return runtime;
}

async function slackRequest(
	apiUrl: string,
	method: string,
	values: Readonly<Record<string, string>>,
): Promise<Response> {
	const body = new URLSearchParams(values);
	const token = body.get("token");
	body.delete("token");
	return fetch(`${apiUrl}${method}`, {
		body,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/x-www-form-urlencoded; charset=utf-8",
		},
		method: "POST",
	});
}

async function slackGet(
	apiUrl: string,
	method: string,
	values: Readonly<Record<string, string>>,
): Promise<Response> {
	const query = new URLSearchParams(values);
	const token = query.get("token");
	query.delete("token");
	return fetch(`${apiUrl}${method}?${query}`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

function slackJson(
	apiUrl: string,
	method: string,
	values: Readonly<Record<string, unknown>>,
	token: string,
): Promise<Response> {
	return fetch(`${apiUrl}${method}`, {
		body: JSON.stringify(values),
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		method: "POST",
	});
}

async function expectFixture(method: string, response: Response): Promise<void> {
	expect(response.status).toBe(200);
	const normalized = normalizeSlackResponse(method, await response.json());
	expect(normalized).toEqual(expectedSlackResponses[method]);
}

interface ReceivedRequest {
	readonly body: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

async function readRequest(request: IncomingMessage): Promise<ReceivedRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Object.freeze({ body: Buffer.concat(chunks).toString("utf8"), headers: request.headers });
}

async function startReceiver(
	handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<Readonly<{ url: string }>> {
	const server = createServer((request, response) => {
		void handler(request, response).catch(() => response.destroy());
	});
	ownedServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address() as AddressInfo;
	return Object.freeze({ url: `http://127.0.0.1:${address.port}/slack/events` });
}

function responseCursor(body: unknown): string {
	return String(
		Reflect.get(Reflect.get(body as object, "response_metadata") as object, "next_cursor"),
	);
}

function withCursorKey(cursor: string, key: string): string {
	const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
		string,
		unknown
	>;
	return Buffer.from(JSON.stringify({ ...payload, key }), "utf8").toString("base64url");
}

async function expectHistory(
	apiUrl: string,
	token: string,
	channel: string,
	input: Readonly<{
		expected: readonly string[];
		inclusive?: string;
		latest?: string;
		oldest?: string;
	}>,
): Promise<void> {
	const response = await slackGet(apiUrl, "conversations.history", {
		channel,
		...(input.inclusive ? { inclusive: input.inclusive } : {}),
		...(input.latest ? { latest: input.latest } : {}),
		...(input.oldest ? { oldest: input.oldest } : {}),
		token,
	});
	const body = (await response.json()) as { messages: Array<{ text: string }> };
	expect(body.messages.map(({ text }) => text)).toEqual(input.expected);
}

function requiredHeader(
	headers: Readonly<Record<string, string | string[] | undefined>>,
	name: string,
): string {
	const value = headers[name];
	if (typeof value !== "string") throw new TypeError(`Missing ${name} header.`);
	return value;
}

async function instanceIdFrom(
	runtime: Awaited<ReturnType<typeof createTestRuntime>>,
): Promise<string> {
	const instances = await runtime.control.listInstances();
	if (!Array.isArray(instances) || instances.length !== 1) {
		throw new TypeError("Expected exactly one Slack test instance.");
	}
	const id = Reflect.get(instances[0] as object, "id");
	if (typeof id !== "string") throw new TypeError("Slack test instance has no ID.");
	return id;
}

function deferred<Value>() {
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({ promise, resolve: resolvePromise });
}
