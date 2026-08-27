import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliProjectConflictError } from "../../src/cli/cli-errors.js";
import { initializeProject } from "../../src/node/project-initializer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("project initializer", () => {
	it("creates a minimal config and ignore file without package metadata", async () => {
		const project = await temporaryProject();

		await expect(initializeProject(project)).resolves.toEqual({
			gitignore: "created",
			needsPackageManifest: true,
			needsRuntimeDependency: true,
		});
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).resolves.toBe(
			'import { defineConfig } from "localhost2137";\n\nexport default defineConfig({\n\tservices: {},\n});\n',
		);
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(".localhost2137/\n");
		await expect(readFile(join(project, "package.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("appends one effective entry without changing existing bytes or newline style", async () => {
		const project = await temporaryProject();
		await writeFile(join(project, ".gitignore"), "node_modules/\r\n.env", "utf8");
		await writeFile(
			join(project, "package.json"),
			'{"dependencies":{"localhost2137":"0.0.0"}}\n',
			"utf8",
		);

		await expect(initializeProject(project)).resolves.toEqual({
			gitignore: "updated",
			needsPackageManifest: false,
			needsRuntimeDependency: false,
		});
		await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe(
			"node_modules/\r\n.env\r\n.localhost2137/\r\n",
		);
	});

	it("recognizes an effective root entry and repairs a later negation", async () => {
		const ignored = await temporaryProject();
		await writeFile(join(ignored, ".gitignore"), "/.localhost2137\n", "utf8");
		await expect(initializeProject(ignored)).resolves.toMatchObject({ gitignore: "unchanged" });
		await expect(readFile(join(ignored, ".gitignore"), "utf8")).resolves.toBe("/.localhost2137\n");

		const negated = await temporaryProject();
		await writeFile(join(negated, ".gitignore"), ".localhost2137/\n!.localhost2137/\n", "utf8");
		await expect(initializeProject(negated)).resolves.toMatchObject({ gitignore: "updated" });
		await expect(readFile(join(negated, ".gitignore"), "utf8")).resolves.toBe(
			".localhost2137/\n!.localhost2137/\n.localhost2137/\n",
		);
	});

	it("refuses every supported config alias without changing gitignore", async () => {
		for (const name of [
			"localhost.config.ts",
			"localhost.config.mts",
			"localhost.config.cts",
			"localhost.config.js",
			"localhost.config.mjs",
			"localhost.config.cjs",
		]) {
			const project = await temporaryProject();
			await writeFile(join(project, ".gitignore"), "existing\n", "utf8");
			await writeFile(join(project, name), "existing\n", "utf8");

			await expect(initializeProject(project)).rejects.toBeInstanceOf(CliProjectConflictError);
			await expect(readFile(join(project, ".gitignore"), "utf8")).resolves.toBe("existing\n");
		}
	});

	it("never follows a config or gitignore symlink", async () => {
		const configProject = await temporaryProject();
		const outsideConfig = join(await temporaryProject(), "outside.ts");
		await writeFile(outsideConfig, "outside\n", "utf8");
		await symlink(outsideConfig, join(configProject, "localhost.config.ts"));
		await expect(initializeProject(configProject)).rejects.toBeInstanceOf(CliProjectConflictError);
		await expect(readFile(outsideConfig, "utf8")).resolves.toBe("outside\n");

		const ignoreProject = await temporaryProject();
		const outsideIgnore = join(await temporaryProject(), "ignore");
		await writeFile(outsideIgnore, "outside\n", "utf8");
		await symlink(outsideIgnore, join(ignoreProject, ".gitignore"));
		await expect(initializeProject(ignoreProject)).rejects.toBeInstanceOf(CliProjectConflictError);
		await expect(readFile(outsideIgnore, "utf8")).resolves.toBe("outside\n");
		await expect(
			readFile(join(ignoreProject, "localhost.config.ts"), "utf8"),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("preflights a non-file gitignore before creating the config", async () => {
		const project = await temporaryProject();
		await mkdir(join(project, ".gitignore"));

		await expect(initializeProject(project)).rejects.toBeInstanceOf(CliProjectConflictError);
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("removes its unchanged config when creating the ignore file fails", async () => {
		const project = await temporaryProject();
		let writes = 0;
		const createFile = vi.fn(async (path: string, content: string) => {
			writes += 1;
			if (writes === 2) throw new Error("simulated ignore failure");
			await writeFile(path, content, { encoding: "utf8", flag: "wx" });
		});

		await expect(initializeProject(project, { createFile })).rejects.toThrow(
			"simulated ignore failure",
		);
		await expect(readFile(join(project, "localhost.config.ts"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(project, ".gitignore"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-init-"));
	temporaryDirectories.push(directory);
	return directory;
}
