import type { PluginStorage } from "../authoring/context.js";
import type { InstanceId, ServiceKey } from "./identifiers.js";
import type { InstanceManifest, ServiceManifest, StorageTransitionManifest } from "./manifests.js";

export interface StorageRecoveryReport {
	readonly cleanupTrashIds: readonly string[];
	readonly quarantinedInstanceIds: readonly string[];
	readonly restoredResetIds: readonly string[];
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
	quarantineActiveInstance(instanceId: InstanceId, trashId: string): Promise<void>;
	cleanupTrash(trashId: string): Promise<void>;
}
