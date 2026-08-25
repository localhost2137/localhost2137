/**
 * Programmatic API sketch — the same operations, driven from tests.
 *
 * Resource ownership is explicit: one test runtime owns the server and
 * temporary root; every test owns and destroys its isolated instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime } from "localhost2137/testing";
import config from "../localhost.config";
import { buildBotApp } from "../src/bot";

describe("ping-pong Slack bot", () => {
	let runtime: Awaited<ReturnType<typeof createTestRuntime>>;

	beforeAll(async () => {
		runtime = await createTestRuntime({
			config,
			storage: "temporary",
			port: 0,
		});
	});

	afterAll(async () => {
		await runtime.close();
	});

	it("replies pong to ping", async () => {
		const localhost = await runtime.createInstance({ seed: false });

		try {
			const alice = await localhost.slack.createUser({ name: "Alice" });
			await localhost.slack.createChannel({ name: "general" });

			const bot = buildBotApp({
				baseUrl: localhost.slack.connection.apiUrl,
				botToken: localhost.slack.connection.botToken,
			});
			expect(bot).toBeDefined();

			await localhost.slack.sendMessage({
				channel: "general",
				from: alice.id,
				text: "ping",
			});

			await localhost.idle();

			const messages = await localhost.slack.listMessages({ channel: "general" });
			expect(messages.some((message) => message.text === "pong")).toBe(true);
		} finally {
			await localhost.destroy();
		}
	});
});

/*
 * Parallelism remains structural: one runtime server, independent path-scoped
 * instances and storage directories. Configuration is complete and explicit;
 * v0.1 does not define per-instance deep-merge overrides.
 *
 * Snapshot/fork ideas are preserved in future.snapshots-and-forks.md and are
 * intentionally absent from the supported testing API.
 */
