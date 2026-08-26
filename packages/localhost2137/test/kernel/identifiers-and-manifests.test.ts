import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	InvalidIdentifierError,
	parseInstanceId,
	parseServiceKey,
} from "../../src/kernel/identifiers.js";
import {
	ManifestValidationError,
	parseInstanceManifest,
	parseInstanceQuarantineManifest,
	parseServiceManifest,
} from "../../src/kernel/manifests.js";

const fixtures = fileURLToPath(new URL("../fixtures/manifests/", import.meta.url));

describe("storage identifiers", () => {
	it("accepts conservative instance and service identifiers", () => {
		expect(parseInstanceId("test-worker-1").value).toBe("test-worker-1");
		expect(parseServiceKey("slack-secondary").value).toBe("slack-secondary");
	});

	it.each(["", "_", "../dev", "DEV", "two/slash", `a${"b".repeat(63)}`])(
		"rejects invalid instance id %j before path formation",
		(value) => {
			expect(() => parseInstanceId(value)).toThrow(InvalidIdentifierError);
		},
	);
});

describe("versioned manifests", () => {
	it("loads the current instance and service fixtures", async () => {
		const instance = parseInstanceManifest(
			JSON.parse(await readFile(`${fixtures}/instance-current.json`, "utf8")),
			"instance-current.json",
		);
		const service = parseServiceManifest(
			JSON.parse(await readFile(`${fixtures}/service-current.json`, "utf8")),
			"service-current.json",
		);

		expect(instance).toMatchObject({ schemaVersion: 2, status: "ready" });
		expect(service).toMatchObject({ pluginId: "slack", stateVersion: 2 });
		expect(Object.isFrozen(instance)).toBe(true);
		expect(Object.isFrozen(instance.clock)).toBe(true);
		expect(Object.isFrozen(instance.configuredServices)).toBe(true);
		expect(Object.isFrozen(instance.seed)).toBe(true);
		expect(Object.isFrozen(service)).toBe(true);
	});

	it.each([
		"instance-old.json",
		"instance-newer.json",
		"instance-corrupt.json",
		"instance-duplicate-services.json",
		"instance-invalid-clock.json",
		"instance-invalid-fingerprint.json",
	])("rejects incompatible fixture %s without guessing", async (name) => {
		const value = JSON.parse(await readFile(`${fixtures}/${name}`, "utf8"));
		expect(() => parseInstanceManifest(value, name)).toThrow(ManifestValidationError);
	});

	it("deeply freezes nested seed failure and transition records", () => {
		const manifest = parseInstanceManifest(
			{
				clock: { instantMs: 0, mode: "pinned" },
				configuredServices: ["slack"],
				configFingerprint: `sha256:${"a".repeat(64)}`,
				createdAt: "2026-08-25T12:00:00.000Z",
				id: "dev",
				persistence: "persistent",
				schemaVersion: 2,
				seed: {
					attempt: 1,
					failure: { at: "2026-08-25T12:01:00.000Z", message: "Seed failed." },
					status: "seed_failed",
				},
				status: "creating",
				transition: { id: "reset_12345678", kind: "reset" },
			},
			"instance.json",
		);

		expect(Object.isFrozen(manifest.seed)).toBe(true);
		expect(manifest.seed.status).toBe("seed_failed");
		if (manifest.seed.status !== "seed_failed") throw new Error("Expected failed seed fixture.");
		expect(Object.isFrozen(manifest.seed.failure)).toBe(true);
		expect(Object.isFrozen(manifest.transition)).toBe(true);
	});

	it("validates and deeply freezes pending time-advance progress", () => {
		const manifest = parseInstanceManifest(
			{
				clock: { instantMs: 1_000, mode: "pinned" },
				configuredServices: ["slack", "stripe"],
				configFingerprint: `sha256:${"a".repeat(64)}`,
				createdAt: "2026-08-25T12:00:00.000Z",
				id: "dev",
				persistence: "persistent",
				schemaVersion: 2,
				seed: { attempt: 0, status: "unseeded" },
				status: "ready",
				timeAdvance: {
					acknowledgedServices: ["slack"],
					fromMs: 0,
					id: "advance_12345678",
					services: ["slack", "stripe"],
					toMs: 1_000,
				},
			},
			"instance.json",
		);

		expect(Object.isFrozen(manifest.timeAdvance)).toBe(true);
		expect(Object.isFrozen(manifest.timeAdvance?.services)).toBe(true);
		expect(Object.isFrozen(manifest.timeAdvance?.acknowledgedServices)).toBe(true);
		for (const acknowledgedServices of [["stripe"], ["slack", "stripe", "extra"]]) {
			expect(() =>
				parseInstanceManifest(
					{
						...manifest,
						timeAdvance: { ...manifest.timeAdvance, acknowledgedServices },
					},
					"instance.json",
				),
			).toThrow(ManifestValidationError);
		}
		for (const invalid of [
			{
				...manifest,
				clock: { instantMs: 999, mode: "pinned" },
			},
			{
				...manifest,
				timeAdvance: { ...manifest.timeAdvance, services: ["stripe", "slack"] },
			},
			{
				...manifest,
				timeAdvance: {
					...manifest.timeAdvance,
					fromMs: -8_640_000_000_000_000,
					toMs: 8_640_000_000_000_000,
				},
			},
		]) {
			expect(() => parseInstanceManifest(invalid, "instance.json")).toThrow(
				ManifestValidationError,
			);
		}
	});

	it("validates and freezes runtime quarantine metadata", () => {
		const manifest = parseInstanceQuarantineManifest(
			{
				createdAt: "2026-08-25T12:00:00.000Z",
				instanceId: "dev",
				reason: "failed_creation",
				schemaVersion: 1,
				trashId: "create_dev_12345678",
			},
			"quarantine.json",
		);

		expect(manifest).toMatchObject({ instanceId: "dev", reason: "failed_creation" });
		expect(Object.isFrozen(manifest)).toBe(true);
	});
});
