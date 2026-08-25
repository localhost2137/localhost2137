import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/config-resolution.js";
import {
	ActiveRuntimeFileStore,
	createRuntimeDescriptor,
} from "../../src/node/active-runtime-file-store.js";
import { inspectProjectRuntime } from "../../src/node/runtime-doctor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("runtime doctor", () => {
	it("reports a missing config and runtime without mutating the project", async () => {
		const project = await temporaryProject();
		const report = await inspectProjectRuntime({ cwd: project });

		expect(report).toMatchObject({
			config: { errorCode: "CONFIG_NOT_FOUND", loaded: false },
			runtime: { state: "absent" },
			status: "issues",
			storage: { instances: [], trashEntries: [] },
		});
		expect(report.issues.map(({ code }) => code)).toEqual(["CONFIG_NOT_FOUND"]);
		await expect(access(join(project, ".localhost2137"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("surfaces orphaned and incompatible service manifests without exposing stored data", async () => {
		const project = await temporaryProject();
		const storage = join(project, ".state");
		const config = resolveConfig(
			{ services: {}, storage: { dir: storage } },
			join(project, "localhost.config.ts"),
		);
		const instanceDirectory = join(storage, "instances", "dev");
		const serviceDirectory = join(instanceDirectory, "services", "removed");
		await mkdir(serviceDirectory, { recursive: true });
		await writeFile(
			join(instanceDirectory, "instance.json"),
			JSON.stringify({
				clock: { mode: "real", offsetMs: 0 },
				configuredServices: ["removed"],
				configFingerprint: config.fingerprint,
				createdAt: "2026-08-26T00:00:00.000Z",
				id: "dev",
				persistence: "persistent",
				schemaVersion: 1,
				seed: { attempt: 0, status: "unseeded" },
				status: "ready",
			}),
		);
		await writeFile(
			join(serviceDirectory, "service.json"),
			JSON.stringify({
				createdAt: "2026-08-26T00:00:00.000Z",
				pluginId: "private-plugin-id",
				schemaVersion: 1,
				serviceKey: "removed",
				stateVersion: 7,
				updatedAt: "2026-08-26T00:00:00.000Z",
			}),
		);
		await writeFile(join(serviceDirectory, "secret-state.txt"), "do-not-read");

		const report = await inspectProjectRuntime(
			{ cwd: project },
			{ loadConfig: async () => config },
		);

		expect(report.storage.instances).toEqual([
			expect.objectContaining({ id: "dev", services: ["removed"] }),
		]);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				code: "ORPHANED_SERVICE",
				instanceId: "dev",
				serviceKey: "removed",
			}),
		);
		expect(JSON.stringify(report)).not.toContain("do-not-read");
		expect(JSON.stringify(report)).not.toContain("private-plugin-id");
	});

	it("contains malformed manifests and continues inspecting other entries", async () => {
		const project = await temporaryProject();
		const storage = join(project, ".state");
		const config = resolveConfig(
			{ services: {}, storage: { dir: storage } },
			join(project, "localhost.config.ts"),
		);
		await mkdir(join(storage, "instances", "broken"), { recursive: true });
		await writeFile(join(storage, "instances", "broken", "instance.json"), "private garbage");

		const report = await inspectProjectRuntime(
			{ cwd: project },
			{ loadConfig: async () => config },
		);

		expect(report.issues).toContainEqual(
			expect.objectContaining({ code: "INSTANCE_MANIFEST_INVALID", instanceId: "broken" }),
		);
		expect(JSON.stringify(report)).not.toContain("private garbage");
	});

	it("distinguishes a stale descriptor without exposing its control token", async () => {
		const project = await temporaryProject();
		const storage = join(project, ".state");
		const config = resolveConfig(
			{ services: {}, storage: { dir: storage } },
			join(project, "localhost.config.ts"),
		);
		const active = new ActiveRuntimeFileStore(storage);
		await active.publish(
			createRuntimeDescriptor({
				configFingerprint: config.fingerprint,
				pid: 2_147_483_647,
				url: "http://127.0.0.1:2137",
			}),
			"private-control-token",
		);

		const report = await inspectProjectRuntime(
			{ cwd: project },
			{ loadConfig: async () => config },
		);

		expect(report.runtime).toEqual({
			errorCode: "RUNTIME_PROCESS_STALE",
			state: "unhealthy",
		});
		expect(report.issues).toContainEqual(
			expect.objectContaining({ code: "RUNTIME_PROCESS_STALE" }),
		);
		expect(JSON.stringify(report)).not.toContain("private-control-token");
	});
});

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-doctor-"));
	temporaryDirectories.push(directory);
	return directory;
}
