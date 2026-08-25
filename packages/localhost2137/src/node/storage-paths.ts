import { isAbsolute, relative, resolve } from "node:path";
import type { InstanceId, ServiceKey } from "../kernel/identifiers.js";

export interface StoragePaths {
	readonly instances: string;
	readonly lock: string;
	readonly root: string;
	readonly trash: string;
}

export function storagePaths(root: string): StoragePaths {
	const absoluteRoot = resolve(root);
	return Object.freeze({
		instances: resolve(absoluteRoot, "instances"),
		lock: resolve(absoluteRoot, "lock"),
		root: absoluteRoot,
		trash: resolve(absoluteRoot, "trash"),
	});
}

export function instanceDirectory(paths: StoragePaths, instanceId: InstanceId): string {
	return resolveBeneath(paths.instances, instanceId.value);
}

export function serviceDirectory(
	paths: StoragePaths,
	instanceId: InstanceId,
	serviceKey: ServiceKey,
): string {
	return resolveBeneath(instanceDirectory(paths, instanceId), "services", serviceKey.value);
}

export function serviceDataDirectory(
	paths: StoragePaths,
	instanceId: InstanceId,
	serviceKey: ServiceKey,
): string {
	return resolveBeneath(serviceDirectory(paths, instanceId, serviceKey), "data");
}

export function transitionDirectory(paths: StoragePaths, transitionId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(transitionId)) {
		throw new TypeError(`Invalid storage transition id ${JSON.stringify(transitionId)}.`);
	}
	return resolveBeneath(paths.trash, transitionId);
}

function resolveBeneath(root: string, ...segments: readonly string[]): string {
	const candidate = resolve(root, ...segments);
	const pathFromRoot = relative(root, candidate);
	if (pathFromRoot === "" || isAbsolute(pathFromRoot) || pathFromRoot.startsWith("..")) {
		throw new TypeError(`Storage path escaped its root: ${candidate}`);
	}
	return candidate;
}
