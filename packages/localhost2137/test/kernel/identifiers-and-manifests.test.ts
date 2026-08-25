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

		expect(instance.status).toBe("ready");
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
				schemaVersion: 1,
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
});
