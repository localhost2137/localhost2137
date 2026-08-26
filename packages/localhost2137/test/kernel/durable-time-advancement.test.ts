import { describe, expect, it } from "vitest";
import type { PluginTimeAdvance } from "../../src/authoring/plugin.js";
import {
	DurableTimeAdvancement,
	PendingTimeAdvanceConflictError,
	TimeAdvanceCommittedError,
	type TimeAdvanceManifestStore,
	type TimeAdvanceTaskBoundary,
	TimeAdvanceServiceMissingError,
} from "../../src/kernel/durable-time-advancement.js";
import { parseInstanceId } from "../../src/kernel/identifiers.js";
import { InstanceClock } from "../../src/kernel/instance-clock.js";
import { StorageWriteCommittedError } from "../../src/kernel/instance-storage.js";
import type { InstanceManifest } from "../../src/kernel/manifests.js";
import type { AnyServiceLifecycle } from "../../src/kernel/service-lifecycle.js";
import { InstanceTaskTracker } from "../../src/kernel/task-tracker.js";

describe("durable time advancement", () => {
	it("does not report an uncommitted initial manifest failure as a moved clock", async () => {
		let manifest = fixtureManifest(["stripe"]);
		let hookCalls = 0;
		const advance = coordinator(
			() => manifest,
			(next) => (manifest = next),
			[service("stripe", () => (hookCalls += 1))],
			manifestStore(() => {
				throw new Error("initial write did not commit");
			}),
		);

		const failure = await advance.advance(1_000).catch((cause: unknown) => cause);

		expect(failure).toMatchObject({ message: "initial write did not commit" });
		expect(failure).not.toBeInstanceOf(TimeAdvanceCommittedError);
		expect(hookCalls).toBe(0);
		expect(manifest.clock).toEqual({
			instantMs: Date.parse("2026-01-01T00:00:00.000Z"),
			mode: "pinned",
		});
		expect(manifest.timeAdvance).toBeUndefined();
	});

	it("persists the moved clock first and resumes only the unacknowledged service suffix", async () => {
		let manifest = fixtureManifest();
		const calls: string[] = [];
		let failStripe = true;
		const services = [
			service("slack", ({ advanceId }) => calls.push(`slack:${advanceId}`)),
			service("stripe", ({ advanceId }) => {
				calls.push(`stripe:${advanceId}`);
				if (failStripe) throw new Error("interrupted stripe reconciliation");
			}),
		];
		const store = manifestStore((next) => (manifest = next));
		const first = coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			store,
		);

		await expect(first.advance(86_400_000)).rejects.toMatchObject({
			name: "TimeAdvanceCommittedError",
			reconciliationPending: true,
			result: { advanceId: "advance_token" },
		});
		expect(manifest.clock).toEqual({
			instantMs: Date.parse("2026-01-02T00:00:00.000Z"),
			mode: "pinned",
		});
		expect(manifest.timeAdvance).toMatchObject({
			acknowledgedServices: ["slack"],
		});

		failStripe = false;
		const restarted = coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			store,
		);
		await restarted.recover();

		expect(calls).toEqual(["slack:advance_token", "stripe:advance_token", "stripe:advance_token"]);
		expect(manifest.timeAdvance).toBeUndefined();
	});

	it("replays one hook after a pre-ack write failure without duplicating an idempotent effect", async () => {
		let manifest = fixtureManifest(["stripe"]);
		const durableEffects = new Set<string>();
		let hookCalls = 0;
		let writes = 0;
		const services = [
			service("stripe", ({ advanceId }) => {
				hookCalls += 1;
				durableEffects.add(advanceId);
			}),
		];
		const failingStore = manifestStore((next) => {
			writes += 1;
			if (writes === 2) throw new Error("ack write did not commit");
			manifest = next;
		});
		const first = coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			failingStore,
		);
		await expect(first.advance(1_000)).rejects.toMatchObject({
			reconciliationPending: true,
		});
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual([]);

		const restarted = coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			manifestStore((next) => (manifest = next)),
		);
		await restarted.recover();

		expect(hookCalls).toBe(2);
		expect([...durableEffects]).toEqual(["advance_token"]);
		expect(manifest.timeAdvance).toBeUndefined();
	});

	it("hard-fails recovery when an unacknowledged configured service is unavailable", async () => {
		let manifest: InstanceManifest = {
			...fixtureManifest(["stripe"]),
			clock: { instantMs: 1_000, mode: "pinned" },
			timeAdvance: {
				acknowledgedServices: [],
				fromMs: 0,
				id: "advance_token",
				services: ["stripe"],
				toMs: 1_000,
			},
		};
		const recovery = coordinator(
			() => manifest,
			(next) => (manifest = next),
			[],
			manifestStore((next) => (manifest = next)),
		);

		await expect(recovery.recover()).rejects.toBeInstanceOf(TimeAdvanceServiceMissingError);
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual([]);
	});

	it("clears an all-acknowledged crash record without rerunning a hook", async () => {
		let manifest = fixtureManifest(["stripe"]);
		let calls = 0;
		let writes = 0;
		const services = [service("stripe", () => (calls += 1))];
		const first = coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			manifestStore((next) => {
				writes += 1;
				if (writes === 3) throw new Error("final clear did not commit");
				manifest = next;
			}),
		);

		await expect(first.advance(1_000)).rejects.toMatchObject({
			reconciliationPending: true,
		});
		expect(calls).toBe(1);
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual(["stripe"]);

		await coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			manifestStore((next) => (manifest = next)),
		).recover();
		expect(calls).toBe(1);
		expect(manifest.timeAdvance).toBeUndefined();
	});

	it("resumes a matching pending duration and rejects a different one without moving time", async () => {
		let manifest: InstanceManifest = {
			...fixtureManifest(["stripe"]),
			clock: { instantMs: 1_000, mode: "pinned" },
			timeAdvance: {
				acknowledgedServices: [],
				fromMs: 0,
				id: "advance_existing",
				services: ["stripe"],
				toMs: 1_000,
			},
		};
		let calls = 0;
		const advance = coordinator(
			() => manifest,
			(next) => (manifest = next),
			[service("stripe", () => (calls += 1))],
			manifestStore((next) => (manifest = next)),
		);

		await expect(advance.advance(2_000)).rejects.toBeInstanceOf(PendingTimeAdvanceConflictError);
		expect(calls).toBe(0);
		expect(manifest.clock).toEqual({ instantMs: 1_000, mode: "pinned" });
		await expect(advance.advance(1_000)).resolves.toMatchObject({
			advanceId: "advance_existing",
		});
		expect(calls).toBe(1);
	});

	it.each([
		{ name: "initial clock and pending record", warningWrite: 1 },
		{ name: "service acknowledgement", warningWrite: 2 },
		{ name: "final pending-record clear", warningWrite: 3 },
	] as const)(
		"reports a committed warning at the $name as completed and non-resumable",
		async ({ warningWrite }) => {
			let manifest = fixtureManifest(["stripe"]);
			let writes = 0;
			const advance = coordinator(
				() => manifest,
				(next) => (manifest = next),
				[service("stripe", () => undefined)],
				manifestStore((next) => {
					writes += 1;
					if (writes === warningWrite) {
						throw new StorageWriteCommittedError(
							"write_instance",
							next,
							new Error("injected post-commit durability warning"),
						);
					}
					manifest = next;
				}),
			);

			const failure = await advance.advance(1_000).catch((cause: unknown) => cause);

			expect(failure).toMatchObject({
				name: "TimeAdvanceCommittedError",
				reconciliationPending: false,
			});
			expect(manifest.timeAdvance).toBeUndefined();
			expect(Object.getOwnPropertyDescriptor(failure, "reconciliationPending")).toMatchObject({
				configurable: false,
				writable: false,
			});
		},
	);

	it("does not acknowledge a hook whose scoped drain observes cancellation", async () => {
		let manifest = fixtureManifest(["stripe"]);
		let calls = 0;
		let writes = 0;
		const cancellation = new AbortController();
		const services = [
			service("stripe", () => {
				calls += 1;
				cancellation.abort(new Error("cancel before final clear"));
			}),
		];
		const store = manifestStore((next) => {
			writes += 1;
			manifest = next;
		});

		await expect(
			coordinator(
				() => manifest,
				(next) => (manifest = next),
				services,
				store,
			).advance(1_000, cancellation.signal),
		).rejects.toMatchObject({ reconciliationPending: true });
		expect(writes).toBe(1);
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual([]);

		await coordinator(
			() => manifest,
			(next) => (manifest = next),
			services,
			store,
		).recover();
		expect(calls).toBe(2);
		expect(writes).toBe(3);
		expect(manifest.timeAdvance).toBeUndefined();
	});

	it("gives each service fresh Date objects", async () => {
		let manifest = fixtureManifest(["first", "second"]);
		const observed: number[] = [];
		const first = service("first", (advance) => {
			advance.to.setTime(0);
		});
		const second = service("second", (advance) => observed.push(advance.to.getTime()));
		await coordinator(
			() => manifest,
			(next) => (manifest = next),
			[first, second],
			manifestStore((next) => (manifest = next)),
		).advance(1_000);

		expect(observed).toEqual([Date.parse("2026-01-01T00:00:01.000Z")]);
	});

	it("does not acknowledge a service whose time hook launches failing tracked work", async () => {
		let manifest = fixtureManifest(["stripe"]);
		const tasks = taskTracker();
		const olderFailure = new Error("retained from earlier work");
		await expect(tasks.track("older", Promise.reject(olderFailure))).rejects.toBe(olderFailure);
		const hookTaskFailure = new Error("renewal delivery failed");
		const advance = coordinator(
			() => manifest,
			(next) => (manifest = next),
			[
				service("stripe", () => {
					void tasks.track("renewal delivery", Promise.reject(hookTaskFailure));
				}),
			],
			manifestStore((next) => (manifest = next)),
			{
				failureCheckpoint: () => tasks.failureCheckpoint(),
				idleSince: (checkpoint) => tasks.idleSince(checkpoint),
			},
		);

		const failure = await advance.advance(1_000).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(TimeAdvanceCommittedError);
		expect(failure).toMatchObject({
			errors: [{ failures: [{ cause: hookTaskFailure, label: "renewal delivery" }] }],
			reconciliationPending: true,
		});
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual([]);
		await expect(tasks.idle()).rejects.toMatchObject({
			failures: [{ cause: olderFailure, label: "older" }],
		});
	});

	it("drains scoped work after a throwing time hook and preserves both failures", async () => {
		let manifest = fixtureManifest(["stripe"]);
		const tasks = taskTracker();
		const deferredTask = deferred<void>();
		const hookFailure = new Error("hook failed");
		const taskFailure = new Error("hook cleanup failed");
		const advance = coordinator(
			() => manifest,
			(next) => (manifest = next),
			[
				service("stripe", () => {
					void tasks.track(
						"hook cleanup",
						deferredTask.promise.then(() => Promise.reject(taskFailure)),
					);
					throw hookFailure;
				}),
			],
			manifestStore((next) => (manifest = next)),
			{
				failureCheckpoint: () => tasks.failureCheckpoint(),
				idleSince: (checkpoint) => tasks.idleSince(checkpoint),
			},
		);
		const advancing = advance.advance(1_000);
		let settled = false;
		void advancing.finally(() => (settled = true)).catch(() => undefined);
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);

		deferredTask.resolve();
		const failure = await advancing.catch((cause: unknown) => cause);

		expect(failure).toMatchObject({
			errors: [
				{
					errors: [hookFailure, { failures: [{ cause: taskFailure, label: "hook cleanup" }] }],
				},
			],
			reconciliationPending: true,
		});
		expect(manifest.timeAdvance?.acknowledgedServices).toEqual([]);
	});
});

function taskTracker(): InstanceTaskTracker {
	return new InstanceTaskTracker({
		schedule: () => {
			throw new Error("This test does not schedule task timeouts.");
		},
	});
}

function taskBoundary(tasks: InstanceTaskTracker): TimeAdvanceTaskBoundary {
	return {
		failureCheckpoint: () => tasks.failureCheckpoint(),
		idleSince: (checkpoint, signal) => tasks.idleSince(checkpoint, signal ? { signal } : {}),
	};
}

function deferred<T>(): Readonly<{
	promise: Promise<T>;
	reject: (cause?: unknown) => void;
	resolve: (value: T | PromiseLike<T>) => void;
}> {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
	let rejectPromise: (cause?: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return Object.freeze({
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
	});
}

function coordinator(
	getManifest: () => InstanceManifest,
	setManifest: (manifest: InstanceManifest) => void,
	services: readonly AnyServiceLifecycle[],
	store: TimeAdvanceManifestStore,
	tasks: TimeAdvanceTaskBoundary = taskBoundary(taskTracker()),
): DurableTimeAdvancement {
	return new DurableTimeAdvancement({
		clock: new InstanceClock(getManifest().clock, { nowMilliseconds: () => 0 }),
		getManifest,
		instanceId: parseInstanceId("dev"),
		services,
		setManifest,
		storage: store,
		tasks,
		token: () => "token",
	});
}

function manifestStore(write: (manifest: InstanceManifest) => void): TimeAdvanceManifestStore {
	return {
		async writeInstance(_instanceId, manifest) {
			write(manifest);
		},
	};
}

function service(
	serviceKey: string,
	onTimeAdvanced: (advance: PluginTimeAdvance) => void,
): AnyServiceLifecycle {
	return {
		onTimeAdvanced: async (advance) => onTimeAdvanced(advance),
		pluginId: serviceKey,
		reconcile: async () => ({ kind: "unchanged", stateVersion: 1 }),
		runningContext: () => {
			throw new Error("Not used by this test.");
		},
		seed: async () => undefined,
		serviceKey,
		start: async () => undefined,
		stateVersion: 1,
		status: () => "running",
		stop: async () => undefined,
	};
}

function fixtureManifest(services: readonly string[] = ["slack", "stripe"]): InstanceManifest {
	return {
		clock: {
			instantMs: Date.parse("2026-01-01T00:00:00.000Z"),
			mode: "pinned",
		},
		configuredServices: services,
		configFingerprint: `sha256:${"a".repeat(64)}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		id: "dev",
		persistence: "persistent",
		schemaVersion: 2,
		seed: { attempt: 0, status: "unseeded" },
		status: "ready",
	};
}
