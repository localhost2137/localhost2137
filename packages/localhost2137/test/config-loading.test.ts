import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigError } from "../src/config/config-error.js";
import { discoverConfigFile } from "../src/config/config-discovery.js";
import { importConfigDefault } from "../src/config/config-import.js";
import { resolvePathFromConfig } from "../src/config/config-resolution.js";
import { loadResolvedConfig } from "../src/config/load-config.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(packageDirectory, "test/fixtures/config-project");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("config discovery and TypeScript import", () => {
	it("walks upward and loads the basic config without runtime or filesystem side effects", async () => {
		const project = join(fixtureDirectory, "basic");
		const nested = join(project, "nested/working/directory");
		const before = await readdir(project);
		const config = await loadResolvedConfig({ cwd: nested });

		expect(config.configPath).toBe(join(project, "localhost.config.ts"));
		expect(config.host).toBe("127.0.0.1");
		expect(config.port).toBe(2137);
		expect(config.services.fixture?.connection.values).toEqual({
			baseUrl: "http://127.0.0.1:2137/dev/fixture",
			token: "local-basic-token",
		});
		expect(await readdir(project)).toEqual(before);
	});

	it("supports ESM, top-level await, TypeScript imports, and full-style config", async () => {
		const configPath = join(fixtureDirectory, "full/localhost.config.ts");
		const config = await loadResolvedConfig({ cwd: packageDirectory, explicitPath: configPath });

		expect(config.clock).toEqual({ mode: "pinned", startAt: "2026-01-01T00:00:00.000Z" });
		expect(config.services.primary?.seed).toEqual({ names: ["Alice"] });
		expect(config.services.primary?.configSchema.required).toEqual(["label", "token"]);
		expect(config.services.primary?.seedSchema?.required).toBeUndefined();
		expect(config.services.primary?.operations.createThing?.cli.kind).toBe("flags");
		expect(config.services.secondary?.exportEnv).toBe(false);
		expect(config.storage.dir).toBe(join(fixtureDirectory, "full/state/local"));
		expect(config.seed).toBeTypeOf("function");
	});

	it("resolves an explicit relative path from cwd", async () => {
		const path = await discoverConfigFile({
			cwd: fixtureDirectory,
			explicitPath: "basic/localhost.config.ts",
		});
		expect(path).toBe(join(fixtureDirectory, "basic/localhost.config.ts"));
	});

	it("keeps import failures separate from missing default exports", async () => {
		const project = await temporaryProject();
		const syntaxPath = join(project, "syntax.ts");
		const missingDefaultPath = join(project, "missing-default.ts");
		await writeFile(syntaxPath, "export default { broken: ; }\n");
		await writeFile(missingDefaultPath, "export const config = {};\n");

		await expect(importConfigDefault(syntaxPath)).rejects.toMatchObject({
			code: "CONFIG_IMPORT_FAILED",
			message: `Failed to import localhost2137 config at ${syntaxPath}.`,
		});
		await expect(importConfigDefault(missingDefaultPath)).rejects.toMatchObject({
			code: "CONFIG_DEFAULT_EXPORT_MISSING",
			message: `Config must default-export defineConfig({...}): ${missingDefaultPath}.`,
		});
	});

	it("imports a TypeScript config across a CommonJS module boundary", async () => {
		const project = await temporaryProject();
		const settingsPath = join(project, "settings.cjs");
		const configPath = join(project, "localhost.config.ts");
		await writeFile(settingsPath, "module.exports = { port: 42137 };\n");
		await writeFile(
			configPath,
			'import settings from "./settings.cjs";\nexport default { port: settings.port, services: {} };\n',
		);

		const config = await loadResolvedConfig({ cwd: project });
		expect(config.port).toBe(42_137);
	});

	it("retains a throwing module as the cause of an import error without serializing it", async () => {
		const project = await temporaryProject();
		const configPath = join(project, "localhost.config.ts");
		await writeFile(configPath, 'throw new Error("private import detail");\n');

		let error: unknown;
		try {
			await importConfigDefault(configPath);
		} catch (cause) {
			error = cause;
		}
		expect(error).toEqual(
			expect.objectContaining({
				cause: expect.objectContaining({ message: "private import detail" }),
				code: "CONFIG_IMPORT_FAILED",
			}),
		);
		expect(JSON.stringify(error)).not.toContain("private import detail");
	});

	it("reports exact discovery diagnostics", async () => {
		const project = await temporaryProject();
		await expect(discoverConfigFile({ cwd: project, explicitPath: "missing.ts" })).rejects.toEqual(
			expect.objectContaining<Partial<ConfigError>>({
				code: "CONFIG_NOT_FOUND",
				details: {
					configPath: join(project, "missing.ts"),
					searchedFrom: project,
				},
				message: `Config file does not exist: ${join(project, "missing.ts")}.`,
			}),
		);
	});

	it("reports an upward discovery miss from the normalized starting directory", async () => {
		const project = await temporaryProject();
		await expect(discoverConfigFile({ cwd: project })).rejects.toMatchObject({
			code: "CONFIG_NOT_FOUND",
			details: { searchedFrom: project },
			message: `No localhost2137 config found while walking upward from ${project}.`,
		});
	});

	it("uses the selected platform path semantics for config-relative paths", () => {
		expect(resolvePathFromConfig("C:\\work\\project\\localhost.config.ts", ".state", win32)).toBe(
			"C:\\work\\project\\.state",
		);
	});
});

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(join(packageDirectory, "test/.tmp-config-"));
	temporaryDirectories.push(directory);
	return directory;
}
