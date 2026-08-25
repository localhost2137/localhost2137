import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInstanceId, parseServiceKey } from "../../src/kernel/identifiers.js";
import {
	instanceDirectory,
	serviceDataDirectory,
	serviceDirectory,
	storagePaths,
	transitionDirectory,
} from "../../src/node/storage-paths.js";

describe("storage layout", () => {
	it("forms every instance and service path from validated identifiers", () => {
		const paths = storagePaths(resolve("project", ".localhost2137"));
		const instanceId = parseInstanceId("dev");
		const serviceKey = parseServiceKey("slack");

		expect(relative(paths.root, instanceDirectory(paths, instanceId))).toBe(
			join("instances", "dev"),
		);
		expect(relative(paths.root, serviceDirectory(paths, instanceId, serviceKey))).toBe(
			join("instances", "dev", "services", "slack"),
		);
		expect(relative(paths.root, serviceDataDirectory(paths, instanceId, serviceKey))).toBe(
			join("instances", "dev", "services", "slack", "data"),
		);
	});

	it("keeps transition paths beneath trash and rejects unvalidated transition ids", () => {
		const paths = storagePaths(resolve("project", ".localhost2137"));
		const valid = transitionDirectory(paths, "reset_12345678");
		expect(isAbsolute(relative(paths.trash, valid))).toBe(false);
		expect(() => transitionDirectory(paths, "../escape")).toThrow(/Invalid storage transition/);
	});
});
