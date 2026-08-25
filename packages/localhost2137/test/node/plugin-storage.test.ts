import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidPluginStoragePathError, NodePluginStorage } from "../../src/node/plugin-storage.js";

describe("NodePluginStorage", () => {
	const root = resolve("/tmp", "localhost2137-plugin-data");
	const storage = new NodePluginStorage(root);

	it("returns nested paths strictly beneath the service data directory", () => {
		const result = storage.path("database/main.sqlite");
		const fromRoot = relative(root, result);
		expect(fromRoot).toBe(join("database", "main.sqlite"));
		expect(isAbsolute(fromRoot)).toBe(false);
	});

	it.each([
		"",
		".",
		"..",
		"../outside",
		"folder/../outside",
		"folder//file",
		"/absolute/file",
		"C:\\absolute\\file",
		"\\\\server\\share\\file",
		"folder\\..\\file",
		"nul\0file",
	])("rejects portable traversal or ambiguous path %j", (value) => {
		expect(() => storage.path(value)).toThrow(InvalidPluginStoragePathError);
	});
});
