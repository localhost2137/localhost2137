import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type InstanceId, parseInstanceId } from "../kernel/identifiers.js";
import type { StorageRecoveryReport } from "../kernel/instance-storage.js";
import type {
	InstanceManifest,
	InstanceQuarantineReason,
	StorageTransitionManifest,
} from "../kernel/manifests.js";
import { QUARANTINE_MANIFEST_FILE } from "./instance-quarantine.js";
import type { NodeManifestStore } from "./manifest-store.js";
import { sortedStorageDirectories, sortedStorageEntries } from "./storage-directory-entries.js";
import {
	instanceDirectory,
	type StoragePaths,
	transitionDirectory,
	validateTransitionId,
} from "./storage-paths.js";

const TRANSITION_MANIFEST_FILE = "transition.json";

export class StorageRecoveryError extends Error {
	readonly instanceId?: string;
	readonly transitionId?: string;

	constructor(
		message: string,
		details: Readonly<{ instanceId?: string; transitionId?: string }> = {},
	) {
		super(message);
		this.name = "StorageRecoveryError";
		if (details.instanceId) this.instanceId = details.instanceId;
		if (details.transitionId) this.transitionId = details.transitionId;
	}
}

export interface StorageRecoveryOperations {
	commitTransition(transition: StorageTransitionManifest): Promise<void>;
	discardActiveReplacement(instanceId: InstanceId, transitionId: string): Promise<void>;
	quarantineActiveInstance(
		instanceId: InstanceId,
		trashId: string,
		reason?: InstanceQuarantineReason,
	): Promise<void>;
	readInstance(instanceId: InstanceId): Promise<InstanceManifest | undefined>;
	restoreStagedInstance(instanceId: InstanceId, transitionId: string): Promise<void>;
	writeInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void>;
}

export interface NodeStorageRecoveryOptions {
	readonly manifests: NodeManifestStore;
	readonly paths: StoragePaths;
	readonly recoveryToken: () => string;
}

export class NodeStorageRecovery {
	readonly #manifests: NodeManifestStore;
	readonly #paths: StoragePaths;
	readonly #recoveryToken: () => string;

	constructor(options: NodeStorageRecoveryOptions) {
		this.#manifests = options.manifests;
		this.#paths = options.paths;
		this.#recoveryToken = options.recoveryToken;
	}

	async recover(operations: StorageRecoveryOperations): Promise<StorageRecoveryReport> {
		const cleanupTrashIds: string[] = [];
		const quarantinedInstanceIds: string[] = [];
		const restoredResetIds: string[] = [];
		const unknownTrashEntries: string[] = [];

		for (const entry of await sortedStorageEntries(this.#paths.trash)) {
			if (entry.name === "locks" && entry.isDirectory()) continue;
			if (!entry.isDirectory()) {
				unknownTrashEntries.push(entry.name);
				continue;
			}
			const entryPath = resolve(this.#paths.trash, entry.name);
			const transitionPath = resolve(entryPath, TRANSITION_MANIFEST_FILE);
			const quarantinePath = resolve(entryPath, QUARANTINE_MANIFEST_FILE);
			const [hasTransition, hasQuarantine] = await Promise.all([
				exists(transitionPath),
				exists(quarantinePath),
			]);
			if (hasTransition && hasQuarantine) {
				throw new StorageRecoveryError(
					`Trash entry "${entry.name}" contains conflicting runtime metadata.`,
					{ transitionId: entry.name },
				);
			}
			if (hasTransition) {
				const transition = await this.#manifests.readTransition(transitionPath);
				if (transition.transitionId !== entry.name) {
					throw new StorageRecoveryError(
						`Transition directory "${entry.name}" contains manifest for "${transition.transitionId}".`,
						{ transitionId: transition.transitionId },
					);
				}
				await recoverTransition(
					this.#paths,
					operations,
					transition,
					cleanupTrashIds,
					restoredResetIds,
				);
				continue;
			}
			if (hasQuarantine) {
				const quarantine = await this.#manifests.readQuarantine(quarantinePath);
				if (quarantine.trashId !== entry.name) {
					throw new StorageRecoveryError(
						`Quarantine directory "${entry.name}" contains manifest for "${quarantine.trashId}".`,
						{ instanceId: quarantine.instanceId, transitionId: quarantine.trashId },
					);
				}
				parseInstanceId(quarantine.instanceId);
				cleanupTrashIds.push(entry.name);
				continue;
			}
			unknownTrashEntries.push(entry.name);
		}

		for (const entry of await sortedStorageDirectories(this.#paths.instances)) {
			const instanceId = parseInstanceId(entry.name);
			const manifest = await readRequiredInstance(operations, instanceId);
			if (manifest.status === "creating" || manifest.persistence === "ephemeral") {
				if (manifest.transition) {
					throw new StorageRecoveryError(
						`Instance "${instanceId.value}" references missing reset transition "${manifest.transition.id}".`,
						{ instanceId: instanceId.value, transitionId: manifest.transition.id },
					);
				}
				const trashId = recoveryTrashId(instanceId.value, this.#recoveryToken());
				const reason = recoveryReason(manifest);
				await operations.quarantineActiveInstance(instanceId, trashId, reason);
				cleanupTrashIds.push(trashId);
				quarantinedInstanceIds.push(instanceId.value);
			} else if (manifest.transition) {
				throw new StorageRecoveryError(
					`Ready instance "${instanceId.value}" references missing reset transition "${manifest.transition.id}".`,
					{ instanceId: instanceId.value, transitionId: manifest.transition.id },
				);
			}
		}

		return Object.freeze({
			cleanupTrashIds: Object.freeze(cleanupTrashIds),
			quarantinedInstanceIds: Object.freeze(quarantinedInstanceIds),
			restoredResetIds: Object.freeze(restoredResetIds),
			unknownTrashEntries: Object.freeze(unknownTrashEntries),
		});
	}
}

async function recoverTransition(
	paths: StoragePaths,
	operations: StorageRecoveryOperations,
	transition: StorageTransitionManifest,
	cleanupTrashIds: string[],
	restoredResetIds: string[],
): Promise<void> {
	const instanceId = parseInstanceId(transition.instanceId);
	const staging = transitionDirectory(paths, transition.transitionId);
	const activePath = instanceDirectory(paths, instanceId);
	const stagedPath = resolve(staging, "instance");
	const [active, staged] = await Promise.all([exists(activePath), exists(stagedPath)]);

	if (transition.kind === "destroy") {
		if (active && staged) {
			throw transitionConflict(transition, "destroy has both active and staged state");
		}
		cleanupTrashIds.push(transition.transitionId);
		return;
	}
	if (transition.phase === "committed") {
		if (!active) {
			throw transitionConflict(transition, "committed reset has no active replacement");
		}
		const activeManifest = await readRequiredInstance(operations, instanceId);
		if (activeManifest.transition?.id === transition.transitionId) {
			await clearRecoveredTransition(operations, instanceId, transition.transitionId);
		} else if (activeManifest.transition || activeManifest.status !== "ready") {
			throw transitionConflict(
				transition,
				"committed reset conflicts with active instance metadata",
			);
		}
		cleanupTrashIds.push(transition.transitionId);
		return;
	}
	if (!staged && active) {
		const activeManifest = await readRequiredInstance(operations, instanceId);
		if (activeManifest.status !== "ready" || activeManifest.transition) {
			throw transitionConflict(
				transition,
				"unstaged reset conflicts with active instance metadata",
			);
		}
		cleanupTrashIds.push(transition.transitionId);
		return;
	}
	if (staged && !active) {
		await operations.restoreStagedInstance(instanceId, transition.transitionId);
		restoredResetIds.push(instanceId.value);
		cleanupTrashIds.push(transition.transitionId);
		return;
	}
	if (!active || !staged) {
		throw transitionConflict(transition, "reset has no recoverable state");
	}

	const activeManifest = await readRequiredInstance(operations, instanceId);
	if (
		activeManifest.status === "ready" &&
		activeManifest.transition?.id === transition.transitionId
	) {
		await operations.commitTransition(transition);
		await clearRecoveredTransition(operations, instanceId, transition.transitionId);
	} else {
		await operations.discardActiveReplacement(instanceId, transition.transitionId);
		await operations.restoreStagedInstance(instanceId, transition.transitionId);
		restoredResetIds.push(instanceId.value);
	}
	cleanupTrashIds.push(transition.transitionId);
}

async function clearRecoveredTransition(
	operations: StorageRecoveryOperations,
	instanceId: InstanceId,
	transitionId: string,
): Promise<void> {
	const manifest = await readRequiredInstance(operations, instanceId);
	if (manifest.transition?.id !== transitionId) {
		throw new StorageRecoveryError(
			`Reset transition "${transitionId}" does not match active instance metadata.`,
			{ instanceId: instanceId.value, transitionId },
		);
	}
	const { transition: _transition, ...ready } = manifest;
	await operations.writeInstance(instanceId, ready);
}

async function readRequiredInstance(
	operations: StorageRecoveryOperations,
	instanceId: InstanceId,
): Promise<InstanceManifest> {
	const manifest = await operations.readInstance(instanceId);
	if (!manifest) {
		throw new StorageRecoveryError(
			`Instance directory "${instanceId.value}" has no instance.json manifest.`,
			{ instanceId: instanceId.value },
		);
	}
	return manifest;
}

function recoveryReason(manifest: InstanceManifest): InstanceQuarantineReason {
	return manifest.persistence === "ephemeral" ? "ephemeral_recovery" : "incomplete_recovery";
}

function recoveryTrashId(instanceId: string, token: string): string {
	const result = `recovery_${instanceId}_${token}`;
	validateTransitionId(result);
	return result;
}

function transitionConflict(
	transition: StorageTransitionManifest,
	reason: string,
): StorageRecoveryError {
	return new StorageRecoveryError(
		`Cannot recover ${transition.kind} transition "${transition.transitionId}": ${reason}.`,
		{ instanceId: transition.instanceId, transitionId: transition.transitionId },
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return false;
		throw cause;
	}
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
