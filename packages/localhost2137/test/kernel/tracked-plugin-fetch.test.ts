import { describe, expect, it, vi } from "vitest";
import { createRunningPluginContext } from "../../src/kernel/lifecycle-context.js";
import { StructuredLogRing } from "../../src/kernel/structured-log.js";
import { InstanceTaskTracker } from "../../src/kernel/task-tracker.js";
import { TrackedPluginFetch } from "../../src/kernel/tracked-plugin-fetch.js";

describe("TrackedPluginFetch", () => {
	it("participates in idle and records bounded request metadata without query secrets", async () => {
		const response = deferred<Response>();
		const fetch = vi.fn(async () => response.promise);
		const fixture = trackedFetch(fetch);

		const delivery = fixture.fetch.fetch("https://hooks.example.test/events?token=never-log-this", {
			headers: { authorization: "Bearer never-log-this" },
			method: "POST",
		});
		const idle = fixture.tasks.idle({ timeoutMs: 1_000 });
		let idleFinished = false;
		void idle.then(() => {
			idleFinished = true;
		});
		await Promise.resolve();

		expect(idleFinished).toBe(false);
		response.resolve(new Response("accepted", { status: 202 }));
		await expect(delivery).resolves.toMatchObject({ status: 202 });
		await idle;

		const snapshot = fixture.logs.snapshot();
		expect(snapshot.entries.map(({ status }) => status)).toEqual(["started", "succeeded"]);
		expect(snapshot.entries.at(-1)).toMatchObject({
			attributes: {
				attempts: 1,
				method: "POST",
				responseStatus: 202,
				target: "https://hooks.example.test/events",
			},
			kind: "delivery",
		});
		expect(JSON.stringify(snapshot)).not.toContain("never-log-this");
	});

	it("retains a failed delivery for idle after the caller handles it", async () => {
		const fixture = trackedFetch(async () => {
			throw new TypeError("private transport detail");
		});

		await expect(fixture.fetch.fetch("https://hooks.example.test/events")).rejects.toThrow(
			"private transport detail",
		);
		await expect(fixture.tasks.idle()).rejects.toMatchObject({
			failures: [{ label: "fetch:fixture:correlation-1" }],
		});
		expect(fixture.logs.snapshot().entries.at(-1)).toMatchObject({
			attributes: { error: "TypeError" },
			status: "failed",
		});
		expect(JSON.stringify(fixture.logs.snapshot())).not.toContain("private transport detail");
	});

	it("merges the running context signal with Request and init cancellation", async () => {
		const receivedSignals: AbortSignal[] = [];
		const contextController = new AbortController();
		const requestController = new AbortController();
		const initController = new AbortController();
		const context = createRunningPluginContext(
			{
				clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
				config: {},
				fetch: async (_input, init) => {
					if (!init?.signal) throw new Error("Expected a merged signal.");
					receivedSignals.push(init.signal);
					return new Response(null, { status: 204 });
				},
				instanceId: "dev",
				log: { info: vi.fn() },
				serviceKey: "fixture",
				signal: contextController.signal,
				storage: { path: (path) => `/tmp/${path}` },
				tasks: { track: async (_label, task) => task },
			},
			{},
		);
		const request = new Request("https://example.test", { signal: requestController.signal });

		await context.fetch(request, { signal: initController.signal });
		contextController.abort("runtime closed");

		expect(receivedSignals).toHaveLength(1);
		expect(receivedSignals[0]).toMatchObject({ aborted: true, reason: "runtime closed" });
	});
});

function trackedFetch(
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Readonly<{
	fetch: TrackedPluginFetch;
	logs: StructuredLogRing;
	tasks: InstanceTaskTracker;
}> {
	let correlation = 0;
	let monotonic = 0;
	const logs = new StructuredLogRing({ maxBytes: 100_000, maxEntries: 100 });
	const tasks = new InstanceTaskTracker({
		schedule: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return { cancel: () => clearTimeout(timer) };
		},
	});
	return {
		fetch: new TrackedPluginFetch({
			clock: { now: () => new Date("2026-08-25T12:00:00.000Z") },
			correlationId: () => `correlation-${++correlation}`,
			fetch,
			instanceId: "dev",
			logs,
			monotonicClock: { nowMilliseconds: () => ++monotonic },
			serviceKey: "fixture",
			tasks,
			time: {
				nowMilliseconds: () => 1,
				nowTimestamp: () => "2026-08-25T12:00:00.000Z",
			},
		}),
		logs,
		tasks,
	};
}

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => {
		resolve = settle;
	});
	return Object.freeze({ promise, resolve });
}
