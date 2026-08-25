/**
 * Programmatic API sketch — the same operations, driven from tests.
 * (Vitest-flavored; the shape is what matters.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createInstance, type Localhost } from "localhost2137/testing";
import { buildBotApp } from "../src/bot"; // the app under test

describe("ping-pong slack bot", () => {
	// Destroy-collector: afterEach cleanup even when a test throws mid-flight.
	const instances: Array<{ destroy(): Promise<void> }> = [];
	const track = <T extends { destroy(): Promise<void> }>(lh: T): T => {
		instances.push(lh);
		return lh;
	};

	let localhost: Localhost;

	beforeAll(async () => {
		// Ephemeral instance materialized from ./localhost.config.ts:
		//   - unique instance id on the shared runtime (URLs like /t-w1/slack)
		//     — isolation by path, no port juggling
		//   - throwaway storage dir
		//   - starts EMPTY (create → start); call await localhost.seed() to
		//     apply declarative + scenario seeds when a test wants them
		//   - everything dies on destroy()
		localhost = track(await createInstance({ id: `t-${process.env.VITEST_POOL_ID ?? "0"}` }));
	});

	afterEach(async () => {
		await Promise.all(instances.splice(0).map((i) => i.destroy()));
	});

	it("replies pong to ping", async () => {
		// Arrange — build the world through the control plane…
		const alice = await localhost.slack.createUser({ name: "Alice" });
		await localhost.slack.createChannel({ name: "general" });

		// …and wire the app under test using the plugin's connect map
		// (same values `localhost dev` writes into .localhost2137/.env).
		const bot = buildBotApp({
			baseUrl: localhost.slack.connect.SLACK_BASE_URL,
			botToken: localhost.slack.connect.SLACK_BOT_TOKEN,
		});
		expect(bot).toBeDefined();

		// Act — emit exactly what real Slack would have delivered.
		await localhost.slack.sendMessage({
			channel: "general",
			from: alice.id,
			text: "ping",
		});

		// Webhook/event delivery is async by default: wait until the world
		// has drained before asserting (deterministic tests, no sleeps).
		await localhost.idle();

		// Assert — inspect the world afterwards. Read ops are first-class.
		const messages = await localhost.slack.listMessages({ channel: "general" });
		expect(messages.some((m) => m.text === "pong")).toBe(true);
	});
});

describe("billing renewal (virtual time + snapshots)", () => {
	it("charges on the renewal date", async () => {
		const localhost = await createInstance();

		// Freeze a known world state before mutating time.
		const clean = await localhost.snapshot();

		// A month passes in milliseconds.
		await localhost.clock.advance("30d");

		const invoices = await localhost.stripe.listInvoices({});
		expect(invoices.length).toBeGreaterThan(0);

		// Fork from the pre-advance snapshot: identical starting world,
		// independent mutation — great for parallel scenarios.
		const other = await clean.fork();
		await other.clock.advance("90d");
		// …assert quarterly behavior independently of the first branch.

		await other.destroy();
		await localhost.destroy();
	});
});

/*
 * Parallelism is structural, not coordinated — each worker gets its own
 * instance id on the shared runtime (own URL prefix + own storage):
 *
 *   worker 1 → createInstance({ id: "t-1" }) → /t-1/slack/…
 *   worker 2 → createInstance({ id: "t-2" }) → /t-2/slack/…
 *
 * Config resolution: createInstance() auto-discovers ./localhost.config.ts;
 * pass an imported config explicitly for hermetic unit tests:
 *
 *   const lh = await createInstance(config);
 *
 * Or skip the file entirely:
 *
 *   const lh = await createInstance({
 *     plugins: [slack({ workspaceName: "Tiny", botToken: "xoxb-tiny", signingSecret: "s" })],
 *   });
 */
