import { describe, expect, it } from "vitest";
import type { ActiveInstance } from "../../src/kernel/active-instance.js";
import {
	ActiveInstanceRegistry,
	InstanceAlreadyExistsError,
	InstanceNotFoundError,
} from "../../src/kernel/active-instance-registry.js";
import { parseInstanceId } from "../../src/kernel/identifiers.js";

describe("ActiveInstanceRegistry", () => {
	it("reserves IDs synchronously across async creation work", () => {
		const registry = new ActiveInstanceRegistry();
		const id = parseInstanceId("dev");
		const release = registry.reserve(id);

		expect(() => registry.reserve(id)).toThrow(InstanceAlreadyExistsError);
		release();
		expect(() => registry.reserve(id)).not.toThrow();
	});

	it("only removes or replaces the exact active generation", () => {
		const registry = new ActiveInstanceRegistry();
		const first = { id: parseInstanceId("dev") } as ActiveInstance;
		const stale = { id: first.id } as ActiveInstance;
		const replacement = { id: first.id } as ActiveInstance;
		registry.add(first);

		registry.remove(stale);
		expect(registry.get(first.id)).toBe(first);
		expect(() => registry.replace(stale, replacement)).toThrow(InstanceNotFoundError);
		registry.replace(first, replacement);
		expect(registry.get(first.id)).toBe(replacement);
	});
});
