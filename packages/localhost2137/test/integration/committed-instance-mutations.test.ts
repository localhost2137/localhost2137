import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BasePluginContext } from "../../src/authoring/context.js";
import { type InstanceId, parseInstanceId } from "../../src/kernel/identifiers.js";
import { SeedNotAllowedError } from "../../src/kernel/instance-lifecycle.js";
import {
	InstanceManager,
	InstanceMutationCommittedError,
	InstanceNotFoundError,
} from "../../src/kernel/instance-manager.js";
import { StorageWriteCommittedError } from "../../src/kernel/instance-storage.js";
import type { InstanceTemplate } from "../../src/kernel/instance-template.js";
import type { InstanceManifest } from "../../src/kernel/manifests.js";
import type { RuntimeTime } from "../../src/kernel/runtime-time.js";
import type { ServiceLifecycleHooks } from "../../src/kernel/service-lifecycle.js";
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

describe("committed instance mutations", () => {
	it.each(["reset", "destroy"] as const)(
		"finalizes a committed reset before a later %s",
		async (nextMutation) => {
			const fixture = await managerFixture(instanceTemplate());
			await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
			fixture.storage.failNextResetFinalization();

			const failure = await fixture.manager
				.reset("dev", { seed: false, timeoutMs: 1_000 })
				.catch((cause: unknown) => cause);

			expect(failure).toBeInstanceOf(InstanceMutationCommittedError);
			expect(failure).toMatchObject({
				operation: "reset",
				summary: { id: "dev", status: "running" },
			});
			expect(await runningValue(fixture.manager)).toBe("dev:2");
			expect(await fixture.storage.readInstance(instanceId("dev"))).toMatchObject({
				status: "ready",
				transition: { kind: "reset" },
			});

			if (nextMutation === "reset") {
				await expect(
					fixture.manager.reset("dev", { seed: false, timeoutMs: 1_000 }),
				).resolves.toMatchObject({ id: "dev", status: "running" });
				expect(await runningValue(fixture.manager)).toBe("dev:3");
				expect(await fixture.storage.readInstance(instanceId("dev"))).not.toHaveProperty(
					"transition",
				);
			} else {
				await expect(fixture.manager.destroy("dev", { timeoutMs: 1_000 })).resolves.toBeUndefined();
				await expect(fixture.manager.get("dev")).rejects.toBeInstanceOf(InstanceNotFoundError);
				expect(await fixture.storage.readInstance(instanceId("dev"))).toBeUndefined();
			}
			await fixture.manager.stopAll({ timeoutMs: 1_000 });

			const restarted = await managerFixture(instanceTemplate(), fixture.directory);
			await expect(restarted.manager.startPersisted()).resolves.toBeUndefined();
			if (nextMutation === "reset") {
				expect(await runningValue(restarted.manager)).toBe("dev:3");
			} else {
				expect(await restarted.manager.list()).toEqual([]);
			}
			await restarted.manager.stopAll({ timeoutMs: 1_000 });
		},
	);

	it("recovers a committed replacement on restart without restoring the old generation", async () => {
		const template = instanceTemplate();
		const fixture = await managerFixture(template);
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		fixture.storage.failNextResetFinalization();
		await expect(
			fixture.manager.reset("dev", { seed: false, timeoutMs: 1_000 }),
		).rejects.toBeInstanceOf(InstanceMutationCommittedError);
		expect(await runningValue(fixture.manager)).toBe("dev:2");
		await fixture.manager.stopAll({ timeoutMs: 1_000 });

		const restarted = await managerFixture(instanceTemplate(), fixture.directory);
		await restarted.manager.startPersisted();

		expect(await runningValue(restarted.manager)).toBe("dev:2");
		expect(await restarted.storage.readInstance(instanceId("dev"))).not.toHaveProperty(
			"transition",
		);
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});

	it("keeps a committed final seed non-repeatable in memory and on disk", async () => {
		const fixture = await managerFixture(instanceTemplate("fixture-seed"));
		await fixture.manager.create({ id: "dev", persistence: "persistent", seed: false });
		fixture.storage.failNextSeededManifestSync();

		const failure = await fixture.manager
			.seed("dev", { timeoutMs: 1_000 })
			.catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(InstanceMutationCommittedError);
		expect(failure).toMatchObject({ operation: "seed" });
		if (!(failure instanceof InstanceMutationCommittedError)) {
			throw new Error("Expected a committed seed mutation failure.");
		}
		expect(failure.errors).toEqual([expect.any(StorageWriteCommittedError)]);
		expect(await fixture.manager.get("dev")).toMatchObject({
			seedStatus: "seeded",
			status: "running",
		});
		expect(await fixture.storage.readInstance(instanceId("dev"))).toMatchObject({
			seed: { attempt: 1, status: "seeded" },
		});
		await expect(fixture.manager.seed("dev", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
			SeedNotAllowedError,
		);
		await fixture.manager.stopAll({ timeoutMs: 1_000 });

		const restarted = await managerFixture(instanceTemplate("fixture-seed"), fixture.directory);
		await restarted.manager.startPersisted();
		expect(await restarted.manager.get("dev")).toMatchObject({ seedStatus: "seeded" });
		await expect(restarted.manager.seed("dev", { timeoutMs: 1_000 })).rejects.toBeInstanceOf(
			SeedNotAllowedError,
		);
		await restarted.manager.stopAll({ timeoutMs: 1_000 });
	});
});

class FaultInjectingStorage extends NodeInstanceStorage {
	#failResetFinalization = false;
	#failSeededManifestSync = false;

	failNextResetFinalization(): void {
		this.#failResetFinalization = true;
	}

	failNextSeededManifestSync(): void {
		this.#failSeededManifestSync = true;
	}

	override async writeInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void> {
		if (
			this.#failResetFinalization &&
			manifest.status === "ready" &&
			manifest.transition === undefined
		) {
			this.#failResetFinalization = false;
			throw new Error("reset finalization write failed");
		}
		if (this.#failSeededManifestSync && manifest.seed.status === "seeded") {
			this.#failSeededManifestSync = false;
			await super.writeInstance(instanceId, manifest);
			throw new StorageWriteCommittedError(
				"write_instance",
				manifest,
				new Error("seed manifest directory sync failed"),
			);
		}
		await super.writeInstance(instanceId, manifest);
	}
}

function instanceTemplate(configuredSeed?: string): InstanceTemplate {
	const createAttempts = new Map<string, number>();
	const hooks: ServiceLifecycleHooks<unknown, unknown, unknown> = Object.freeze({
		create: async (context: BasePluginContext<unknown>) => {
			const attempt = (createAttempts.get(context.instanceId) ?? 0) + 1;
			createAttempts.set(context.instanceId, attempt);
			await writeFile(
				context.storage.path("state.json"),
				JSON.stringify({ value: `${context.instanceId}:${attempt}` }),
			);
		},
		seed: () => undefined,
		start: async (context: BasePluginContext<unknown>) =>
			JSON.parse(await readFile(context.storage.path("state.json"), "utf8")),
		stop: () => undefined,
	});
	return Object.freeze({
		clock: Object.freeze({ mode: "real" }),
		fingerprint: `sha256:${"d".repeat(64)}`,
		services: Object.freeze([
			Object.freeze({
				config: Object.freeze({}),
				...(configuredSeed === undefined ? {} : { configuredSeed }),
				hooks,
				pluginId: "fixture",
				serviceKey: "fixture",
				stateVersion: 1,
			}),
		]),
	});
}

async function managerFixture(
	template: InstanceTemplate,
	existingDirectory?: string,
): Promise<
	Readonly<{ directory: string; manager: InstanceManager; storage: FaultInjectingStorage }>
> {
	const directory = existingDirectory ?? (await mkdtemp(join(tmpdir(), "localhost2137-commit-")));
	if (!existingDirectory) temporaryDirectories.push(directory);
	const storage = new FaultInjectingStorage(directory, {
		recoveryToken: () => "token00000001",
	});
	let sequence = 0;
	const manager = new InstanceManager(template, {
		correlationId: () => `correlation-${++sequence}`,
		fetch: async () => new Response(null, { status: 204 }),
		logLimits: { maxBytes: 100_000, maxEntries: 100 },
		monotonicClock: nodeMonotonicClock,
		scheduler: nodeTaskScheduler,
		storage,
		time: fixedTime,
		token: () => `token${String(++sequence).padStart(8, "0")}`,
	});
	return Object.freeze({ directory, manager, storage });
}

async function runningValue(manager: InstanceManager): Promise<string> {
	const state = manager.service("dev", "fixture").runningContext().state;
	if (!isRecord(state) || typeof state.value !== "string") {
		throw new Error("Invalid fixture state.");
	}
	return state.value;
}

function instanceId(value: string): InstanceId {
	return parseInstanceId(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
