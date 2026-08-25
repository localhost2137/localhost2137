import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { InstanceId } from "../kernel/identifiers.js";
import { InstanceStagingError } from "../kernel/instance-storage.js";
import type { InstanceQuarantineManifest, InstanceQuarantineReason } from "../kernel/manifests.js";
import { syncDirectory } from "./atomic-file.js";
import type { NodeManifestStore } from "./manifest-store.js";
import { instanceDirectory, type StoragePaths, transitionDirectory } from "./storage-paths.js";

export const QUARANTINE_MANIFEST_FILE = "quarantine.json";

export interface InstanceQuarantineOptions {
	readonly manifests: NodeManifestStore;
	readonly now: () => Date;
	readonly paths: StoragePaths;
}

export async function quarantineInstance(
	options: InstanceQuarantineOptions,
	instanceId: InstanceId,
	trashId: string,
	reason: InstanceQuarantineReason,
): Promise<void> {
	const quarantineDirectory = transitionDirectory(options.paths, trashId);
	const manifest: InstanceQuarantineManifest = {
		createdAt: options.now().toISOString(),
		instanceId: instanceId.value,
		reason,
		schemaVersion: 1,
		trashId,
	};
	await mkdir(quarantineDirectory);
	let staged = false;
	try {
		await options.manifests.writeQuarantine(
			resolve(quarantineDirectory, QUARANTINE_MANIFEST_FILE),
			manifest,
		);
		await rename(
			instanceDirectory(options.paths, instanceId),
			resolve(quarantineDirectory, "instance"),
		);
		staged = true;
		await Promise.all([
			syncDirectory(options.paths.instances),
			syncDirectory(options.paths.trash),
			syncDirectory(quarantineDirectory),
		]);
	} catch (cause) {
		if (!staged) {
			await rm(quarantineDirectory, { force: true, recursive: true }).catch(() => undefined);
		}
		throw new InstanceStagingError(staged, cause);
	}
}
