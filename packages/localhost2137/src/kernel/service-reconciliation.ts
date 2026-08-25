import type {
	AnyServiceLifecycle,
	ServiceReconciliation,
	StoredServiceIdentity,
} from "./service-lifecycle.js";

export interface ServiceReconciliationStore {
	read(serviceKey: string): Promise<StoredServiceIdentity | undefined>;
	write(
		service: Readonly<{ pluginId: string; serviceKey: string }>,
		result: ServiceReconciliation,
	): Promise<void>;
}

export async function reconcileServices(
	services: readonly AnyServiceLifecycle[],
	store: ServiceReconciliationStore,
	signal?: AbortSignal,
): Promise<void> {
	for (const service of services) {
		const stored = await store.read(service.serviceKey);
		const result = await service.reconcile(stored, signal);
		if (result.kind !== "unchanged") {
			await store.write({ pluginId: service.pluginId, serviceKey: service.serviceKey }, result);
		}
	}
}
