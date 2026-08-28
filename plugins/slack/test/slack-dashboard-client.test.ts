import { describe, expect, it } from "vitest";
import { createSlackDashboardClient, type SlackDashboardRequestError } from "../ui/src/client.js";
import { createSlackWorkspacePoller } from "../ui/src/poller.js";

describe("Slack dashboard browser client", () => {
	it("keeps requests under the mounted service base and maps private errors", async () => {
		const requests: Request[] = [];
		const responses = [
			Response.json(snapshotFixture()),
			Response.json(
				{ error: { code: "not_in_channel", message: "Join the channel first." } },
				{ status: 409 },
			),
		];
		const client = createSlackDashboardClient({
			baseUrl: () => "http://127.0.0.1:2137/review-42/team-chat/",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				const response = responses.shift();
				if (!response) throw new TypeError("Unexpected dashboard request.");
				return response;
			},
		});

		await expect(client.snapshot("C_GENERAL")).resolves.toMatchObject({ version: 1 });
		expect(requests[0]?.url).toBe(
			"http://127.0.0.1:2137/review-42/team-chat/_localhost2137/ui/v1/snapshot?channel=C_GENERAL",
		);
		expect(requests[0]?.cache).toBe("no-store");
		expect(requests[0]?.headers.get("accept")).toBe("application/json");

		await expect(
			client.sendMessage({ channel: "C_GENERAL", text: "ping", user: "U_ADA" }),
		).rejects.toEqual(
			expect.objectContaining<Partial<SlackDashboardRequestError>>({
				code: "not_in_channel",
				message: "Join the channel first.",
				status: 409,
			}),
		);
		expect(requests[1]?.url).toBe(
			"http://127.0.0.1:2137/review-42/team-chat/_localhost2137/ui/v1/messages",
		);
		expect(await requests[1]?.json()).toEqual({
			channel: "C_GENERAL",
			text: "ping",
			user: "U_ADA",
		});
	});

	it("rejects malformed JSON and incompatible snapshot versions with stable errors", async () => {
		const responses = [
			new Response("{", { headers: { "content-type": "application/json" }, status: 200 }),
			Response.json({ ...snapshotFixture(), version: 2 }),
		];
		const client = createSlackDashboardClient({
			baseUrl: () => "http://127.0.0.1:2137/dev/slack/",
			fetch: async () => {
				const response = responses.shift();
				if (!response) throw new TypeError("Unexpected dashboard request.");
				return response;
			},
		});

		for (const message of [
			"The local Slack dashboard received invalid JSON.",
			"The local Slack dashboard snapshot is incompatible.",
		]) {
			await expect(client.snapshot(null)).rejects.toMatchObject({
				code: "invalid_response",
				message,
				status: 200,
			});
		}
	});

	it("never overlaps polls and immediately follows an in-flight mutation refresh", async () => {
		const loads: Array<ReturnType<typeof deferred<string>>> = [];
		const values: string[] = [];
		let concurrent = 0;
		let maximumConcurrent = 0;
		const scheduled: Array<Readonly<{ delay: number; run: () => void }>> = [];
		const poller = createSlackWorkspacePoller({
			isVisible: () => true,
			load: async () => {
				concurrent += 1;
				maximumConcurrent = Math.max(maximumConcurrent, concurrent);
				const load = deferred<string>();
				loads.push(load);
				try {
					return await load.promise;
				} finally {
					concurrent -= 1;
				}
			},
			onError: () => undefined,
			onValue: (value) => values.push(value),
			schedule: (run, delay) => {
				scheduled.push({ delay, run });
				return () => undefined;
			},
		});

		poller.start();
		expect(loads).toHaveLength(1);
		poller.refresh();
		poller.refresh();
		expect(loads).toHaveLength(1);
		loads[0]?.resolve("before mutation");
		await settleMicrotasks();
		expect(loads).toHaveLength(2);
		loads[1]?.resolve("after mutation");
		await settleMicrotasks();

		expect(maximumConcurrent).toBe(1);
		expect(values).toEqual(["before mutation", "after mutation"]);
		expect(scheduled.at(-1)?.delay).toBe(1_000);
		poller.stop();
	});

	it("aborts a visible poll when hidden and refreshes on return", async () => {
		let visible = true;
		const signals: AbortSignal[] = [];
		const poller = createSlackWorkspacePoller({
			isVisible: () => visible,
			load: (signal) => {
				signals.push(signal);
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			onError: () => undefined,
			onValue: () => undefined,
		});

		poller.start();
		expect(signals).toHaveLength(1);
		visible = false;
		poller.visibilityChanged();
		expect(signals[0]?.aborted).toBe(true);
		await settleMicrotasks();

		visible = true;
		poller.visibilityChanged();
		expect(signals).toHaveLength(2);
		poller.stop();
		expect(signals[1]?.aborted).toBe(true);
	});

	it("never commits an old channel result after its poller stops", async () => {
		const oldChannel = deferred<string>();
		const newChannel = deferred<string>();
		const values: string[] = [];
		const oldPoller = createSlackWorkspacePoller({
			isVisible: () => true,
			load: () => oldChannel.promise,
			onError: () => undefined,
			onValue: (value) => values.push(value),
		});
		const newPoller = createSlackWorkspacePoller({
			isVisible: () => true,
			load: () => newChannel.promise,
			onError: () => undefined,
			onValue: (value) => values.push(value),
		});

		oldPoller.start();
		oldPoller.stop();
		newPoller.start();
		newChannel.resolve("new-channel");
		await settleMicrotasks();
		oldChannel.resolve("old-channel");
		await settleMicrotasks();

		expect(values).toEqual(["new-channel"]);
		newPoller.stop();
	});
});

function snapshotFixture() {
	return {
		channels: [],
		hasMoreMessages: false,
		messages: [],
		selectedChannelId: null,
		users: [],
		version: 1,
		workspace: { id: "T000001", name: "Fixture" },
	};
}

function deferred<Value>() {
	let resolvePromise: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function settleMicrotasks(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) await Promise.resolve();
}
