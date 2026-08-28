import { defineConfig } from "localhost2137";
import { createTestRuntime, type TestRuntime } from "localhost2137/testing";
import { afterEach, describe, expect, it } from "vitest";
import { slack } from "../src/index.js";

type Runtime = TestRuntime<ReturnType<typeof config>["services"]>;
type SlackInstance = Awaited<ReturnType<Runtime["createInstance"]>>;

const ownedRuntimes: Runtime[] = [];

afterEach(async () => {
	await Promise.all(ownedRuntimes.splice(0).map((runtime) => runtime.close()));
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
			expect(await initial.json()).toMatchObject({
				channels: [{ id: channelId, memberIds: ["U000000", ada.id], name: "general" }],
				messages: [],
				selectedChannelId: channelId,
				users: [
					{ bot: true, id: "U000000", name: "localhost2137-bot" },
					{ bot: false, id: ada.id, name: "Ada" },
				],
				version: 1,
				workspace: { name: "Dashboard Test" },
			});

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
});

function config() {
	return defineConfig({
		clock: { mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" },
		services: {
			slack: slack({
				config: {
					botToken: "xoxb-dashboard-test",
					eventsUrl: null,
					signingSecret: "dashboard-test-secret",
					workspaceName: "Dashboard Test",
				},
			}),
		},
	});
}

async function startRuntime(): Promise<Runtime> {
	const runtime = await createTestRuntime({ config: config(), port: 0, storage: "temporary" });
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
