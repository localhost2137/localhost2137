import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BasePluginContext, RunningPluginContext } from "../../src/authoring/context.js";
import { parseInstanceId, parseServiceKey } from "../../src/kernel/identifiers.js";
import type { MonotonicClock } from "../../src/kernel/instance-leases.js";
import { SeedNotAllowedError } from "../../src/kernel/instance-lifecycle.js";
import {
	InstanceAlreadyExistsError,
	InstanceCreationError,
	InstanceManager,
	InstanceNotFoundError,
	InstanceResetError,
} from "../../src/kernel/instance-manager.js";
import type { InstanceTemplate } from "../../src/kernel/instance-template.js";
import { MutationAbortedError, MutationTimeoutError } from "../../src/kernel/mutation-scope.js";
import {
	InstanceRuntimeClosedError,
	InstanceRuntimeCloseTimeoutError,
} from "../../src/kernel/persisted-instance-runtime.js";
import type { RuntimeTime } from "../../src/kernel/runtime-time.js";
import {
	ServiceIdentityConflictError,
	type ServiceLifecycleHooks,
	ServiceStateDowngradeError,
} from "../../src/kernel/service-lifecycle.js";
import {
	type ScheduledTask,
	type TaskScheduler,
	TaskTrackerClosedError,
} from "../../src/kernel/task-tracker.js";
import { NodeInstanceStorage } from "../../src/node/instance-storage.js";
import { nodeMonotonicClock } from "../../src/node/monotonic-clock.js";
import { nodeTaskScheduler } from "../../src/node/task-scheduler.js";

const temporaryDirectories: string[] = [];
const fixedTime: RuntimeTime = Object.freeze({
	nowMilliseconds: () => Date.parse("2026-08-25T12:00:00.000Z"),
	nowTimestamp: () => "2026-08-25T12:00:00.000Z",
});

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("InstanceManager with durable Node storage", () => {
	it("persists two independent plugin states across a kernel restart", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "first", persistence: "persistent", seed: false });
		await fixture.manager.create({ id: "second", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });

		const restarted = await managerFixture(instanceTemplate(), fixture.directory);
		await restarted.manager.startPersisted();

		expect((await restarted.manager.list()).map(({ id }) => id)).toEqual(["first", "second"]);
		expect(await runningValue(restarted.manager, "first")).toBe("first:1");
		expect(await runningValue(restarted.manager, "second")).toBe("second:1");
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("retains storage owned by a service removed from configuration", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });

		const restarted = await managerFixture(emptyTemplate(), fixture.directory);
		await restarted.manager.startPersisted();

		expect((await restarted.manager.get("dev")).services).toEqual([]);
		expect(await readStateFile(fixture.directory, "dev")).toEqual({ value: "dev:1" });
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("updates persisted service state before start and records the new version", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const updates: string[] = [];
		const restarted = await managerFixture(
			instanceTemplate({ stateVersion: 2, updateCalls: updates }),
			fixture.directory,
		);

		await restarted.manager.startPersisted();

		expect(updates).toEqual(["dev:1->2"]);
		expect(
			await restarted.storage.readService(parseInstanceId("dev"), parseServiceKey("fixture")),
		).toMatchObject({ stateVersion: 2 });
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it.each([
		["plugin identity conflict", { pluginId: "replacement" }, ServiceIdentityConflictError],
		["stored state downgrade", { stateVersion: 0 }, ServiceStateDowngradeError],
	] as const)(
		"rejects a persisted %s without mutating its service manifest",
		async (_name, change, error) => {
			const fixture = await managerFixture(instanceTemplate());
			await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
			await fixture.manager.stopAll({ timeoutMs: 1_000 });
			const restarted = await managerFixture(instanceTemplate(change), fixture.directory);

			const failure = await restarted.manager.startPersisted().catch((cause: unknown) => cause);

			expect(collectErrors(failure).some((cause) => cause instanceof error)).toBe(true);
			const stored = await restarted.storage.readService(
				parseInstanceId("dev"),
				parseServiceKey("fixture"),
			);
			expect(stored).toMatchObject({ pluginId: "fixture", stateVersion: 1 });
		},
	);

	it("rolls a failed replacement back to the old files and running generation", async () => {
		const creates = new Map<string, number>();
		const fixture = await managerFixture(
			instanceTemplate({
				beforeCreate(instanceId) {
					const attempt = (creates.get(instanceId) ?? 0) + 1;
					creates.set(instanceId, attempt);
					if (attempt === 2) throw new Error("replacement create failed");
				},
			}),
		);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });

		await expect(
			fixture.manager.reset("dev", { seed: false, timeoutMs: 1_000 }),
		).rejects.toBeInstanceOf(InstanceResetError);

		expect(await runningValue(fixture.manager, "dev")).toBe("dev:1");
		expect(await readStateFile(fixture.directory, "dev")).toEqual({ value: "dev:1" });
		expect(await fixture.manager.get("dev")).toMatchObject({ status: "running" });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("enforces explicit seed exactly once until a successful reset", async () => {
		const seedCalls: string[] = [];
		const fixture = await managerFixture(
			instanceTemplate({ configuredSeed: "fixture-seed", seedCalls }),
		);
		const created = await fixture.manager.create({
			id: "dev",
			persistence: "persistent",
			seed: true,
		});

		expect(created.seedStatus).toBe("seeded");
		await expect(fixture.manager.seed("dev", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
			SeedNotAllowedError,
		);
		await fixture.manager.reset("dev", { seed: false, timeoutMs: 1_000 });
		await fixture.manager.seed("dev", { timeoutMs: 1_000 });

		expect(seedCalls).toEqual(["dev:fixture-seed", "dev:fixture-seed"]);
		expect((await fixture.manager.get("dev")).seedStatus).toBe("seeded");
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("removes a newly created instance atomically when its seed fails", async () => {
		const fixture = await managerFixture(
			instanceTemplate({ configuredSeed: "bad", seedFailure: new Error("seed failed") }),
		);

		await expect(
			fixture.manager.create({ id: "failed", persistence: "persistent", seed: true }),
		).rejects.toBeInstanceOf(InstanceCreationError);

		await expect(fixture.manager.get("failed")).rejects.toBeInstanceOf(InstanceNotFoundError);
		expect(await fixture.storage.readInstance(parseInstanceId("failed"))).toBeUndefined();
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("repairs an interrupted seed as a non-repeatable failure on restart", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const instanceId = parseInstanceId("dev");
		const manifest = await fixture.storage.readInstance(instanceId);
		if (!manifest) throw new Error("Expected fixture instance manifest.");
		await fixture.storage.writeInstance(instanceId, {
			...manifest,
			seed: { attempt: 1, status: "seeding" },
		});
		const restarted = await managerFixture(instanceTemplate(), fixture.directory);

		await restarted.manager.startPersisted();

		expect(await restarted.manager.get("dev")).toMatchObject({
			seedStatus: "seed_failed",
			status: "seed_failed",
		});
		await expect(restarted.manager.seed("dev", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
			SeedNotAllowedError,
		);
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("destroys by staging validated storage and then closes idempotently", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "doomed", persistence: "persistent", seed: false });

		await fixture.manager.destroy("doomed", { timeoutMs: 1_000 });

		await expect(fixture.manager.get("doomed")).rejects.toBeInstanceOf(InstanceNotFoundError);
		expect(await fixture.storage.readInstance(parseInstanceId("doomed"))).toBeUndefined();
		const firstClose = fixture.manager.stopAll({ timeoutMs: 1_000 });
		const repeatedClose = fixture.manager.stopAll({ timeoutMs: 1_000 });
		expect(repeatedClose).toBe(firstClose);
		await firstClose;
		await expect(fixture.manager.acquireShared("doomed")).rejects.toBeInstanceOf(
			InstanceRuntimeClosedError,
		);
	});

	it("keeps persisted startup idempotent and exposes read-only registry views", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const restarted = await managerFixture(instanceTemplate(), fixture.directory);

		const firstStart = restarted.manager.startPersisted();
		const repeatedStart = restarted.manager.startPersisted();
		expect(repeatedStart).toBe(firstStart);
		await firstStart;
		const lease = await restarted.manager.acquireShared("dev");
		lease.release();
		expect(restarted.manager.logs("dev")).toEqual({ droppedEntries: 0, entries: [] });
		expect(() => restarted.manager.service("dev", "missing")).toThrow(
			'Service "missing" is not configured',
		);
		expect((await restarted.manager.list()).map(({ id }) => id)).toEqual(["dev"]);
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("rejects create when durable storage already owns the requested ID", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const restarted = await managerFixture(instanceTemplate(), fixture.directory);

		await expect(
			restarted.manager.create({ id: "dev", persistence: "persistent", seed: false }),
		).rejects.toBeInstanceOf(InstanceAlreadyExistsError);
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("reserves concurrent creates and validates destroy IDs before storage dispatch", async () => {
		const fixture = await managerFixture(instanceTemplate());
		const results = await Promise.allSettled([
			fixture.manager.create({ id: "same", persistence: "persistent", seed: false }),
			fixture.manager.create({ id: "same", persistence: "persistent", seed: false }),
		]);

		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(({ status }) => status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
			InstanceAlreadyExistsError,
		);
		const stage = vi.spyOn(fixture.storage, "stageInstance");
		await expect(fixture.manager.destroy("../same", { timeoutMs: 1_000 })).rejects.toThrow(
			"Invalid instance identifier",
		);
		expect(stage).not.toHaveBeenCalled();
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("retires a reset generation and gives the replacement fresh runtime capabilities", async () => {
		const stoppedContexts: RunningPluginContext<unknown, unknown>[] = [];
		const fixture = await managerFixture(instanceTemplate({ stoppedContexts }));
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		const previous = fixture.manager.service("dev", "fixture").runningContext();

		await fixture.manager.reset("dev", { seed: false, timeoutMs: 1_000 });

		const replacement = fixture.manager.service("dev", "fixture").runningContext();
		expect(stoppedContexts).toHaveLength(1);
		expect(stoppedContexts[0]?.signal.aborted).toBe(true);
		expect(previous.signal.aborted).toBe(true);
		expect(() => previous.tasks.track("late old-generation work", Promise.resolve())).toThrow(
			TaskTrackerClosedError,
		);
		expect(replacement.signal.aborted).toBe(false);
		await expect(
			replacement.tasks.track("replacement work", Promise.resolve("completed")),
		).resolves.toBe("completed");
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("shutdown lets an admitted create finish within its grace period", async () => {
		const createEntered = deferred<BasePluginContext<unknown>>();
		const releaseCreate = deferred<void>();
		const fixture = await managerFixture(
			instanceTemplate({
				createBarrier: async (context) => {
					createEntered.resolve(context);
					await releaseCreate.promise;
				},
			}),
		);
		const creating = fixture.manager.create({
			id: "delayed",
			persistence: "persistent",
			seed: false,
		});
		const createContext = await createEntered.promise;

		const stopping = fixture.manager.stopAll({ timeoutMs: 1_000 });

		expect(createContext.signal.aborted).toBe(false);
		await expect(
			fixture.manager.create({ id: "too-late", persistence: "persistent", seed: false }),
		).rejects.toBeInstanceOf(InstanceRuntimeClosedError);
		releaseCreate.resolve(undefined);
		await expect(creating).resolves.toMatchObject({ id: "delayed", status: "running" });
		await expect(stopping).resolves.toBeUndefined();
		expect(createContext.signal.aborted).toBe(true);
		expect(await fixture.storage.readInstance(parseInstanceId("delayed"))).toMatchObject({
			status: "ready",
		});
	});

	it("starts the create deadline before storage initialization", async () => {
		const time = new ManualTime();
		const initialization = deferred<void>();
		const fixture = await managerFixture(instanceTemplate(), undefined, {
			monotonicClock: time,
			scheduler: time,
		});
		vi.spyOn(fixture.storage, "initialize").mockImplementationOnce(() => initialization.promise);
		const creating = fixture.manager.create({
			id: "delayed",
			persistence: "persistent",
			seed: false,
			timeoutMs: 10,
		});

		time.advance(10);

		await expect(creating).rejects.toBeInstanceOf(MutationTimeoutError);
		const stopping = fixture.manager.stopAll({ timeoutMs: 1_000 });
		let stopped = false;
		void stopping.then(
			() => {
				stopped = true;
			},
			() => {
				stopped = true;
			},
		);
		await Promise.resolve();
		expect(stopped).toBe(false);
		initialization.resolve(undefined);
		await stopping;
		expect(await fixture.storage.readInstance(parseInstanceId("delayed"))).toBeUndefined();
	});

	it("reports a blocked create deadline but retains ownership until quarantine settles", async () => {
		const time = new ManualTime();
		const createEntered = deferred<BasePluginContext<unknown>>();
		const releaseCreate = deferred<void>();
		const fixture = await managerFixture(
			instanceTemplate({
				createBarrier: async (context) => {
					createEntered.resolve(context);
					await releaseCreate.promise;
				},
			}),
			undefined,
			{ monotonicClock: time, scheduler: time },
		);
		const creating = fixture.manager.create({
			id: "blocked",
			persistence: "persistent",
			seed: false,
			timeoutMs: 10,
		});
		const context = await createEntered.promise;

		time.advance(10);

		await expect(creating).rejects.toBeInstanceOf(MutationTimeoutError);
		expect(context.signal.aborted).toBe(true);
		const stopping = fixture.manager.stopAll({ timeoutMs: 1_000 });
		const didStop = settlementProbe(stopping);
		await Promise.resolve();
		expect(didStop()).toBe(false);
		await expect(
			fixture.manager.create({ id: "blocked", persistence: "persistent", seed: false }),
		).rejects.toBeInstanceOf(InstanceRuntimeClosedError);

		releaseCreate.resolve(undefined);
		await stopping;
		expect(await fixture.storage.readInstance(parseInstanceId("blocked"))).toBeUndefined();
	});

	it("shutdown drains an admitted persisted startup without publishing a partial instance", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const startEntered = deferred<BasePluginContext<unknown>>();
		const releaseStart = deferred<void>();
		const restarting = await managerFixture(
			instanceTemplate({
				startBarrier: async (context) => {
					startEntered.resolve(context);
					await releaseStart.promise;
				},
			}),
			fixture.directory,
		);
		const starting = restarting.manager.startPersisted();
		const startContext = await startEntered.promise;

		const stopping = restarting.manager.stopAll({ timeoutMs: 1_000 });

		expect(startContext.signal.aborted).toBe(false);
		releaseStart.resolve(undefined);
		await expect(starting).resolves.toBeUndefined();
		await expect(stopping).resolves.toBeUndefined();
		expect(startContext.signal.aborted).toBe(true);
		expect(await restarting.storage.readInstance(parseInstanceId("dev"))).toMatchObject({
			status: "ready",
		});

		const recovered = await managerFixture(instanceTemplate(), fixture.directory);
		await recovered.manager.startPersisted();
		expect(await recovered.manager.get("dev")).toMatchObject({ status: "running" });
		await recovered.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("retains a non-cooperative persisted start after its caller deadline", async () => {
		const fixture = await managerFixture(instanceTemplate());
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
		const time = new ManualTime();
		const startEntered = deferred<BasePluginContext<unknown>>();
		const releaseStart = deferred<void>();
		const restarting = await managerFixture(
			instanceTemplate({
				startBarrier: async (context) => {
					startEntered.resolve(context);
					await releaseStart.promise;
				},
			}),
			fixture.directory,
			{ monotonicClock: time, scheduler: time },
		);
		const starting = restarting.manager.startPersisted();
		const context = await startEntered.promise;

		time.advance(30_000);

		await expect(starting).rejects.toBeInstanceOf(MutationTimeoutError);
		expect(context.signal.aborted).toBe(true);
		const stopping = restarting.manager.stopAll({ timeoutMs: 1_000 });
		const didStop = settlementProbe(stopping);
		await Promise.resolve();
		expect(didStop()).toBe(false);
		releaseStart.resolve(undefined);
		await stopping;

		const recovered = await managerFixture(instanceTemplate(), fixture.directory);
		await recovered.manager.startPersisted();
		expect(await recovered.manager.get("dev")).toMatchObject({ status: "running" });
		await recovered.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("persists a deterministic seed failure when cancellation reaches its hook", async () => {
		const seedEntered = deferred<RunningPluginContext<unknown, unknown>>();
		const fixture = await managerFixture(
			instanceTemplate({
				configuredSeed: "fixture-seed",
				seedBarrier: async (context) => {
					seedEntered.resolve(context);
					throw await abortReason(context.signal);
				},
			}),
		);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		const cancellation = new AbortController();
		const seeding = fixture.manager.seed("dev", {
			signal: cancellation.signal,
			timeoutMs: 1_000,
		});
		const seedContext = await seedEntered.promise;

		cancellation.abort(new Error("seed request disconnected"));

		await expect(seeding).rejects.toBeInstanceOf(MutationAbortedError);
		const ownership = await fixture.manager.acquireShared("dev");
		ownership.release();
		expect(seedContext.signal.aborted).toBe(true);
		expect(await fixture.manager.get("dev")).toMatchObject({
			seedStatus: "seed_failed",
			status: "seed_failed",
		});
		await fixture.manager.stopAll({ timeoutMs: 1_000 });

		const restarted = await managerFixture(instanceTemplate(), fixture.directory);
		await restarted.manager.startPersisted();
		expect(await restarted.manager.get("dev")).toMatchObject({
			seedStatus: "seed_failed",
			status: "seed_failed",
		});
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("uses the mutation deadline inside an admitted seed hook", async () => {
		const time = new ManualTime();
		const seedEntered = deferred<RunningPluginContext<unknown, unknown>>();
		const fixture = await managerFixture(
			instanceTemplate({
				configuredSeed: "fixture-seed",
				seedBarrier: async (context) => {
					seedEntered.resolve(context);
					throw await abortReason(context.signal);
				},
			}),
			undefined,
			{ monotonicClock: time, scheduler: time },
		);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		const seeding = fixture.manager.seed("dev", { timeoutMs: 10 });
		const seedContext = await seedEntered.promise;

		time.advance(10);

		await expect(seeding).rejects.toBeInstanceOf(MutationTimeoutError);
		const ownership = await fixture.manager.acquireShared("dev");
		ownership.release();
		expect(seedContext.signal.aborted).toBe(true);
		expect(await fixture.manager.get("dev")).toMatchObject({
			seedStatus: "seed_failed",
			status: "seed_failed",
		});
		await fixture.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("retains a non-cooperative seed until its terminal state is durable", async () => {
		const time = new ManualTime();
		const seedEntered = deferred<RunningPluginContext<unknown, unknown>>();
		const releaseSeed = deferred<void>();
		const fixture = await managerFixture(
			instanceTemplate({
				configuredSeed: "fixture-seed",
				seedBarrier: async (context) => {
					seedEntered.resolve(context);
					await releaseSeed.promise;
				},
			}),
			undefined,
			{ monotonicClock: time, scheduler: time },
		);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		const seeding = fixture.manager.seed("dev", { timeoutMs: 10 });
		const context = await seedEntered.promise;

		time.advance(10);

		await expect(seeding).rejects.toBeInstanceOf(MutationTimeoutError);
		expect(context.signal.aborted).toBe(true);
		const stopping = fixture.manager.stopAll({ timeoutMs: 1_000 });
		const didStop = settlementProbe(stopping);
		await Promise.resolve();
		expect(didStop()).toBe(false);
		releaseSeed.resolve(undefined);
		await stopping;

		const restarted = await managerFixture(instanceTemplate(), fixture.directory);
		await restarted.manager.startPersisted();
		expect(await restarted.manager.get("dev")).toMatchObject({ seedStatus: "seed_failed" });
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it.each(["reset", "destroy"] as const)(
		"does not reuse storage while a non-cooperative %s stop hook is late",
		async (operation) => {
			const time = new ManualTime();
			const stopEntered = deferred<RunningPluginContext<unknown, unknown>>();
			const releaseStop = deferred<void>();
			let blockFirstStop = true;
			const fixture = await managerFixture(
				instanceTemplate({
					stopBarrier: async (context) => {
						if (!blockFirstStop) return;
						blockFirstStop = false;
						stopEntered.resolve(context);
						await releaseStop.promise;
					},
				}),
				undefined,
				{ monotonicClock: time, scheduler: time },
			);
			await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
			const stage = vi.spyOn(fixture.storage, "stageInstance");
			const mutation = fixture.manager[operation](
				"dev",
				operation === "reset" ? { seed: false, timeoutMs: 10 } : { timeoutMs: 10 },
			);
			const context = await stopEntered.promise;

			time.advance(10);

			await expect(mutation).rejects.toBeInstanceOf(MutationTimeoutError);
			expect(context.signal.aborted).toBe(true);
			const stopping = fixture.manager.stopAll({ timeoutMs: 1_000 });
			const didStop = settlementProbe(stopping);
			await Promise.resolve();
			expect(didStop()).toBe(false);
			expect(stage).not.toHaveBeenCalled();
			releaseStop.resolve(undefined);
			await stopping;
			expect(stage).not.toHaveBeenCalled();

			const restarted = await managerFixture(instanceTemplate(), fixture.directory);
			await restarted.manager.startPersisted();
			expect(await restarted.manager.get("dev")).toMatchObject({ status: "running" });
			await restarted.manager.stopAll({ timeoutMs: 1_000 });
		},
	);

	it("keeps shutdown ownership after a non-cooperative stop exceeds its report deadline", async () => {
		const time = new ManualTime();
		const stopEntered = deferred<RunningPluginContext<unknown, unknown>>();
		const releaseStop = deferred<void>();
		const fixture = await managerFixture(
			instanceTemplate({
				stopBarrier: async (context) => {
					stopEntered.resolve(context);
					await releaseStop.promise;
				},
			}),
			undefined,
			{ monotonicClock: time, scheduler: time },
		);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		const stopping = fixture.manager.stopAll({ timeoutMs: 10 });
		const context = await stopEntered.promise;

		time.advance(10);

		await expect(stopping).rejects.toBeInstanceOf(InstanceRuntimeCloseTimeoutError);
		expect(fixture.manager.stopAll({ timeoutMs: 10 })).toBe(stopping);
		expect(context.signal.aborted).toBe(true);
		expect(() => context.tasks.track("while stop is owned", Promise.resolve())).not.toThrow();
		releaseStop.resolve(undefined);
		await vi.waitFor(() => {
			expect(() => context.tasks.track("after stop settled", Promise.resolve())).toThrow(
				TaskTrackerClosedError,
			);
		});
	});

	it.each(["reset", "destroy"] as const)(
		"restores a fresh generation when caller cancellation interrupts %s stop",
		async (operation) => {
			const stopEntered = deferred<RunningPluginContext<unknown, unknown>>();
			let interruptFirstStop = true;
			const fixture = await managerFixture(
				instanceTemplate({
					stopBarrier: async (context) => {
						if (!interruptFirstStop) return;
						interruptFirstStop = false;
						stopEntered.resolve(context);
						throw await abortReason(context.signal);
					},
				}),
			);
			await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
			const previous = fixture.manager.service("dev", "fixture").runningContext();
			const cancellation = new AbortController();
			const mutation = fixture.manager[operation](
				"dev",
				operation === "reset"
					? { seed: false, signal: cancellation.signal, timeoutMs: 1_000 }
					: { signal: cancellation.signal, timeoutMs: 1_000 },
			);
			const stopped = await stopEntered.promise;

			cancellation.abort(new Error(`${operation} request disconnected`));

			await expect(mutation).rejects.toBeInstanceOf(MutationAbortedError);
			expect(stopped.signal.aborted).toBe(true);
			expect(previous.signal.aborted).toBe(true);
			await fixture.manager.stopAll({ timeoutMs: 1_000 });
			const restarted = await managerFixture(instanceTemplate(), fixture.directory);
			await restarted.manager.startPersisted();
			const restored = restarted.manager.service("dev", "fixture").runningContext();
			expect(restored.signal.aborted).toBe(false);
			expect(await restarted.manager.get("dev")).toMatchObject({ status: "running" });
			expect(await restarted.storage.readInstance(parseInstanceId("dev"))).toMatchObject({
				status: "ready",
			});
			await restarted.manager.stopAll({ timeoutMs: 1_000 });
		},
	);
});

interface TemplateOptions {
	readonly beforeCreate?: (instanceId: string) => void;
	readonly configuredSeed?: string;
	readonly createBarrier?: (context: BasePluginContext<unknown>) => Promise<void>;
	readonly pluginId?: string;
	readonly seedBarrier?: (context: RunningPluginContext<unknown, unknown>) => Promise<void>;
	readonly seedCalls?: string[];
	readonly seedFailure?: Error;
	readonly startBarrier?: (context: BasePluginContext<unknown>) => Promise<void>;
	readonly stateVersion?: number;
	readonly stopBarrier?: (context: RunningPluginContext<unknown, unknown>) => Promise<void>;
	readonly stoppedContexts?: RunningPluginContext<unknown, unknown>[];
	readonly updateCalls?: string[];
}

function instanceTemplate(options: TemplateOptions = {}): InstanceTemplate {
	const createAttempts = new Map<string, number>();
	const hooks: ServiceLifecycleHooks<unknown, unknown, unknown> = Object.freeze({
		create: async (context: BasePluginContext<unknown>) => {
			options.beforeCreate?.(context.instanceId);
			await options.createBarrier?.(context);
			const attempt = (createAttempts.get(context.instanceId) ?? 0) + 1;
			createAttempts.set(context.instanceId, attempt);
			await writeFile(
				context.storage.path("state.json"),
				JSON.stringify({ value: `${context.instanceId}:${attempt}` }),
			);
		},
		seed: async (context: RunningPluginContext<unknown, unknown>, value: unknown) => {
			if (options.seedFailure) throw options.seedFailure;
			await options.seedBarrier?.(context);
			options.seedCalls?.push(`${context.instanceId}:${String(value)}`);
		},
		start: async (context: BasePluginContext<unknown>) => {
			await options.startBarrier?.(context);
			return JSON.parse(await readFile(context.storage.path("state.json"), "utf8"));
		},
		stop: async (context) => {
			await options.stopBarrier?.(context);
			options.stoppedContexts?.push(context);
		},
		update: (context, version) => {
			options.updateCalls?.push(`${context.instanceId}:${version.from}->${version.to}`);
		},
	});
	return Object.freeze({
		clock: Object.freeze({ mode: "real" }),
		fingerprint: `sha256:${(options.pluginId === "replacement" ? "b" : "a").repeat(64)}`,
		services: Object.freeze([
			Object.freeze({
				config: Object.freeze({}),
				...(options.configuredSeed === undefined ? {} : { configuredSeed: options.configuredSeed }),
				hooks,
				pluginId: options.pluginId ?? "fixture",
				serviceKey: "fixture",
				stateVersion: options.stateVersion ?? 1,
			}),
		]),
	});
}

function emptyTemplate(): InstanceTemplate {
	return Object.freeze({
		clock: Object.freeze({ mode: "real" }),
		fingerprint: `sha256:${"c".repeat(64)}`,
		services: Object.freeze([]),
	});
}

async function managerFixture(
	template: InstanceTemplate,
	existingDirectory?: string,
	coordination: Readonly<{
		monotonicClock?: MonotonicClock;
		scheduler?: TaskScheduler;
	}> = {},
): Promise<
	Readonly<{ directory: string; manager: InstanceManager; storage: NodeInstanceStorage }>
> {
	const directory = existingDirectory ?? (await mkdtemp(join(tmpdir(), "localhost2137-manager-")));
	if (!existingDirectory) temporaryDirectories.push(directory);
	const storage = new NodeInstanceStorage(directory, { recoveryToken: () => "token00000001" });
	let sequence = 0;
	const manager = new InstanceManager(template, {
		correlationId: () => `correlation-${++sequence}`,
		fetch: async () => new Response(null, { status: 204 }),
		logLimits: { maxBytes: 100_000, maxEntries: 100 },
		monotonicClock: coordination.monotonicClock ?? nodeMonotonicClock,
		scheduler: coordination.scheduler ?? nodeTaskScheduler,
		storage,
		time: fixedTime,
		token: () => `token${String(++sequence).padStart(8, "0")}`,
	});
	return Object.freeze({ directory, manager, storage });
}

function runningValue(manager: InstanceManager, instanceId: string): string {
	const state = manager.service(instanceId, "fixture").runningContext().state;
	if (!isRecord(state) || typeof state.value !== "string")
		throw new Error("Invalid fixture state.");
	return state.value;
}

async function readStateFile(directory: string, instanceId: string): Promise<unknown> {
	return JSON.parse(
		await readFile(
			join(directory, "instances", instanceId, "services", "fixture", "data", "state.json"),
			"utf8",
		),
	);
}

function collectErrors(cause: unknown): readonly unknown[] {
	if (!(cause instanceof AggregateError)) return [cause];
	return [cause, ...cause.errors.flatMap(collectErrors)];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function abortReason(signal: AbortSignal): Promise<unknown> {
	if (signal.aborted) return Promise.resolve(signal.reason);
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
	});
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

function settlementProbe(promise: Promise<unknown>): () => boolean {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return () => settled;
}

class ManualTime implements MonotonicClock, TaskScheduler {
	readonly #scheduled = new Set<{
		readonly callback: () => void;
		readonly deadline: number;
	}>();
	#now = 0;

	nowMilliseconds(): number {
		return this.#now;
	}

	schedule(delayMs: number, callback: () => void): ScheduledTask {
		const scheduled = { callback, deadline: this.#now + delayMs };
		this.#scheduled.add(scheduled);
		return Object.freeze({ cancel: () => this.#scheduled.delete(scheduled) });
	}

	advance(milliseconds: number): void {
		this.#now += milliseconds;
		while (true) {
			const next = [...this.#scheduled]
				.filter(({ deadline }) => deadline <= this.#now)
				.sort((left, right) => left.deadline - right.deadline)[0];
			if (!next) return;
			this.#scheduled.delete(next);
			next.callback();
		}
	}
}
