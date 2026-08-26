import { describe, expect, it } from "vitest";
import { parseInstanceId } from "../../src/kernel/identifiers.js";
import { InstanceManifestPolicy } from "../../src/kernel/instance-manifest-policy.js";
import { StorageWriteCommittedError } from "../../src/kernel/instance-storage.js";
import type { InstanceTemplate } from "../../src/kernel/instance-template.js";
import type { InstanceManifest } from "../../src/kernel/manifests.js";

const template: InstanceTemplate = Object.freeze({
	clock: Object.freeze({ mode: "pinned", startAt: "2026-08-25T12:00:00.000Z" }),
	fingerprint: `sha256:${"a".repeat(64)}`,
	services: Object.freeze([
		Object.freeze({
			config: Object.freeze({}),
			hooks: Object.freeze({ create: () => undefined, start: () => undefined }),
			pluginId: "fixture",
			serviceKey: "first",
			stateVersion: 1,
		}),
		Object.freeze({
			config: Object.freeze({}),
			hooks: Object.freeze({ create: () => undefined, start: () => undefined }),
			pluginId: "fixture",
			serviceKey: "second",
			stateVersion: 1,
		}),
	]),
});

describe("InstanceManifestPolicy", () => {
	it("owns new manifest, transition, and configuration refresh metadata", () => {
		const policy = fixturePolicy();
		const instanceId = parseInstanceId("dev");
		const created = policy.create(instanceId, "persistent", "reset_token01");

		expect(created).toEqual({
			clock: { instantMs: Date.parse("2026-08-25T12:00:00.000Z"), mode: "pinned" },
			configuredServices: ["first", "second"],
			configFingerprint: template.fingerprint,
			createdAt: "2026-08-25T12:00:00.000Z",
			id: "dev",
			persistence: "persistent",
			schemaVersion: 2,
			seed: { attempt: 0, status: "unseeded" },
			status: "creating",
			transition: { id: "reset_token01", kind: "reset" },
		});
		expect(policy.markReady(created).status).toBe("ready");
		expect(policy.clearTransition(created).transition).toBeUndefined();
		expect(
			policy.refreshConfiguration({
				...created,
				configuredServices: ["removed"],
				configFingerprint: `sha256:${"b".repeat(64)}`,
			}),
		).toMatchObject({
			configuredServices: ["first", "second"],
			configFingerprint: template.fingerprint,
		});
		expect(policy.transition(instanceId, "destroy")).toMatchObject({
			instanceId: "dev",
			kind: "destroy",
			transitionId: "destroy_token00000001",
		});
		expect(policy.creationTrashId(instanceId)).toBe("create_dev_token00000001");
	});

	it("turns an interrupted seed into durable failure diagnostics", () => {
		const policy = fixturePolicy();
		const manifest = policy.create(parseInstanceId("dev"), "persistent");

		expect(
			policy.repairInterruptedSeed({ ...manifest, seed: { attempt: 2, status: "seeding" } }),
		).toMatchObject({
			seed: {
				attempt: 2,
				failure: {
					at: "2026-08-25T12:00:00.000Z",
					message: "Runtime stopped while seeding; reset is required.",
				},
				status: "seed_failed",
			},
		});
		expect(policy.repairInterruptedSeed(manifest)).toBe(manifest);
	});

	it("validates, owns, and deeply freezes every policy output", () => {
		const policy = fixturePolicy();
		const instanceId = parseInstanceId("dev");
		const created = policy.create(instanceId, "persistent", "reset_token01");
		const ready = policy.markReady(created);
		const refreshed = policy.refreshConfiguration(created);
		const failed = policy.repairInterruptedSeed({
			...created,
			seed: { attempt: 1, status: "seeding" },
		});
		const cleared = policy.clearTransition(created);
		const transition = policy.transition(instanceId, "reset");

		for (const manifest of [created, ready, refreshed, failed, cleared]) {
			expect(Object.isFrozen(manifest)).toBe(true);
			expect(Object.isFrozen(manifest.clock)).toBe(true);
			expect(Object.isFrozen(manifest.configuredServices)).toBe(true);
			expect(Object.isFrozen(manifest.seed)).toBe(true);
			if (manifest.transition) expect(Object.isFrozen(manifest.transition)).toBe(true);
			if (manifest.seed.status === "seed_failed") {
				expect(Object.isFrozen(manifest.seed.failure)).toBe(true);
			}
		}
		expect(Object.isFrozen(transition)).toBe(true);
		expect(() => (created.configuredServices as string[]).push("late")).toThrow();
		expect(Reflect.set(created.clock, "instantMs", 1)).toBe(false);
		expect(Reflect.set(created.seed, "attempt", 99)).toBe(false);
		expect(Reflect.set(created.transition ?? {}, "id", "reset_changed01")).toBe(false);
		if (failed.seed.status !== "seed_failed") throw new Error("Expected repaired seed failure.");
		expect(Reflect.set(failed.seed.failure, "message", "changed")).toBe(false);
	});

	it("snapshots committed-write manifests instead of retaining caller objects", () => {
		const source = structuredClone(
			fixturePolicy().create(parseInstanceId("dev"), "persistent", "reset_token01"),
		) as InstanceManifest;
		const failure = new StorageWriteCommittedError(
			"write_instance",
			source,
			new Error("directory sync failed"),
		);
		(source.configuredServices as string[]).push("late");
		Reflect.set(source.clock, "instantMs", 1);
		Reflect.set(source.seed, "attempt", 99);
		Reflect.set(source.transition ?? {}, "id", "reset_changed01");

		expect(failure.intendedManifest).toEqual(
			fixturePolicy().create(parseInstanceId("dev"), "persistent", "reset_token01"),
		);
		expect(Object.isFrozen(failure.intendedManifest)).toBe(true);
		if (!("configuredServices" in failure.intendedManifest)) {
			throw new Error("Expected an instance manifest snapshot.");
		}
		expect(Object.isFrozen(failure.intendedManifest.configuredServices)).toBe(true);
		expect(Object.isFrozen(failure.intendedManifest.clock)).toBe(true);
		expect(Object.isFrozen(failure.intendedManifest.seed)).toBe(true);
		expect(Object.isFrozen(failure.intendedManifest.transition)).toBe(true);
	});
});

function fixturePolicy(): InstanceManifestPolicy {
	return new InstanceManifestPolicy(
		template,
		{
			nowMilliseconds: () => Date.parse("2026-08-25T12:00:00.000Z"),
			nowTimestamp: () => "2026-08-25T12:00:00.000Z",
		},
		() => "token00000001",
	);
}
