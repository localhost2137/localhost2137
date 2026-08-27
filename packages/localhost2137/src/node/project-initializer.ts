import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CliProjectInitialization } from "../cli/cli-actions.js";
import { CliUsageError } from "../cli/cli-errors.js";
import { CONFIG_FILE_NAMES } from "../config/config-discovery.js";
import {
	closeOwnedProjectFile,
	createOwnedProjectFile,
	assertOwnedProjectFile,
	hasCode,
	hasIdentity,
	lstatIfPresent,
	nodeProjectInitFileSystem,
	type OwnedProjectFile,
	ProjectFileCommittedError,
	type ProjectInitFileSystem,
	removeOwnedProjectFile,
	withCleanup,
} from "./project-init-file.js";
import {
	closeProjectGitignore,
	commitProjectGitignore,
	inspectProjectGitignore,
	type ProjectGitignore,
	rollbackProjectGitignore,
	validateProjectGitignore,
} from "./project-gitignore.js";
import { acquireStorageLock, type StorageLock } from "./storage-lock.js";
import type { StoragePaths } from "./storage-paths.js";

const CONFIG_FILE_NAME = "localhost.config.ts";
const CONFIG_CONTENT = `import { defineConfig } from "localhost2137";\n\nexport default defineConfig({\n\tservices: {},\n});\n`;
const LOCK_FILE_NAME = ".localhost2137.init.lock";

export interface ProjectInitializerOptions {
	readonly fileSystem?: ProjectInitFileSystem;
	readonly ownerToken?: () => string;
}

/** Creates a minimal config and ignore entry without touching package metadata. */
export async function initializeProject(
	cwd: string,
	options: ProjectInitializerOptions = {},
): Promise<CliProjectInitialization> {
	const fileSystem = options.fileSystem ?? nodeProjectInitFileSystem;
	const lock = await acquireInitLock(cwd, options.ownerToken?.() ?? randomUUID());
	let config: OwnedProjectFile | undefined;
	let gitignore: ProjectGitignore | undefined;
	let committed = false;
	let lockReleaseAttempted = false;
	try {
		await validateConfigAliases(cwd, fileSystem);
		gitignore = await inspectProjectGitignore(join(cwd, ".gitignore"), fileSystem);
		config = await createConfig(cwd, fileSystem);
		await validateConfigAliases(cwd, fileSystem, config);
		await assertOwnedProjectFile(config, fileSystem);
		const gitignoreResult = await commitProjectGitignore(gitignore, fileSystem);
		await validateConfigAliases(cwd, fileSystem, config);
		await assertOwnedProjectFile(config, fileSystem);
		await validateProjectGitignore(gitignore, fileSystem);
		committed = true;

		const cleanup = await closeScaffoldFiles(config, gitignore);
		lockReleaseAttempted = true;
		await lock.release().catch((cause: unknown) => cleanup.push(cause));
		if (cleanup.length > 0) {
			throw new AggregateError(
				cleanup,
				"localhost init created the project files, but cleanup did not complete.",
			);
		}
		return Object.freeze({ gitignore: gitignoreResult });
	} catch (cause) {
		if (committed || cause instanceof ProjectFileCommittedError) {
			const cleanup = await closeScaffoldFiles(config, gitignore);
			if (cause instanceof ProjectFileCommittedError && !cause.owned.closed) {
				await closeOwnedProjectFile(cause.owned).catch((failure: unknown) => cleanup.push(failure));
			}
			if (!lockReleaseAttempted) {
				await lock.release().catch((failure: unknown) => cleanup.push(failure));
			}
			throw withCleanup(cause, cleanup);
		}
		const rollback = await rollbackScaffold(config, gitignore, fileSystem);
		await lock.release().catch((failure: unknown) => rollback.push(failure));
		throw withCleanup(cause, rollback);
	}
}

async function createConfig(
	root: string,
	fileSystem: ProjectInitFileSystem,
): Promise<OwnedProjectFile> {
	try {
		return await createOwnedProjectFile(
			join(root, CONFIG_FILE_NAME),
			CONFIG_CONTENT,
			0o644,
			fileSystem,
		);
	} catch (cause) {
		if (hasCode(cause, "EEXIST")) {
			throw new CliUsageError("localhost.config.ts appeared while localhost init was running.");
		}
		throw cause;
	}
}

async function acquireInitLock(root: string, ownerToken: string): Promise<StorageLock> {
	const paths: StoragePaths = {
		controlToken: join(root, ".localhost2137.init-control-token"),
		instances: join(root, ".localhost2137.init-instances"),
		lock: join(root, LOCK_FILE_NAME),
		root,
		runtime: join(root, ".localhost2137.init-runtime"),
		trash: join(root, ".localhost2137.init-trash"),
	};
	try {
		return await acquireStorageLock(paths, { ownerToken: () => ownerToken });
	} catch (cause) {
		if (isStorageLockFailure(cause)) {
			throw new CliUsageError(
				`Another localhost init may be running. If not, remove ${LOCK_FILE_NAME} and retry.`,
				{ cause },
			);
		}
		throw cause;
	}
}

function isStorageLockFailure(value: unknown): boolean {
	return value instanceof Error && value.name === "StorageLockError";
}

async function validateConfigAliases(
	root: string,
	fileSystem: ProjectInitFileSystem,
	owned?: OwnedProjectFile,
): Promise<void> {
	for (const name of CONFIG_FILE_NAMES) {
		const metadata = await lstatIfPresent(join(root, name), fileSystem);
		if (name === CONFIG_FILE_NAME && owned && metadata) {
			if (hasIdentity(metadata, owned.identity)) continue;
			throw new CliUsageError("localhost.config.ts changed while localhost init was running.");
		}
		if (metadata) {
			throw new CliUsageError(`Refusing to replace existing localhost2137 config: ${name}`);
		}
		if (name === CONFIG_FILE_NAME && owned) {
			throw new CliUsageError("localhost.config.ts disappeared while localhost init was running.");
		}
	}
}

async function closeScaffoldFiles(
	config: OwnedProjectFile | undefined,
	gitignore: ProjectGitignore | undefined,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	if (gitignore && "handle" in gitignore && !gitignore.closed) {
		await closeProjectGitignore(gitignore).catch((cause: unknown) => failures.push(cause));
	}
	if (gitignore && !("handle" in gitignore) && gitignore.created && !gitignore.created.closed) {
		await closeOwnedProjectFile(gitignore.created).catch((cause: unknown) => failures.push(cause));
	}
	if (config && !config.closed) {
		await closeOwnedProjectFile(config).catch((cause: unknown) => failures.push(cause));
	}
	return failures;
}

async function rollbackScaffold(
	config: OwnedProjectFile | undefined,
	gitignore: ProjectGitignore | undefined,
	fileSystem: ProjectInitFileSystem,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	if (gitignore && "handle" in gitignore) {
		failures.push(...(await rollbackProjectGitignore(gitignore)));
	}
	if (gitignore && !("handle" in gitignore) && gitignore.created) {
		failures.push(...(await removeOwnedProjectFile(gitignore.created, fileSystem)));
	}
	if (config) failures.push(...(await removeOwnedProjectFile(config, fileSystem)));
	if (gitignore && "handle" in gitignore && !gitignore.closed) {
		await closeProjectGitignore(gitignore).catch((cause: unknown) => failures.push(cause));
	}
	return failures;
}
