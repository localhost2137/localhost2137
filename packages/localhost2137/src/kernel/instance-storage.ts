import type { PluginStorage } from "../authoring/context.js";
import type { InstanceId, ServiceKey } from "./identifiers.js";
import type {
	InstanceManifest,
	InstanceQuarantineReason,
	ServiceManifest,
	StorageTransitionManifest,
} from "./manifests.js";

export interface StorageRecoveryReport {
	readonly cleanupTrashIds: readonly string[];
	readonly quarantinedInstanceIds: readonly string[];
	readonly restoredResetIds: readonly string[];
	readonly unknownTrashEntries: readonly string[];
}

export class InstanceStagingError extends Error {
	override readonly cause: unknown;
	readonly staged: boolean;

	constructor(staged: boolean, cause: unknown) {
		super(
			staged ? "Instance was staged but its directory sync failed." : "Instance staging failed.",
		);
		this.name = "InstanceStagingError";
		this.staged = staged;
		this.cause = cause;
	}
}

export type StorageWriteOperation =
	| "commit_transition"
	| "create_instance"
	| "write_instance"
	| "write_service";

export class StorageWriteCommittedError extends Error {
	override readonly cause: unknown;
	readonly intendedManifest: InstanceManifest | ServiceManifest | StorageTransitionManifest;
	readonly operation: StorageWriteOperation;

	constructor(
		operation: StorageWriteOperation,
		intendedManifest: InstanceManifest | ServiceManifest | StorageTransitionManifest,
		cause: unknown,
	) {
		super(`Storage operation ${operation} committed before its durability check failed.`);
		this.name = "StorageWriteCommittedError";
		this.operation = operation;
		this.intendedManifest = intendedManifest;
		this.cause = cause;
	}
}

export interface InstanceStoragePort {
	initialize(): Promise<void>;
	recover(): Promise<StorageRecoveryReport>;
	listInstances(): Promise<readonly InstanceManifest[]>;
	readInstance(instanceId: InstanceId): Promise<InstanceManifest | undefined>;
	createInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void>;
	writeInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void>;
	prepareService(instanceId: InstanceId, serviceKey: ServiceKey): Promise<void>;
	readService(instanceId: InstanceId, serviceKey: ServiceKey): Promise<ServiceManifest | undefined>;
	writeService(
		instanceId: InstanceId,
		serviceKey: ServiceKey,
		manifest: ServiceManifest,
	): Promise<void>;
	pluginStorage(instanceId: InstanceId, serviceKey: ServiceKey): PluginStorage;
	stageInstance(instanceId: InstanceId, transition: StorageTransitionManifest): Promise<void>;
	discardActiveReplacement(instanceId: InstanceId, transitionId: string): Promise<void>;
	restoreStagedInstance(instanceId: InstanceId, transitionId: string): Promise<void>;
	commitTransition(transition: StorageTransitionManifest): Promise<void>;
	quarantineActiveInstance(
		instanceId: InstanceId,
		trashId: string,
		reason?: InstanceQuarantineReason,
	): Promise<void>;
	cleanupTrash(trashId: string): Promise<void>;
}
