import { constants } from "node:fs";
import {
	appendFile,
	chmod,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CliUsageError } from "../../src/cli/cli-errors.js";
import { CONFIG_FILE_NAMES } from "../../src/config/config-discovery.js";
import { loadResolvedConfig } from "../../src/config/load-config.js";
import { syncDirectory } from "../../src/node/atomic-file.js";
import type {
	ProjectInitFileHandle,
	ProjectInitFileSystem,
} from "../../src/node/project-init-file.js";
import { initializeProject } from "../../src/node/project-initializer.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("project initializer", () => {
	it("creates durable minimal files that load through the real config boundary", async () => {
		const project = await temporaryProject();

		await expect(initializeProject(project)).resolves.toEqual({ gitignore: "created" });
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toBe(
			'import { defineConfig } from "localhost2137";\n\nexport default defineConfig({\n\tservices: {},\n});\n',
		);
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(".localhost2137/\n");
		expect((await stat(join(project, "localhost.config.ts"))).mode & 0o777).toBe(0o644);
		expect((await stat(join(project, ".gitignore"))).mode & 0o777).toBe(0o644);
		await expect(loadResolvedConfig({ cwd: project })).resolves.toMatchObject({ services: {} });
		await expect(readFile(join(project, ".localhost2137.init.lock"), "utf8")).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		);
	});

	it("does not read or mutate package metadata", async () => {
		const project = await temporaryProject();
		const packagePath = join(project, "package.json");
		const packageBytes = "this is intentionally not valid JSON\n";
		await writeFile(packagePath, packageBytes, "utf8");

		await expect(initializeProject(project)).resolves.toEqual({ gitignore: "created" });
		await expect(readFile(packagePath, "utf8")).resolves.toBe(packageBytes);
	});

	it.each([
		["empty", "", ".localhost2137/\n", "created-entry"],
		["LF without final newline", "node_modules/", "node_modules/\n.localhost2137/\n", "updated"],
		["CRLF", "node_modules/\r\n.env", "node_modules/\r\n.env\r\n.localhost2137/\r\n", "updated"],
		[
			"final exact directive before comments",
			"node_modules/\n.localhost2137/\n# kept\n\n",
			"node_modules/\n.localhost2137/\n# kept\n\n",
			"unchanged",
		],
		[
			"later broad negation",
			".localhost2137/\n!.*\n",
			".localhost2137/\n!.*\n.localhost2137/\n",
			"updated",
		],
		[
			"indented lookalike",
			"  .localhost2137/\n",
			"  .localhost2137/\n.localhost2137/\n",
			"updated",
		],
	] as const)("preserves bytes and mode for %s", async (_label, initial, expected, state) => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		await writeFile(path, initial, { encoding: "utf8", mode: 0o640 });

		const result = await initializeProject(project);

		expect(result.gitignore).toBe(state === "unchanged" ? "unchanged" : "updated");
		await expect(readFile(path, "utf8")).resolves.toBe(expected);
		expect((await stat(path)).mode & 0o777).toBe(0o640);
	});

	it("does not append again when its exact directive remains final", async () => {
		const project = await temporaryProject();
		await writeFile(join(project, ".gitignore"), ".localhost2137/\n!.*\n", "utf8");
		await initializeProject(project);
		await rm(join(project, "localhost.config.ts"));

		await expect(initializeProject(project)).resolves.toEqual({ gitignore: "unchanged" });
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(
			".localhost2137/\n!.*\n.localhost2137/\n",
		);
	});

	it("does not require write access when the exact ignore directive is already final", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		await writeFile(path, ".localhost2137/\n", "utf8");
		await chmod(path, 0o444);

		await expect(initializeProject(project)).resolves.toEqual({ gitignore: "unchanged" });
		await expect(readFile(path, "utf8")).resolves.toBe(".localhost2137/\n");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toContain(
			"defineConfig",
		);
	});

	it("rolls config back when a read-only gitignore needs an update", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		await writeFile(path, "node_modules/\n", "utf8");
		await chmod(path, 0o444);

		await expect(initializeProject(project)).rejects.toMatchObject({
			message: expect.stringContaining("not writable"),
		});
		await expect(readFile(path, "utf8")).resolves.toBe("node_modules/\n");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects every canonical config alias, including directories and symlinks", async () => {
		expect(CONFIG_FILE_NAMES).toEqual([
			"localhost.config.ts",
			"localhost.config.mts",
			"localhost.config.cts",
			"localhost.config.js",
			"localhost.config.mjs",
			"localhost.config.cjs",
		]);
		for (const [index, name] of CONFIG_FILE_NAMES.entries()) {
			const project = await temporaryProject();
			const path = join(project, name);
			if (index % 3 === 0) await writeFile(path, "existing\n", "utf8");
			if (index % 3 === 1) await mkdir(path);
			if (index % 3 === 2) await symlink(join(project, "missing-target"), path);

			await expect(initializeProject(project)).rejects.toBeInstanceOf(CliUsageError);
			await expect(readFile(join(project, ".gitignore"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
	});

	it("rejects an oversized or nonregular gitignore before creating config", async () => {
		const oversized = await temporaryProject();
		await writeFile(join(oversized, ".gitignore"), "x".repeat(1024 * 1024 + 1), "utf8");
		await expect(initializeProject(oversized)).rejects.toMatchObject({
			message: expect.stringContaining("safety limit"),
		});
		await expect(readFile(join(oversized, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const nonregular = await temporaryProject();
		await mkdir(join(nonregular, ".gitignore"));
		await expect(initializeProject(nonregular)).rejects.toBeInstanceOf(CliUsageError);
		await expect(readFile(join(nonregular, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("never opens a symlink swapped in after gitignore inspection", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		const retired = join(project, "retired-ignore");
		const outside = join(await temporaryProject(), "outside-ignore");
		await writeFile(path, "original\n", "utf8");
		await writeFile(outside, "outside\n", "utf8");
		let swapped = false;
		const fileSystem = injectedFileSystem({
			async beforeOpen(openedPath) {
				if (openedPath === path && !swapped) {
					swapped = true;
					await rename(path, retired);
					await symlink(outside, path);
				}
			},
		});

		await expect(initializeProject(project, { fileSystem })).rejects.toBeInstanceOf(CliUsageError);
		await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("preserves a regular replacement installed before gitignore commit", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		const retired = join(project, "retired-ignore");
		const replacement = join(project, "replacement-ignore");
		await writeFile(path, "same bytes\n", "utf8");
		await writeFile(replacement, "same bytes\n", "utf8");
		let pathStats = 0;
		const fileSystem = injectedFileSystem({
			async beforeLstat(observedPath) {
				if (observedPath === path && ++pathStats === 3) {
					await rename(path, retired);
					await rename(replacement, path);
				}
			},
		});

		await expect(initializeProject(project, { fileSystem })).rejects.toBeInstanceOf(CliUsageError);
		await expect(readFile(path, "utf8")).resolves.toBe("same bytes\n");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("uses append semantics when another writer grows the retained gitignore", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		await writeFile(path, "node_modules/\n", "utf8");
		let appended = false;
		const fileSystem = injectedFileSystem({
			async beforeHandleWrite(openedPath) {
				if (openedPath === path && !appended) {
					appended = true;
					await appendFile(path, "external-writer/\n", "utf8");
				}
			},
		});

		await expect(initializeProject(project, { fileSystem })).rejects.toBeInstanceOf(AggregateError);
		await expect(readFile(path, "utf8")).resolves.toBe(
			"node_modules/\nexternal-writer/\n.localhost2137/\n",
		);
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("revalidates all aliases after exclusive config creation", async () => {
		const project = await temporaryProject();
		const configPath = join(project, "localhost.config.ts");
		const racedAlias = join(project, "localhost.config.mjs");
		let injected = false;
		const fileSystem = injectedFileSystem({
			async afterOpen(path, flags) {
				if (path === configPath && flags & constants.O_EXCL && !injected) {
					injected = true;
					await writeFile(racedAlias, "export default { services: {} };\n", "utf8");
				}
			},
		});

		await expect(initializeProject(project, { fileSystem })).rejects.toBeInstanceOf(CliUsageError);
		await expect(readFile(racedAlias, "utf8")).resolves.toContain("services");
		await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves a replaced config and reports both primary and rollback failures", async () => {
		const project = await temporaryProject();
		const configPath = join(project, "localhost.config.ts");
		const retired = join(project, "retired-config");
		await writeFile(join(project, ".gitignore"), "existing\n", "utf8");
		let failed = false;
		const fileSystem = injectedFileSystem({
			async beforeHandleSync(path) {
				if (path === join(project, ".gitignore") && !failed) {
					failed = true;
					await rename(configPath, retired);
					await writeFile(configPath, await readFile(retired));
					throw new Error("simulated ignore sync failure");
				}
			},
		});

		const failure = await initializeProject(project, { fileSystem }).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({ message: "simulated ignore sync failure" }),
			expect.objectContaining({ message: expect.stringContaining("replaced path") }),
		]);
		await expect(readFile(configPath, "utf8")).resolves.toContain("defineConfig");
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe("existing\n");
	});

	it("preserves the primary failure when rolling back a partial append also fails", async () => {
		const project = await temporaryProject();
		const ignorePath = join(project, ".gitignore");
		await writeFile(ignorePath, "existing\n", "utf8");
		let failedSync = false;
		const fileSystem = injectedFileSystem({
			async beforeHandleSync(path) {
				if (path === ignorePath && !failedSync) {
					failedSync = true;
					throw new Error("primary sync failure");
				}
			},
			async beforeHandleTruncate(path) {
				if (path === ignorePath) throw new Error("rollback truncate failure");
			},
		});

		const failure = await initializeProject(project, { fileSystem }).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect(flattenErrors(failure)).toEqual([
			expect.objectContaining({ message: "primary sync failure" }),
			expect.objectContaining({ message: "rollback truncate failure" }),
		]);
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("refuses to truncate a moved gitignore during rollback", async () => {
		const project = await temporaryProject();
		const path = join(project, ".gitignore");
		const retired = join(project, "retired-ignore");
		const replacement = join(project, "replacement-ignore");
		await writeFile(path, "original/\n", "utf8");
		await writeFile(replacement, "replacement/\n", "utf8");
		let failedSync = false;
		let pathStats = 0;
		const fileSystem = injectedFileSystem({
			async beforeHandleSync(openedPath) {
				if (openedPath === path && !failedSync) {
					failedSync = true;
					throw new Error("primary sync failure");
				}
			},
			async beforeLstat(observedPath) {
				if (observedPath === path && ++pathStats === 5) {
					await rename(path, retired);
					await rename(replacement, path);
				}
			},
		});

		const failure = await initializeProject(project, { fileSystem }).catch(
			(cause: unknown) => cause,
		);
		expect(flattenErrors(failure)).toEqual([
			expect.objectContaining({ message: "primary sync failure" }),
			expect.objectContaining({ message: expect.stringContaining("moved or was replaced") }),
		]);
		await expect(readFile(path, "utf8")).resolves.toBe("replacement/\n");
		await expect(readFile(retired, "utf8")).resolves.toBe("original/\n.localhost2137/\n");
	});

	it("reports committed config when its directory sync cannot be confirmed", async () => {
		const project = await temporaryProject();
		let directorySyncs = 0;
		const fileSystem = injectedFileSystem({
			async beforeDirectorySync() {
				directorySyncs += 1;
				if (directorySyncs === 1) throw new Error("config directory sync failure");
			},
		});

		await expect(initializeProject(project, { fileSystem })).rejects.toThrow("created");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toContain(
			"defineConfig",
		);
		await expect(readFile(join(project, ".localhost2137.init.lock"), "utf8")).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		);
	});

	it("serializes concurrent initializers without duplicate entries or leftover locks", async () => {
		const project = await temporaryProject();
		const outcomes = await Promise.allSettled([
			initializeProject(project, { ownerToken: () => "concurrent-one" }),
			initializeProject(project, { ownerToken: () => "concurrent-two" }),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(".localhost2137/\n");
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toContain(
			"defineConfig",
		);
		await expect(readFile(join(project, ".localhost2137.init.lock"), "utf8")).rejects.toMatchObject(
			{
				code: "ENOENT",
			},
		);
	});
});

interface FileSystemHooks {
	readonly afterOpen?: (path: string, flags: number) => Promise<void>;
	readonly beforeDirectorySync?: (path: string) => Promise<void>;
	readonly beforeHandleSync?: (path: string) => Promise<void>;
	readonly beforeHandleTruncate?: (path: string) => Promise<void>;
	readonly beforeHandleWrite?: (path: string) => Promise<void>;
	readonly beforeLstat?: (path: string) => Promise<void>;
	readonly beforeOpen?: (path: string, flags: number) => Promise<void>;
}

function injectedFileSystem(hooks: FileSystemHooks): ProjectInitFileSystem {
	return {
		async lstat(path) {
			await hooks.beforeLstat?.(path);
			return lstat(path, { bigint: true });
		},
		async open(path, flags, mode) {
			await hooks.beforeOpen?.(path, flags);
			const handle = await open(path, flags, mode);
			await hooks.afterOpen?.(path, flags);
			return injectedHandle(path, handle, hooks);
		},
		async syncDirectory(path) {
			await hooks.beforeDirectorySync?.(path);
			return syncDirectory(path);
		},
		unlink,
	};
}

function injectedHandle(
	path: string,
	handle: FileHandle,
	hooks: FileSystemHooks,
): ProjectInitFileHandle {
	return {
		close: () => handle.close(),
		read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
		stat: () => handle.stat({ bigint: true }),
		async sync() {
			await hooks.beforeHandleSync?.(path);
			await handle.sync();
		},
		async truncate(length) {
			await hooks.beforeHandleTruncate?.(path);
			await handle.truncate(length);
		},
		async write(buffer, offset, length, position) {
			await hooks.beforeHandleWrite?.(path);
			return handle.write(buffer, offset, length, position);
		},
		writeFile: (content) => handle.writeFile(content, "utf8"),
	};
}

function flattenErrors(value: unknown): unknown[] {
	if (!(value instanceof AggregateError)) return [value];
	return value.errors.flatMap(flattenErrors);
}

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(join(packageDirectory, "test/.tmp-init-"));
	temporaryDirectories.push(directory);
	return directory;
}
