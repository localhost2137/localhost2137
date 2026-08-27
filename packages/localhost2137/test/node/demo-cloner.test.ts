import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliDemoNotFoundError, CliUsageError } from "../../src/cli/cli-errors.js";
import { cloneDemoProject } from "../../src/node/demo-cloner.js";
import type { EmbeddedDemo } from "../../src/node/demo-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("demo cloner", () => {
	it("copies the complete embedded demo and materializes .gitignore without installing", async () => {
		const project = await temporaryProject();
		const runChild = vi.fn(async () => 0);

		await expect(
			cloneDemoProject(
				{
					cwd: project,
					inheritedEnv: {},
					install: false,
					name: "slack-ping-bot",
				},
				{ runChild },
			),
		).resolves.toEqual({ directory: "./slack-ping-bot", installed: false });

		const target = join(project, "slack-ping-bot");
		expect(await regularFiles(target)).toEqual([
			".gitignore",
			"README.md",
			"localhost.config.ts",
			"package.json",
			"pnpm-workspace.yaml",
			"src/bot.ts",
			"src/main.ts",
			"test/ping-pong.test.ts",
			"tsconfig.json",
			"vitest.config.ts",
		]);
		await expect(readFile(join(target, ".gitignore"), "utf8")).resolves.toContain(
			".localhost2137/",
		);
		expect((await stat(target)).mode & 0o777).toBe(0o755);
		expect(runChild).not.toHaveBeenCalled();
		expect((await readdir(project)).filter((name) => name.startsWith(".localhost2137"))).toEqual(
			[],
		);
	});

	it("installs in the private stage by default and publishes installed output only on success", async () => {
		const project = await temporaryProject();
		const runChild = vi.fn(async (options: Readonly<{ cwd: string }>) => {
			expect(options.cwd).not.toBe(join(project, "custom-demo"));
			await mkdir(join(options.cwd, "node_modules"));
			await writeFile(join(options.cwd, "node_modules/installed"), "yes\n", "utf8");
			return 0;
		});

		await expect(
			cloneDemoProject(
				{
					cwd: project,
					directory: "custom-demo",
					inheritedEnv: { EXISTING: "yes" },
					install: true,
					name: "slack-ping-bot",
				},
				{ runChild },
			),
		).resolves.toEqual({ directory: "./custom-demo", installed: true });

		expect(runChild).toHaveBeenCalledWith({
			argv: ["pnpm", "install"],
			connectionEnv: {},
			cwd: expect.stringContaining(".localhost2137.demo-"),
			inheritedEnv: { EXISTING: "yes" },
		});
		await expect(
			readFile(join(project, "custom-demo/node_modules/installed"), "utf8"),
		).resolves.toBe("yes\n");
	});

	it("rejects unknown demos with the exact available registry name", async () => {
		const project = await temporaryProject();

		const failure = await cloneDemoProject({
			cwd: project,
			inheritedEnv: {},
			install: false,
			name: "slack",
		}).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(CliDemoNotFoundError);
		expect(failure).toMatchObject({ demoName: "slack" });
		expect((failure as Error).message).toContain("Available demos: slack-ping-bot");
		expect(await readdir(project)).toEqual([]);
	});

	it.each([".", "..", "../outside", "nested/../demo", "/absolute", "missing/demo"])(
		"rejects the unsafe destination %s before creating staging state",
		async (directory) => {
			const project = await temporaryProject();

			await expect(
				cloneDemoProject({
					cwd: project,
					directory,
					inheritedEnv: {},
					install: false,
					name: "slack-ping-bot",
				}),
			).rejects.toBeInstanceOf(CliUsageError);
			expect(await readdir(project)).toEqual([]);
		},
	);

	it("rejects symlinked parents and every kind of pre-existing target", async () => {
		const project = await temporaryProject();
		const outside = await temporaryProject();
		await symlink(outside, join(project, "linked"));
		await expect(clone(project, "linked/demo")).rejects.toBeInstanceOf(CliUsageError);

		for (const [name, create] of [
			["file", () => writeFile(join(project, "file"), "owned\n", "utf8")],
			["directory", () => mkdir(join(project, "directory"))],
			["symlink", () => symlink(outside, join(project, "symlink"))],
		] as const) {
			await create();
			await expect(clone(project, name)).rejects.toBeInstanceOf(CliUsageError);
		}

		await expect(readFile(join(project, "file"), "utf8")).resolves.toBe("owned\n");
		expect(await readdir(join(project, "directory"))).toEqual([]);
		await expect(readFile(join(project, "symlink"), "utf8")).rejects.toMatchObject({
			code: "EISDIR",
		});
	});

	it("rolls back a failed install without publishing partial files", async () => {
		const project = await temporaryProject();
		const failure = new Error("install failed");

		await expect(
			cloneDemoProject(
				{
					cwd: project,
					inheritedEnv: {},
					install: true,
					name: "slack-ping-bot",
				},
				{
					runChild: async (options) => {
						await mkdir(join(options.cwd, "node_modules"));
						throw failure;
					},
				},
			),
		).rejects.toBe(failure);
		expect(await readdir(project)).toEqual([]);
	});

	it.each(["directory", "symlink"])(
		"rejects a non-regular %s source entry and cleans staging",
		async (kind) => {
			const project = await temporaryProject();
			const assetDirectory = await temporaryProject();
			const source = join(assetDirectory, "entry");
			if (kind === "directory") await mkdir(source);
			else {
				await writeFile(join(assetDirectory, "regular"), "safe\n", "utf8");
				await symlink(join(assetDirectory, "regular"), source);
			}
			const demo: EmbeddedDemo = Object.freeze({
				assetDirectory,
				assets: Object.freeze([Object.freeze({ source: "entry", target: "entry" })]),
				name: "slack-ping-bot",
				version: 1,
			});

			await expect(
				cloneDemoProject(
					{
						cwd: project,
						inheritedEnv: {},
						install: false,
						name: "slack-ping-bot",
					},
					{ findDemo: () => demo },
				),
			).rejects.toThrow("must be a regular file");
			expect(await readdir(project)).toEqual([]);
		},
	);

	it("preserves a target that appears during installation and removes only its own stage", async () => {
		const project = await temporaryProject();
		const target = join(project, "slack-ping-bot");

		await expect(
			cloneDemoProject(
				{
					cwd: project,
					inheritedEnv: {},
					install: true,
					name: "slack-ping-bot",
				},
				{
					runChild: async () => {
						await mkdir(target);
						await writeFile(join(target, "external"), "keep\n", "utf8");
						return 0;
					},
				},
			),
		).rejects.toBeInstanceOf(CliUsageError);

		await expect(readFile(join(target, "external"), "utf8")).resolves.toBe("keep\n");
		expect(await readdir(project)).toEqual(["slack-ping-bot"]);
	});

	it("serializes the same target but allows independent nested targets", async () => {
		const project = await temporaryProject();
		await Promise.all([mkdir(join(project, "a")), mkdir(join(project, "b"))]);
		const sameGate = Promise.withResolvers<void>();
		const sameEntered = Promise.withResolvers<void>();
		const first = cloneDemoProject(
			{
				cwd: project,
				directory: "a/demo",
				inheritedEnv: {},
				install: true,
				name: "slack-ping-bot",
			},
			{
				runChild: async () => {
					sameEntered.resolve();
					await sameGate.promise;
					return 0;
				},
			},
		);
		await sameEntered.promise;
		await expect(clone(project, "a/demo")).rejects.toBeInstanceOf(CliUsageError);

		const secondGate = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const second = cloneDemoProject(
			{
				cwd: project,
				directory: "b/demo",
				inheritedEnv: {},
				install: true,
				name: "slack-ping-bot",
			},
			{
				runChild: async () => {
					secondEntered.resolve();
					await secondGate.promise;
					return 0;
				},
			},
		);
		await secondEntered.promise;
		sameGate.resolve();
		secondGate.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ directory: "./a/demo", installed: true },
			{ directory: "./b/demo", installed: true },
		]);
	});

	it("refuses to remove a staging path replaced by another writer", async () => {
		const project = await temporaryProject();
		let replacement = "";
		let retired = "";

		const failure = await cloneDemoProject(
			{
				cwd: project,
				inheritedEnv: {},
				install: true,
				name: "slack-ping-bot",
			},
			{
				runChild: async (options) => {
					replacement = options.cwd;
					retired = `${options.cwd}.retired`;
					await rename(options.cwd, retired);
					await mkdir(options.cwd);
					throw new Error("installer replaced staging");
				},
			},
		).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({ message: "installer replaced staging" }),
			expect.objectContaining({ message: expect.stringContaining("Refusing to remove replaced") }),
		]);
		expect(await readdir(replacement)).toEqual([]);
		expect(await readdir(retired)).toContain("package.json");
		expect((await readdir(project)).some((name) => name.endsWith(".lock"))).toBe(false);
	});
});

async function clone(project: string, directory: string) {
	return await cloneDemoProject({
		cwd: project,
		directory,
		inheritedEnv: {},
		install: false,
		name: "slack-ping-bot",
	});
}

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-demo-clone-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function regularFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) result.push(path.slice(root.length + 1).replaceAll("\\", "/"));
		}
	}
	await visit(root);
	return result.sort();
}
