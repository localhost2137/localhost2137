import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type InstanceId, parseInstanceId, type ServiceKey } from "../kernel/identifiers.js";
import {
	InstanceStagingError,
	type InstanceStoragePort,
	type StorageRecoveryReport,
	StorageWriteCommittedError,
	type StorageWriteOperation,
} from "../kernel/instance-storage.js";
import type {
	InstanceManifest,
	InstanceQuarantineReason,
	ServiceManifest,
	StorageTransitionManifest,
} from "../kernel/manifests.js";
import { AtomicWriteError, syncDirectory } from "./atomic-file.js";
import { quarantineInstance } from "./instance-quarantine.js";
import { NodeManifestStore } from "./manifest-store.js";
import { NodePluginStorage } from "./plugin-storage.js";
import { sortedStorageDirectories } from "./storage-directory-entries.js";
import {
	instanceDirectory,
	type StoragePaths,
	serviceDataDirectory,
	serviceDirectory,
	storagePaths,
	transitionDirectory,
} from "./storage-paths.js";
import { NodeStorageRecovery, StorageRecoveryError } from "./storage-recovery.js";

export interface NodeInstanceStorageOptions {
	readonly manifestStore?: NodeManifestStore;
	readonly now?: () => Date;
	readonly recoveryToken?: () => string;
}

export class NodeInstanceStorage implements InstanceStoragePort {
	readonly #manifests: NodeManifestStore;
	readonly #now: () => Date;
	readonly #paths: StoragePaths;
	readonly #recovery: NodeStorageRecovery;

	constructor(root: string, options: NodeInstanceStorageOptions = {}) {
		this.#paths = storagePaths(root);
		this.#manifests = options.manifestStore ?? new NodeManifestStore();
		this.#now = options.now ?? (() => new Date());
		this.#recovery = new NodeStorageRecovery({
			manifests: this.#manifests,
			paths: this.#paths,
			recoveryToken: options.recoveryToken ?? randomUUID,
		});
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.#paths.instances, { recursive: true }),
			mkdir(this.#paths.trash, { recursive: true }),
		]);
	}

	async recover(): Promise<StorageRecoveryReport> {
		await this.initialize();
		return this.#recovery.recover(this);
	}

	async listInstances(): Promise<readonly InstanceManifest[]> {
		await this.initialize();
		const manifests: InstanceManifest[] = [];
		for (const entry of await sortedStorageDirectories(this.#paths.instances)) {
			const instanceId = parseInstanceId(entry.name);
			manifests.push(await this.#readRequiredInstance(instanceId));
		}
		return Object.freeze(manifests);
	}

	async readInstance(instanceId: InstanceId): Promise<InstanceManifest | undefined> {
		const filePath = resolve(instanceDirectory(this.#paths, instanceId), "instance.json");
		if (!(await exists(filePath))) return undefined;
		const manifest = await this.#manifests.readInstance(filePath);
		if (manifest.id !== instanceId.value) {
			throw new StorageRecoveryError(
				`Instance directory "${instanceId.value}" contains manifest for "${manifest.id}".`,
				{ instanceId: instanceId.value },
			);
		}
		return manifest;
	}

	async createInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void> {
		assertInstanceManifestIdentity(instanceId, manifest);
		const directory = instanceDirectory(this.#paths, instanceId);
		await mkdir(directory);
		let manifestWritten = false;
		try {
			await this.#manifests.writeInstance(resolve(directory, "instance.json"), manifest);
			manifestWritten = true;
			await syncDirectory(this.#paths.instances);
		} catch (cause) {
			if (!manifestWritten && !isCommittedAtomicWrite(cause)) {
				await rm(directory, { force: true, recursive: true }).catch(() => undefined);
				throw cause;
			}
			throw committedStorageWrite("create_instance", manifest, cause);
		}
	}

	async writeInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void> {
		assertInstanceManifestIdentity(instanceId, manifest);
		try {
			await this.#manifests.writeInstance(
				resolve(instanceDirectory(this.#paths, instanceId), "instance.json"),
				manifest,
			);
		} catch (cause) {
			if (isCommittedAtomicWrite(cause)) {
				throw committedStorageWrite("write_instance", manifest, cause);
			}
			throw cause;
		}
	}

	async prepareService(instanceId: InstanceId, serviceKey: ServiceKey): Promise<void> {
		await mkdir(serviceDataDirectory(this.#paths, instanceId, serviceKey), { recursive: true });
	}

	async readService(
		instanceId: InstanceId,
		serviceKey: ServiceKey,
	): Promise<ServiceManifest | undefined> {
		const filePath = resolve(serviceDirectory(this.#paths, instanceId, serviceKey), "service.json");
		if (!(await exists(filePath))) return undefined;
		const manifest = await this.#manifests.readService(filePath);
		if (manifest.serviceKey !== serviceKey.value) {
			throw new StorageRecoveryError(
				`Service directory "${serviceKey.value}" contains manifest for "${manifest.serviceKey}".`,
				{ instanceId: instanceId.value },
			);
		}
		return manifest;
	}

	async writeService(
		instanceId: InstanceId,
		serviceKey: ServiceKey,
		manifest: ServiceManifest,
	): Promise<void> {
		if (manifest.serviceKey !== serviceKey.value) {
			throw new TypeError("Service manifest identity does not match its validated storage path.");
		}
		try {
			await this.#manifests.writeService(
				resolve(serviceDirectory(this.#paths, instanceId, serviceKey), "service.json"),
				manifest,
			);
		} catch (cause) {
			if (isCommittedAtomicWrite(cause)) {
				throw committedStorageWrite("write_service", manifest, cause);
			}
			throw cause;
		}
	}

	pluginStorage(instanceId: InstanceId, serviceKey: ServiceKey): NodePluginStorage {
		return new NodePluginStorage(serviceDataDirectory(this.#paths, instanceId, serviceKey));
	}

	async stageInstance(
		instanceId: InstanceId,
		transition: StorageTransitionManifest,
	): Promise<void> {
		assertTransitionIdentity(instanceId, transition);
		const staging = transitionDirectory(this.#paths, transition.transitionId);
		await mkdir(staging);
		let staged = false;
		try {
			await this.#manifests.writeTransition(resolve(staging, "transition.json"), transition);
			await rename(instanceDirectory(this.#paths, instanceId), resolve(staging, "instance"));
			staged = true;
			await Promise.all([syncDirectory(this.#paths.instances), syncDirectory(this.#paths.trash)]);
		} catch (cause) {
			if (!staged) {
				await rm(staging, { force: true, recursive: true }).catch(() => undefined);
			}
			throw new InstanceStagingError(staged, cause);
		}
	}

	async discardActiveReplacement(instanceId: InstanceId, transitionId: string): Promise<void> {
		const active = instanceDirectory(this.#paths, instanceId);
		if (!(await exists(active))) return;
		await rename(
			active,
			resolve(transitionDirectory(this.#paths, transitionId), "failed-replacement"),
		);
		await syncDirectory(this.#paths.instances);
	}

	async restoreStagedInstance(instanceId: InstanceId, transitionId: string): Promise<void> {
		await rename(
			resolve(transitionDirectory(this.#paths, transitionId), "instance"),
			instanceDirectory(this.#paths, instanceId),
		);
		await syncDirectory(this.#paths.instances);
	}

	async commitTransition(transition: StorageTransitionManifest): Promise<void> {
		const committed = { ...transition, phase: "committed" } as const;
		try {
			await this.#manifests.writeTransition(
				resolve(transitionDirectory(this.#paths, transition.transitionId), "transition.json"),
				committed,
			);
		} catch (cause) {
			if (isCommittedAtomicWrite(cause)) {
				throw committedStorageWrite("commit_transition", committed, cause);
			}
			throw cause;
		}
	}

	async quarantineActiveInstance(
		instanceId: InstanceId,
		trashId: string,
		reason: InstanceQuarantineReason = "failed_creation",
	): Promise<void> {
		await quarantineInstance(
			{ manifests: this.#manifests, now: this.#now, paths: this.#paths },
			instanceId,
			trashId,
			reason,
		);
	}

	async cleanupTrash(trashId: string): Promise<void> {
		await rm(transitionDirectory(this.#paths, trashId), { force: true, recursive: true });
	}

	async #readRequiredInstance(instanceId: InstanceId): Promise<InstanceManifest> {
		const manifest = await this.readInstance(instanceId);
		if (!manifest) {
			throw new StorageRecoveryError(
				`Instance directory "${instanceId.value}" has no instance.json manifest.`,
				{ instanceId: instanceId.value },
			);
		}
		return manifest;
	}
}

function assertInstanceManifestIdentity(instanceId: InstanceId, manifest: InstanceManifest): void {
	if (manifest.id !== instanceId.value) {
		throw new TypeError("Instance manifest identity does not match its validated storage path.");
	}
}

function assertTransitionIdentity(
	instanceId: InstanceId,
	transition: StorageTransitionManifest,
): void {
	if (transition.instanceId !== instanceId.value) {
		throw new TypeError("Transition instance identity does not match its validated storage path.");
	}
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

function isCommittedAtomicWrite(value: unknown): value is AtomicWriteError {
	return value instanceof AtomicWriteError && value.commitState === "committed";
}

function committedStorageWrite(
	operation: StorageWriteOperation,
	manifest: InstanceManifest | ServiceManifest | StorageTransitionManifest,
	cause: unknown,
): StorageWriteCommittedError {
	return new StorageWriteCommittedError(operation, manifest, cause);
}
