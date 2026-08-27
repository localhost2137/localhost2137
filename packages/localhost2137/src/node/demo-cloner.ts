import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CliDemoClone } from "../cli/cli-actions.js";
import { CliDemoNotFoundError, CliUsageError } from "../cli/cli-errors.js";
import { syncDirectory } from "./atomic-file.js";
import { runChildCommand } from "./child-command.js";
import { EMBEDDED_DEMO_NAMES, findEmbeddedDemo, type EmbeddedDemo } from "./demo-registry.js";
import { hasCode } from "./project-init-file.js";
import { acquireStorageLock, type StorageLock } from "./storage-lock.js";

export interface CloneDemoProjectInput {
	readonly cwd: string;
	readonly directory?: string;
	readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
	readonly install: boolean;
	readonly name: string;
}

export interface CloneDemoProjectDependencies {
	readonly findDemo?: typeof findEmbeddedDemo;
	readonly runChild?: typeof runChildCommand;
}

interface OwnedDirectory {
	readonly identity: DirectoryIdentity;
	readonly path: string;
}

interface DirectoryIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface CloneTarget {
	readonly directory: string;
	readonly parent: OwnedDirectory;
	readonly path: string;
}

class DemoCloneCommittedError extends Error {
	declare readonly cause: unknown;

	constructor(path: string, cause: unknown) {
		super(`Demo was cloned to ${path}, but its parent directory could not be synced.`);
		this.name = "DemoCloneCommittedError";
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

/** Copies one embedded demo through a private sibling stage and never replaces an existing target. */
export async function cloneDemoProject(
	input: CloneDemoProjectInput,
	dependencies: CloneDemoProjectDependencies = {},
): Promise<CliDemoClone> {
	const demo = (dependencies.findDemo ?? findEmbeddedDemo)(input.name);
	if (!demo) throw new CliDemoNotFoundError(input.name, EMBEDDED_DEMO_NAMES);
	const target = await resolveCloneTarget(input.cwd, input.directory ?? demo.name);
	const lock = await acquireCloneLock(input.cwd, target.path);
	let stage: OwnedDirectory | undefined;
	let primary: unknown;
	let published = false;
	let result: CliDemoClone | undefined;
	try {
		await assertTargetAvailable(target);
		stage = await createStage(target);
		await copyDemoAssets(demo, stage.path);
		if (input.install) {
			await installDependencies(stage.path, input.inheritedEnv, dependencies.runChild);
		}
		await assertOwnedDirectory(stage);
		await chmod(stage.path, 0o755);
		await assertOwnedDirectory(stage);
		await assertTargetAvailable(target);
		try {
			await rename(stage.path, target.path);
		} catch (cause) {
			if (
				hasCode(cause, "EEXIST") ||
				hasCode(cause, "EISDIR") ||
				hasCode(cause, "ENOTDIR") ||
				hasCode(cause, "ENOTEMPTY")
			) {
				throw targetConflict(target.directory, cause);
			}
			throw cause;
		}
		published = true;
		stage = undefined;
		try {
			await syncDirectory(target.parent.path);
		} catch (cause) {
			throw new DemoCloneCommittedError(target.path, cause);
		}
		result = Object.freeze({ directory: target.directory, installed: input.install });
	} catch (cause) {
		primary = cause;
	}
	const cleanup: unknown[] = [];
	if (stage) await removeOwnedDirectory(stage).catch((cause: unknown) => cleanup.push(cause));
	await lock.release().catch((cause: unknown) => cleanup.push(cause));
	if (primary !== undefined) {
		if (cleanup.length === 0) throw primary;
		throw new AggregateError(
			[primary, ...cleanup],
			published
				? "Demo was cloned, but clone bookkeeping cleanup failed."
				: "Demo clone failed and owned staging cleanup also failed.",
		);
	}
	if (cleanup.length > 0) {
		throw new AggregateError(cleanup, "Demo was cloned, but clone bookkeeping cleanup failed.");
	}
	if (!result) throw new Error("Demo clone completed without a result.");
	return result;
}

async function resolveCloneTarget(cwd: string, directory: string): Promise<CloneTarget> {
	if (
		directory === "" ||
		directory.includes("\0") ||
		directory.split(sep).includes("..") ||
		isAbsolute(directory)
	) {
		throw new CliUsageError("Demo directory must be a non-empty relative path.");
	}
	const root = await realpath(cwd);
	const targetPath = resolve(root, directory);
	const relativePath = relative(root, targetPath);
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
		throw new CliUsageError("Demo directory must stay beneath the current directory.");
	}
	const parentPath = dirname(targetPath);
	let canonicalParent: string;
	try {
		canonicalParent = await realpath(parentPath);
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) {
			throw new CliUsageError("Demo directory parent must already exist.", { cause });
		}
		throw cause;
	}
	if (canonicalParent !== parentPath) {
		throw new CliUsageError("Demo directory parent must not contain symbolic links.");
	}
	const parentMetadata = await lstat(parentPath, { bigint: true });
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
		throw new CliUsageError("Demo directory parent must be a real directory.");
	}
	return Object.freeze({
		directory: `./${relativePath.split(sep).join("/")}`,
		parent: Object.freeze({ identity: identity(parentMetadata), path: parentPath }),
		path: targetPath,
	});
}

async function acquireCloneLock(cwd: string, targetPath: string): Promise<StorageLock> {
	const root = await realpath(cwd);
	const targetKey = createHash("sha256").update(targetPath).digest("hex");
	const lockPath = join(root, `.localhost2137.demo-clone-${targetKey}.lock`);
	try {
		return await acquireStorageLock({ lock: lockPath, root }, { ownerToken: () => randomUUID() });
	} catch (cause) {
		if (cause instanceof Error && cause.name === "StorageLockError") {
			throw new CliUsageError(
				`Another clone may own this destination. Resolve the lock at ${lockPath} and retry.`,
				{ cause },
			);
		}
		throw cause;
	}
}

async function assertTargetAvailable(target: CloneTarget): Promise<void> {
	let parentMetadata: BigIntStats;
	try {
		parentMetadata = await lstat(target.parent.path, { bigint: true });
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) {
			throw new CliUsageError("Demo directory parent changed while cloning.", { cause });
		}
		throw cause;
	}
	if (!parentMetadata.isDirectory() || !sameIdentity(parentMetadata, target.parent.identity)) {
		throw new CliUsageError("Demo directory parent changed while cloning.");
	}
	try {
		await lstat(target.path, { bigint: true });
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return;
		throw cause;
	}
	throw targetConflict(target.directory);
}

async function createStage(target: CloneTarget): Promise<OwnedDirectory> {
	const targetKey = createHash("sha256").update(target.path).digest("hex");
	const path = await mkdtemp(join(target.parent.path, `.localhost2137.demo-${targetKey}-`));
	const metadata = await lstat(path, { bigint: true });
	return Object.freeze({ identity: identity(metadata), path });
}

async function copyDemoAssets(demo: EmbeddedDemo, stage: string): Promise<void> {
	const assetRoot = await realpath(demo.assetDirectory);
	for (const asset of demo.assets) {
		const source = resolve(assetRoot, asset.source);
		const target = resolve(stage, asset.target);
		assertContained(assetRoot, source, "Demo asset source");
		assertContained(stage, target, "Demo asset target");
		const canonicalSource = await realpath(source);
		assertContained(assetRoot, canonicalSource, "Demo asset source");
		const metadata = await lstat(source);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(`Embedded demo asset must be a regular file: ${asset.source}`);
		}
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target, constants.COPYFILE_EXCL);
	}
}

async function installDependencies(
	directory: string,
	inheritedEnv: Readonly<Record<string, string | undefined>>,
	runChild: typeof runChildCommand = runChildCommand,
): Promise<void> {
	const exitCode = await runChild({
		argv: ["pnpm", "install"],
		connectionEnv: {},
		cwd: directory,
		inheritedEnv,
	});
	if ([129, 130, 143].includes(exitCode)) {
		const interruption = new Error("Dependency installation was interrupted.");
		interruption.name = "SignalInterruption";
		throw interruption;
	}
	if (exitCode !== 0) {
		throw new Error(`pnpm install exited with code ${exitCode}; the demo was not published.`);
	}
}

async function removeOwnedDirectory(directory: OwnedDirectory): Promise<void> {
	let metadata: BigIntStats;
	try {
		metadata = await lstat(directory.path, { bigint: true });
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return;
		throw cause;
	}
	if (!metadata.isDirectory() || !sameIdentity(metadata, directory.identity)) {
		throw new Error(`Refusing to remove replaced demo staging path: ${directory.path}`);
	}
	await rm(directory.path, { recursive: true });
}

async function assertOwnedDirectory(directory: OwnedDirectory): Promise<void> {
	let metadata: BigIntStats;
	try {
		metadata = await lstat(directory.path, { bigint: true });
	} catch (cause) {
		throw new Error(`Demo staging path changed while cloning: ${directory.path}`, { cause });
	}
	if (!metadata.isDirectory() || !sameIdentity(metadata, directory.identity)) {
		throw new Error(`Demo staging path changed while cloning: ${directory.path}`);
	}
}

function targetConflict(directory: string, cause?: unknown): CliUsageError {
	return new CliUsageError(`Refusing to replace existing demo directory: ${directory}`, { cause });
}

function assertContained(root: string, path: string, label: string): void {
	const child = relative(root, path);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error(`${label} escapes its root: ${path}`);
	}
}

function identity(metadata: BigIntStats): DirectoryIdentity {
	return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function sameIdentity(metadata: BigIntStats, expected: DirectoryIdentity): boolean {
	return metadata.dev === expected.dev && metadata.ino === expected.ino;
}
