import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseInstanceId, parseServiceKey } from "../../src/kernel/identifiers.js";
import type {
	InstanceManifest,
	ServiceManifest,
	StorageTransitionManifest,
} from "../../src/kernel/manifests.js";
import { NodeInstanceStorage } from "../../src/node/instance-storage.js";

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
		["creating", "persistent"],
		["ready", "ephemeral"],
	] as const)(
		"quarantines %s %s instances left by a crashed runtime",
		async (status, persistence) => {
			const storage = await fixtureStorage();
			const instanceId = parseInstanceId("crashed");
			await storage.createInstance(
				instanceId,
				instanceManifest("crashed", { persistence, status }),
			);

			const report = await storage.recover();
			expect(report.quarantinedInstanceIds).toEqual(["crashed"]);
			expect(report.cleanupTrashIds).toHaveLength(1);
			expect(await storage.readInstance(instanceId)).toBeUndefined();
		},
	);

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
});

async function fixtureStorage(): Promise<NodeInstanceStorage> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-instance-storage-"));
	temporaryDirectories.push(directory);
	const storage = new NodeInstanceStorage(directory, { recoveryToken: () => "token12345" });
	await storage.initialize();
	return storage;
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
