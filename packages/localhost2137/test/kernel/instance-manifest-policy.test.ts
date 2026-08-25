import { describe, expect, it } from "vitest";
import { parseInstanceId } from "../../src/kernel/identifiers.js";
import { InstanceManifestPolicy } from "../../src/kernel/instance-manifest-policy.js";
import type { InstanceTemplate } from "../../src/kernel/instance-template.js";

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
			schemaVersion: 1,
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
