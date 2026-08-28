import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defineConfig } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { verifySlackRequestSignature } from "../src/events/request-signature.js";
import { slack } from "../src/index.js";

type Runtime = TestRuntime<ReturnType<typeof config>["services"]>;
type SlackInstance = Awaited<ReturnType<Runtime["createInstance"]>>;

const ownedRuntimes: Runtime[] = [];
const ownedServers: Server[] = [];

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

describe("Slack dashboard transport", () => {
	it("observes and mutates the same workspace as operations and Slack Web API", async () => {
		const runtime = await startRuntime();
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const created = await uiJson(instance, "channels", {
				creator: ada.id,
				name: "General",
			});
			expect(created.response.status).toBe(201);
			expect(created.body).toMatchObject({
				channel: { memberIds: ["U000000", ada.id], name: "general", private: false },
			});
			const channelId = requireChannelId(created.body);

			const initial = await uiSnapshot(instance, channelId);
			expect(initial.headers.get("cache-control")).toBe("no-store");
			expect(initial.headers.get("content-type")).toMatch(/^application\/json\b/);
			const initialBody = await initial.json();
			expect(initialBody).toEqual({
				channels: [
					{
						createdAt: "2026-01-01T00:00:00.000Z",
						id: channelId,
						memberIds: ["U000000", ada.id],
						name: "general",
						private: false,
					},
				],
				hasMoreMessages: false,
				messages: [],
				selectedChannelId: channelId,
				users: [
					{
						admin: false,
						bot: true,
						createdAt: "2026-01-01T00:00:00.000Z",
						id: "U000000",
						name: "localhost2137-bot",
					},
					{
						admin: false,
						bot: false,
						createdAt: "2026-01-01T00:00:00.000Z",
						id: ada.id,
						name: "Ada",
					},
				],
				version: 1,
				workspace: { id: "T000001", name: "Dashboard Test" },
			});
			const exposed = JSON.stringify(initialBody);
			for (const privateValue of [
				instance.slack.connection.botToken,
				instance.slack.connection.signingSecret,
				runtime.connection.token,
				"slack.sqlite",
			]) {
				expect(exposed).not.toContain(privateValue);
			}

			const uiMessage = await uiJson(instance, "messages", {
				channel: channelId,
				text: "written in the dashboard",
				user: ada.id,
			});
			expect(uiMessage.response.status).toBe(201);
			expect(uiMessage.body).toMatchObject({
				message: { channelId, text: "written in the dashboard", userId: ada.id },
			});
			expect(await instance.slack.listMessages({ channel: channelId })).toMatchObject([
				{ text: "written in the dashboard", userId: ada.id },
			]);

			const apiResponse = await fetch(`${instance.slack.connection.apiUrl}chat.postMessage`, {
				body: JSON.stringify({ channel: channelId, text: "written through Slack Web API" }),
				headers: {
					authorization: `Bearer ${instance.slack.connection.botToken}`,
					"content-type": "application/json",
				},
				method: "POST",
			});
			expect(await apiResponse.json()).toMatchObject({ ok: true });

			await instance.slack.createChannel({ name: "from-cli" });
			const refreshed = await uiSnapshot(instance, channelId);
			const refreshedBody = await refreshed.json();
			expect(refreshedBody).toMatchObject({
				channels: [{ id: channelId, name: "general" }, { name: "from-cli" }],
				messages: [
					{ text: "written through Slack Web API", userId: "U000000" },
					{ text: "written in the dashboard", userId: ada.id },
				],
			});
			assertSnapshotKeys(refreshedBody);
		} finally {
			await instance.destroy();
		}
	});

	it("keeps private UI mutations isolated and channel creation atomic", async () => {
		const runtime = await startRuntime();
		const first = await runtime.createInstance();
		const second = await runtime.createInstance();
		try {
			const invalid = await uiJson(first, "channels", {
				creator: "U_MISSING",
				name: "must-not-exist",
			});
			expect(invalid.response.status).toBe(404);
			expect(invalid.response.headers.get("cache-control")).toBe("no-store");
			expect(invalid.response.headers.get("content-type")).toMatch(/^application\/json\b/);
			expect(invalid.body).toEqual({
				error: {
					code: "user_not_found",
					message: "Slack user U_MISSING was not found.",
				},
			});
			expect(await (await uiSnapshot(first)).json()).toMatchObject({ channels: [] });

			const ada = await first.slack.createUser({ name: "Ada" });
			await uiJson(first, "channels", { creator: ada.id, name: "first-only" });
			expect(await (await uiSnapshot(first)).json()).toMatchObject({
				channels: [{ name: "first-only" }],
			});
			expect(await (await uiSnapshot(second)).json()).toMatchObject({ channels: [] });

			const uppercaseMediaType = await fetch(uiUrl(first, "channels"), {
				body: JSON.stringify({ creator: ada.id, name: "case-insensitive-json" }),
				headers: { "content-type": "Application/JSON; Charset=UTF-8" },
				method: "POST",
			});
			expect(uppercaseMediaType.status).toBe(201);

			const malformed = await fetch(uiUrl(first, "channels"), {
				body: "{",
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			expect(malformed.status).toBe(400);
			expect(await malformed.json()).toEqual({
				error: { code: "invalid_request", message: "Request body must be valid JSON." },
			});
		} finally {
			await Promise.all([first.destroy(), second.destroy()]);
		}
	});

	it("reports when a newest-first message snapshot omits older history", async () => {
		const runtime = await startRuntime();
		const instance = await runtime.createInstance();
		try {
			const channel = await instance.slack.createChannel({ name: "history" });
			for (let index = 0; index < 201; index += 1) {
				await instance.slack.sendMessage({
					channel: channel.id,
					from: "U000000",
					text: `message-${String(index)}`,
				});
			}

			const body = (await (await uiSnapshot(instance, channel.id)).json()) as {
				hasMoreMessages: boolean;
				messages: Array<{ text: string }>;
			};
			expect(body.hasMoreMessages).toBe(true);
			expect(body.messages).toHaveLength(200);
			expect(body.messages.map(({ text }) => text)).toEqual(
				Array.from({ length: 200 }, (_, index) => `message-${String(200 - index)}`),
			);
		} finally {
			await instance.destroy();
		}
	});

	it("posts one correctly associated Events API callback through the dashboard", async () => {
		const deliveries: ReceivedRequest[] = [];
		const receiver = await startReceiver(async (request) => {
			deliveries.push(await readRequest(request));
		});
		const runtime = await startRuntime(receiver.url);
		const instance = await runtime.createInstance();
		try {
			const ada = await instance.slack.createUser({ name: "Ada" });
			const channel = await instance.slack.createChannel({ name: "events" });
			await instance.slack.addUserToChannel({ channel: channel.id, user: ada.id });

			const posted = await uiJson(instance, "messages", {
				channel: channel.id,
				text: "dashboard event",
				user: ada.id,
			});
			expect(posted.response.status).toBe(201);
			const message = requireMessage(posted.body);
			await instance.idle();

			expect(deliveries).toHaveLength(1);
			const delivery = deliveries[0];
			if (!delivery) throw new TypeError("Dashboard callback delivery is missing.");
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
				event: {
					channel: channel.id,
					text: message.text,
					ts: message.ts,
					user: ada.id,
				},
				type: "event_callback",
			});
			expect(await instance.slack.listMessages({ channel: channel.id })).toHaveLength(1);

			const exposed = JSON.stringify(await (await uiSnapshot(instance, channel.id)).json());
			expect(exposed).not.toContain(receiver.url);
			expect(exposed).not.toContain(instance.slack.connection.signingSecret);
		} finally {
			await instance.destroy();
		}
	});
});

function config(eventsUrl: string | null = null) {
	return defineConfig({
		clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
		services: {
			slack: slack({
				config: {
					botToken: "xoxb-dashboard-test",
					eventsUrl,
					signingSecret: "dashboard-test-secret",
					workspaceName: "Dashboard Test",
				},
			}),
		},
	});
}

async function startRuntime(eventsUrl: string | null = null): Promise<Runtime> {
	const runtime = await createTestRuntime({
		config: config(eventsUrl),
		port: 0,
		storage: "temporary",
	});
	ownedRuntimes.push(runtime);
	return runtime;
}

function uiSnapshot(instance: SlackInstance, channel?: string): Promise<Response> {
	const url = new URL("snapshot", uiUrl(instance));
	if (channel) url.searchParams.set("channel", channel);
	return fetch(url);
}

async function uiJson(
	instance: SlackInstance,
	path: string,
	body: unknown,
): Promise<Readonly<{ body: unknown; response: Response }>> {
	const response = await fetch(uiUrl(instance, path), {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
	return { body: await response.json(), response };
}

function uiUrl(instance: SlackInstance, path = ""): URL {
	const root = new URL("../", instance.slack.connection.apiUrl);
	return new URL(`_localhost2137/ui/v1/${path}`, root);
}

function requireChannelId(value: unknown): string {
	if (
		typeof value !== "object" ||
		value === null ||
		!("channel" in value) ||
		typeof value.channel !== "object" ||
		value.channel === null ||
		!("id" in value.channel) ||
		typeof value.channel.id !== "string"
	) {
		throw new TypeError("Dashboard response did not contain a channel ID.");
	}
	return value.channel.id;
}

function requireMessage(value: unknown): Readonly<{ text: string; ts: string }> {
	if (
		typeof value !== "object" ||
		value === null ||
		!("message" in value) ||
		typeof value.message !== "object" ||
		value.message === null ||
		!("text" in value.message) ||
		typeof value.message.text !== "string" ||
		!("ts" in value.message) ||
		typeof value.message.ts !== "string"
	) {
		throw new TypeError("Dashboard response did not contain a message.");
	}
	return { text: value.message.text, ts: value.message.ts };
}

function assertSnapshotKeys(value: unknown): void {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Dashboard snapshot must be an object.");
	}
	const record = value as Readonly<Record<string, unknown>>;
	expect(Object.keys(record).sort()).toEqual([
		"channels",
		"hasMoreMessages",
		"messages",
		"selectedChannelId",
		"users",
		"version",
		"workspace",
	]);
	if (typeof record.workspace !== "object" || !record.workspace) {
		throw new TypeError("Dashboard snapshot workspace must be an object.");
	}
	expect(Object.keys(record.workspace).sort()).toEqual(["id", "name"]);
	for (const [key, expected] of [
		["channels", ["createdAt", "id", "memberIds", "name", "private"]],
		["users", ["admin", "bot", "createdAt", "id", "name"]],
		["messages", ["channelId", "createdAt", "id", "text", "threadTs", "ts", "userId"]],
	] as const) {
		if (!Array.isArray(record[key])) {
			throw new TypeError(`Dashboard snapshot ${key} must be an array.`);
		}
		for (const item of record[key]) {
			expect(Object.keys(item).sort()).toEqual([...expected].sort());
		}
	}
}

interface ReceivedRequest {
	readonly body: string;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

async function startReceiver(
	handler: (request: IncomingMessage) => Promise<void>,
): Promise<Readonly<{ url: string }>> {
	const server = createServer((request, response) => {
		void handler(request)
			.then(() => response.writeHead(204).end())
			.catch(() => response.destroy());
	});
	ownedServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${String(address.port)}/events` };
}

async function readRequest(request: IncomingMessage): Promise<ReceivedRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return { body: Buffer.concat(chunks).toString("utf8"), headers: request.headers };
}

function requiredHeader(
	headers: Readonly<Record<string, string | string[] | undefined>>,
	name: string,
): string {
	const value = headers[name];
	if (typeof value !== "string") throw new TypeError(`Missing ${name} header.`);
	return value;
}
