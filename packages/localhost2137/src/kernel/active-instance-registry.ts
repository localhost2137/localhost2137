import type { ActiveInstance } from "./active-instance.js";
import type { InstanceId } from "./identifiers.js";

export class InstanceNotFoundError extends Error {
	constructor(instanceId: string) {
		super(`Instance "${instanceId}" does not exist.`);
		this.name = "InstanceNotFoundError";
	}
}

export class InstanceAlreadyExistsError extends Error {
	constructor(instanceId: string) {
		super(`Instance "${instanceId}" already exists.`);
		this.name = "InstanceAlreadyExistsError";
	}
}

export class ActiveInstanceRegistry {
	readonly #records = new Map<string, ActiveInstance>();
	readonly #reservedIds = new Set<string>();

	reserve(instanceId: InstanceId): () => void {
		if (this.#records.has(instanceId.value) || this.#reservedIds.has(instanceId.value)) {
			throw new InstanceAlreadyExistsError(instanceId.value);
		}
		this.#reservedIds.add(instanceId.value);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#reservedIds.delete(instanceId.value);
		};
	}

	has(instanceId: InstanceId): boolean {
		return this.#records.has(instanceId.value);
	}

	get(instanceId: InstanceId): ActiveInstance {
		const active = this.#records.get(instanceId.value);
		if (!active) throw new InstanceNotFoundError(instanceId.value);
		return active;
	}

	add(active: ActiveInstance): void {
		if (this.#records.has(active.id.value)) {
			throw new InstanceAlreadyExistsError(active.id.value);
		}
		this.#records.set(active.id.value, active);
	}

	replace(previous: ActiveInstance, replacement: ActiveInstance): void {
		if (previous.id.value !== replacement.id.value) {
			throw new TypeError("An active instance can only be replaced by the same instance ID.");
		}
		if (this.#records.get(previous.id.value) !== previous) {
			throw new InstanceNotFoundError(previous.id.value);
		}
		this.#records.set(previous.id.value, replacement);
	}

	remove(active: ActiveInstance): void {
		if (this.#records.get(active.id.value) === active) this.#records.delete(active.id.value);
	}

	all(): readonly ActiveInstance[] {
		return Object.freeze([...this.#records.values()]);
	}
}
