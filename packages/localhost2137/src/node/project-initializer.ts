import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliProjectInitialization } from "../cli/cli-actions.js";
import { CliProjectConflictError } from "../cli/cli-errors.js";

const CONFIG_FILE_NAMES = Object.freeze([
	"localhost.config.ts",
	"localhost.config.mts",
	"localhost.config.cts",
	"localhost.config.js",
	"localhost.config.mjs",
	"localhost.config.cjs",
]);
const CONFIG_FILE_NAME = "localhost.config.ts";
const CONFIG_CONTENT = `import { defineConfig } from "localhost2137";\n\nexport default defineConfig({\n\tservices: {},\n});\n`;
const IGNORE_ENTRY = ".localhost2137/";

/** Creates the smallest runnable project contract without changing package metadata. */
export async function initializeProject(
	cwd: string,
	dependencies: ProjectInitializerDependencies = {},
): Promise<CliProjectInitialization> {
	const createFile = dependencies.createFile ?? createProjectFile;
	const root = await realpath(cwd);
	if (!(await stat(root)).isDirectory()) {
		throw new CliProjectConflictError(`Project path is not a directory: ${root}`);
	}
	await rejectExistingConfig(root);

	const configPath = join(root, CONFIG_FILE_NAME);
	const gitignorePath = join(root, ".gitignore");
	const gitignore = await inspectGitignore(gitignorePath);
	const packageState = await inspectPackage(root);

	await createFile(configPath, CONFIG_CONTENT);
	try {
		if (gitignore.kind === "missing") {
			await createFile(gitignorePath, `${IGNORE_ENTRY}\n`);
		} else if (gitignore.kind === "update") {
			await replaceUnchangedFile(
				gitignorePath,
				gitignore.content,
				gitignore.updated,
				gitignore.mode,
			);
		}
	} catch (cause) {
		await rollbackConfig(configPath);
		throw cause;
	}

	return Object.freeze({
		gitignore:
			gitignore.kind === "missing"
				? "created"
				: gitignore.kind === "update"
					? "updated"
					: "unchanged",
		needsPackageManifest: !packageState.exists,
		needsRuntimeDependency: !packageState.hasRuntime,
	});
}

export interface ProjectInitializerDependencies {
	readonly createFile?: (path: string, content: string) => Promise<void>;
}

async function createProjectFile(path: string, content: string): Promise<void> {
	await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

async function rejectExistingConfig(root: string): Promise<void> {
	for (const name of CONFIG_FILE_NAMES) {
		const path = join(root, name);
		if (await pathExists(path)) {
			throw new CliProjectConflictError(
				`Refusing to replace existing localhost2137 config: ${name}`,
			);
		}
	}
}

type GitignoreState =
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "unchanged" }>
	| Readonly<{ content: string; kind: "update"; mode: number; updated: string }>;

async function inspectGitignore(path: string): Promise<GitignoreState> {
	const metadata = await lstatIfPresent(path);
	if (!metadata) return Object.freeze({ kind: "missing" });
	if (!metadata.isFile()) {
		throw new CliProjectConflictError("Refusing to replace .gitignore because it is not a file.");
	}
	const content = await readFile(path, "utf8");
	if (hasEffectiveIgnoreEntry(content)) return Object.freeze({ kind: "unchanged" });
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const separator = content.length === 0 || content.endsWith("\n") ? "" : newline;
	return Object.freeze({
		content,
		kind: "update",
		mode: metadata.mode & 0o777,
		updated: `${content}${separator}${IGNORE_ENTRY}${newline}`,
	});
}

function hasEffectiveIgnoreEntry(content: string): boolean {
	let ignored = false;
	for (const line of content.split(/\r?\n/u)) {
		const value = line.trim();
		if ([IGNORE_ENTRY, ".localhost2137", `/${IGNORE_ENTRY}`, "/.localhost2137"].includes(value)) {
			ignored = true;
		} else if (
			[`!${IGNORE_ENTRY}`, "!.localhost2137", `!/${IGNORE_ENTRY}`, "!/.localhost2137"].includes(
				value,
			)
		) {
			ignored = false;
		}
	}
	return ignored;
}

async function replaceUnchangedFile(
	path: string,
	expected: string,
	updated: string,
	mode: number,
): Promise<void> {
	const temporaryPath = `${path}.localhost2137-${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, updated, { encoding: "utf8", flag: "wx", mode });
		if ((await readFile(path, "utf8")) !== expected) {
			throw new CliProjectConflictError(".gitignore changed while localhost init was running.");
		}
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function rollbackConfig(path: string): Promise<void> {
	try {
		if ((await readFile(path, "utf8")) === CONFIG_CONTENT) await rm(path);
	} catch {
		// Preserve the original failure; a changed config is deliberately left in place.
	}
}

async function inspectPackage(
	root: string,
): Promise<Readonly<{ exists: boolean; hasRuntime: boolean }>> {
	const path = join(root, "package.json");
	const metadata = await lstatIfPresent(path);
	if (!metadata?.isFile())
		return Object.freeze({ exists: metadata !== undefined, hasRuntime: false });
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(value)) return Object.freeze({ exists: true, hasRuntime: false });
		const sections = [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		];
		return Object.freeze({
			exists: true,
			hasRuntime: sections.some((section) => {
				const dependencies = value[section];
				return isRecord(dependencies) && typeof dependencies.localhost2137 === "string";
			}),
		});
	} catch {
		return Object.freeze({ exists: true, hasRuntime: false });
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
	return (await lstatIfPresent(path)) !== undefined;
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (cause) {
		if (isMissingPathError(cause)) return undefined;
		throw cause;
	}
}

function isMissingPathError(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value.code === "ENOENT" || value.code === "ENOTDIR")
	);
}
