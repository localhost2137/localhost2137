import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInstanceId, parseServiceKey } from "../../src/kernel/identifiers.js";
import { StorageWriteCommittedError } from "../../src/kernel/instance-storage.js";
import type {
	InstanceManifest,
	ServiceManifest,
	StorageTransitionManifest,
} from "../../src/kernel/manifests.js";
import { NodeInstanceStorage } from "../../src/node/instance-storage.js";
import { NodeManifestStore } from "../../src/node/manifest-store.js";

const temporaryDirectories: string[] = [];
const serviceKey = parseServiceKey("slack");

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("NodeInstanceStorage", () => {
	it("persists isolated instance, service, and plugin-owned data", async () => {
		const storage = await fixtureStorage();
		const first = parseInstanceId("first");
		const second = parseInstanceId("second");
		await storage.createInstance(first, instanceManifest("first"));
		await storage.createInstance(second, instanceManifest("second"));
		for (const id of [first, second]) {
			await storage.prepareService(id, serviceKey);
			await storage.writeService(id, serviceKey, serviceManifest(id.value));
			await writeFile(storage.pluginStorage(id, serviceKey).path("state.txt"), id.value);
		}

		expect((await storage.listInstances()).map(({ id }) => id)).toEqual(["first", "second"]);
		expect(await storage.readService(first, serviceKey)).toMatchObject({
			pluginId: "slack",
			serviceKey: "slack",
		});
		expect(await readFile(storage.pluginStorage(first, serviceKey).path("state.txt"), "utf8")).toBe(
			"first",
		);
		expect(
			await readFile(storage.pluginStorage(second, serviceKey).path("state.txt"), "utf8"),
		).toBe("second");
	});

	it.each([
		["creating", "persistent", "incomplete_recovery"],
		["ready", "ephemeral", "ephemeral_recovery"],
	] as const)(
		"quarantines %s %s instances left by a crashed runtime",
		async (status, persistence, reason) => {
			const directory = await temporaryDirectory();
			const storage = new NodeInstanceStorage(directory, {
				now: () => new Date("2026-08-25T12:30:00.000Z"),
				recoveryToken: () => "token12345",
			});
			await storage.initialize();
			const instanceId = parseInstanceId("crashed");
			await storage.createInstance(
				instanceId,
				instanceManifest("crashed", { persistence, status }),
			);

			const report = await storage.recover();
			expect(report.quarantinedInstanceIds).toEqual(["crashed"]);
			expect(report.cleanupTrashIds).toHaveLength(1);
			expect(await storage.readInstance(instanceId)).toBeUndefined();
			const trashId = report.cleanupTrashIds[0];
			if (!trashId) throw new Error("Expected recovery quarantine id.");
			expect(
				JSON.parse(await readFile(join(directory, "trash", trashId, "quarantine.json"), "utf8")),
			).toEqual({
				createdAt: "2026-08-25T12:30:00.000Z",
				instanceId: "crashed",
				reason,
				schemaVersion: 1,
				trashId,
			});

			const restarted = new NodeInstanceStorage(directory);
			expect(await restarted.recover()).toMatchObject({
				cleanupTrashIds: [trashId],
				unknownTrashEntries: [],
			});
			await restarted.cleanupTrash(trashId);
			expect(await restarted.recover()).toMatchObject({ cleanupTrashIds: [] });
		},
	);

	it("reports unknown trash entries in portable code-unit order", async () => {
		const directory = await temporaryDirectory();
		const storage = new NodeInstanceStorage(directory);
		await storage.initialize();
		await Promise.all([
			mkdir(join(directory, "trash", "z-unknown")),
			mkdir(join(directory, "trash", "A-unknown")),
			mkdir(join(directory, "trash", "ä-unknown")),
			writeFile(join(directory, "trash", "a-file"), "not runtime metadata"),
		]);

		const report = await storage.recover();
		expect(report.unknownTrashEntries).toEqual(["A-unknown", "a-file", "z-unknown", "ä-unknown"]);
		expect(report.cleanupTrashIds).toEqual([]);
	});

	it("rolls back an interrupted reset whose replacement was not ready", async () => {
		const storage = await fixtureStorage();
		const instanceId = parseInstanceId("dev");
		const transition = transitionManifest("reset_rollback_1", "reset");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.prepareService(instanceId, serviceKey);
		await writeFile(storage.pluginStorage(instanceId, serviceKey).path("old.txt"), "preserved");
		await storage.stageInstance(instanceId, transition);
		await storage.createInstance(
			instanceId,
			instanceManifest("dev", {
				status: "creating",
				transition: { id: transition.transitionId, kind: "reset" },
			}),
		);

		const report = await storage.recover();
		expect(report.restoredResetIds).toEqual(["dev"]);
		expect(
			await readFile(storage.pluginStorage(instanceId, serviceKey).path("old.txt"), "utf8"),
		).toBe("preserved");
		expect(await storage.readInstance(instanceId)).toMatchObject({ status: "ready" });
	});

	it("commits an interrupted reset only when replacement readiness is explicit", async () => {
		const storage = await fixtureStorage();
		const instanceId = parseInstanceId("dev");
		const transition = transitionManifest("reset_committed_1", "reset");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.stageInstance(instanceId, transition);
		await storage.createInstance(
			instanceId,
			instanceManifest("dev", {
				configFingerprint: `sha256:${"b".repeat(64)}`,
				transition: { id: transition.transitionId, kind: "reset" },
			}),
		);

		const report = await storage.recover();
		expect(report.cleanupTrashIds).toContain(transition.transitionId);
		expect(await storage.readInstance(instanceId)).toMatchObject({
			configFingerprint: `sha256:${"b".repeat(64)}`,
			status: "ready",
		});
		expect((await storage.readInstance(instanceId))?.transition).toBeUndefined();
	});

	it("cleans a stale committed reset after its active manifest was already finalized", async () => {
		const storage = await fixtureStorage();
		const instanceId = parseInstanceId("dev");
		const transition = transitionManifest("reset_finalized_1", "reset");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.stageInstance(instanceId, transition);
		await storage.createInstance(
			instanceId,
			instanceManifest("dev", {
				configFingerprint: `sha256:${"b".repeat(64)}`,
				transition: { id: transition.transitionId, kind: "reset" },
			}),
		);
		await storage.commitTransition(transition);
		await storage.writeInstance(
			instanceId,
			instanceManifest("dev", { configFingerprint: `sha256:${"c".repeat(64)}` }),
		);

		const report = await storage.recover();
		expect(report.cleanupTrashIds).toContain(transition.transitionId);
		expect(await storage.readInstance(instanceId)).toMatchObject({
			configFingerprint: `sha256:${"c".repeat(64)}`,
			status: "ready",
		});
	});

	it("rejects committed reset trash that conflicts with another active transition", async () => {
		const storage = await fixtureStorage();
		const instanceId = parseInstanceId("dev");
		const transition = transitionManifest("reset_conflict_1", "reset");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.stageInstance(instanceId, transition);
		await storage.createInstance(
			instanceId,
			instanceManifest("dev", {
				transition: { id: "reset_other_123", kind: "reset" },
			}),
		);
		await storage.commitTransition(transition);

		await expect(storage.recover()).rejects.toThrow(
			"committed reset conflicts with active instance metadata",
		);
	});

	it("completes an interrupted destroy without restoring staged state", async () => {
		const storage = await fixtureStorage();
		const instanceId = parseInstanceId("dev");
		const transition = transitionManifest("destroy_stage_1", "destroy");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.stageInstance(instanceId, transition);

		const report = await storage.recover();
		expect(report.cleanupTrashIds).toEqual([transition.transitionId]);
		expect(await storage.readInstance(instanceId)).toBeUndefined();
	});

	it("preserves the intended manifest when a committed write cannot sync its directory", async () => {
		const directory = await temporaryDirectory();
		const failingDirectory = join(directory, "instances", "dev");
		const failure = new Error("directory sync failed");
		const syncFailure = directorySyncFailure(failingDirectory, failure);
		const storage = new NodeInstanceStorage(directory, { manifestStore: syncFailure.manifests });
		await storage.initialize();
		const instanceId = parseInstanceId("dev");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		const intended = instanceManifest("dev", { seed: { attempt: 1, status: "seeded" } });
		syncFailure.enable();

		const write = storage.writeInstance(instanceId, intended);
		await expect(write).rejects.toMatchObject({
			cause: { cause: failure, commitState: "committed" },
			intendedManifest: intended,
			operation: "write_instance",
		});
		await expect(write).rejects.toBeInstanceOf(StorageWriteCommittedError);
		expect(await storage.readInstance(instanceId)).toEqual(intended);
	});

	it("identifies a transition commit whose manifest rename preceded directory-sync failure", async () => {
		const directory = await temporaryDirectory();
		const transition = transitionManifest("reset_commit_uncertain", "reset");
		const failingDirectory = join(directory, "trash", transition.transitionId);
		const failure = new Error("directory sync failed");
		const syncFailure = directorySyncFailure(failingDirectory, failure);
		const storage = new NodeInstanceStorage(directory, { manifestStore: syncFailure.manifests });
		await storage.initialize();
		const instanceId = parseInstanceId("dev");
		await storage.createInstance(instanceId, instanceManifest("dev"));
		await storage.stageInstance(instanceId, transition);
		syncFailure.enable();

		await expect(storage.commitTransition(transition)).rejects.toMatchObject({
			cause: { cause: failure, commitState: "committed" },
			intendedManifest: { ...transition, phase: "committed" },
			operation: "commit_transition",
		});
		expect(
			JSON.parse(
				await readFile(
					join(directory, "trash", transition.transitionId, "transition.json"),
					"utf8",
				),
			),
		).toMatchObject({ phase: "committed" });
	});
});

async function fixtureStorage(): Promise<NodeInstanceStorage> {
	const directory = await temporaryDirectory();
	const storage = new NodeInstanceStorage(directory, { recoveryToken: () => "token12345" });
	await storage.initialize();
	return storage;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-instance-storage-"));
	temporaryDirectories.push(directory);
	return directory;
}

function directorySyncFailure(failingDirectory: string, failure: Error) {
	let enabled = false;
	return {
		enable() {
			enabled = true;
		},
		manifests: new NodeManifestStore({
			fileSystem: {
				async open(path, flags, mode) {
					if (enabled && path === failingDirectory) {
						return {
							close: async () => undefined,
							sync: async () => {
								throw failure;
							},
							writeFile: async () => undefined,
						};
					}
					return open(path, flags, mode);
				},
				rename,
				unlink,
			},
			token: () => "committed-write",
		}),
	};
}

function instanceManifest(id: string, overrides: Partial<InstanceManifest> = {}): InstanceManifest {
	return {
		clock: { mode: "real", offsetMs: 0 },
		configuredServices: ["slack"],
		configFingerprint: `sha256:${"a".repeat(64)}`,
		createdAt: "2026-08-25T12:00:00.000Z",
		id,
		persistence: "persistent",
		schemaVersion: 1,
		seed: { attempt: 0, status: "unseeded" },
		status: "ready",
		...overrides,
	};
}

function serviceManifest(instanceId: string): ServiceManifest {
	return {
		createdAt: "2026-08-25T12:00:00.000Z",
		pluginId: "slack",
		schemaVersion: 1,
		serviceKey: "slack",
		stateVersion: 1,
		updatedAt: `2026-08-25T12:00:0${instanceId.length}.000Z`,
	};
}

function transitionManifest(
	transitionId: string,
	kind: "destroy" | "reset",
): StorageTransitionManifest {
	return {
		createdAt: "2026-08-25T12:00:00.000Z",
		instanceId: "dev",
		kind,
		phase: "old_staged",
		schemaVersion: 1,
		transitionId,
	};
}
