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
	});

	it.each(["instance-old.json", "instance-newer.json", "instance-corrupt.json"])(
		"rejects incompatible fixture %s without guessing",
		async (name) => {
			const value = JSON.parse(await readFile(`${fixtures}/${name}`, "utf8"));
			expect(() => parseInstanceManifest(value, name)).toThrow(ManifestValidationError);
		},
	);
});
