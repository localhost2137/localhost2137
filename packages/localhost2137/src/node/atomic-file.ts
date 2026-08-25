import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicFileHandle {
	close(): Promise<void>;
	sync(): Promise<void>;
	writeFile(data: string, options: Readonly<{ encoding: "utf8" }>): Promise<void>;
}

export interface AtomicWriteFileSystem {
	open(path: string, flags: number, mode?: number): Promise<AtomicFileHandle>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

const nodeAtomicWriteFileSystem: AtomicWriteFileSystem = { open, rename, unlink };

export interface AtomicWriteOptions {
	readonly fileSystem?: AtomicWriteFileSystem;
	readonly mode?: number;
	readonly token?: () => string;
}

export type AtomicWritePhase =
	| "close_temporary"
	| "open_temporary"
	| "rename"
	| "sync_directory"
	| "sync_temporary"
	| "write_temporary";

export interface AtomicWriteOutcome {
	readonly commitState: "committed";
	readonly directorySync: "synced" | "unsupported";
}

export class AtomicWriteError extends Error {
	override readonly cause: unknown;
	readonly cleanupFailures: readonly unknown[];
	readonly commitState: "committed" | "not_committed";
	readonly filePath: string;
	readonly phase: AtomicWritePhase;

	constructor(input: {
		readonly cause: unknown;
		readonly cleanupFailures: readonly unknown[];
		readonly commitState: "committed" | "not_committed";
		readonly filePath: string;
		readonly phase: AtomicWritePhase;
	}) {
		super(
			input.commitState === "committed"
				? `Atomic replacement of ${input.filePath} committed, but its directory sync failed.`
				: `Atomic replacement of ${input.filePath} failed before commit.`,
		);
		this.name = "AtomicWriteError";
		this.cause = input.cause;
		this.cleanupFailures = Object.freeze([...input.cleanupFailures]);
		this.commitState = input.commitState;
		this.filePath = input.filePath;
		this.phase = input.phase;
	}
}

export async function writeTextAtomically(
	filePath: string,
	content: string,
	options: AtomicWriteOptions = {},
): Promise<AtomicWriteOutcome> {
	const fileSystem = options.fileSystem ?? nodeAtomicWriteFileSystem;
	const token = options.token?.() ?? `${process.pid}-${randomUUID()}`;
	const temporaryPath = `${filePath}.tmp-${token}`;
	let commitState: "committed" | "not_committed" = "not_committed";
	let handle: AtomicFileHandle | undefined;
	let phase: AtomicWritePhase = "open_temporary";
	try {
		handle = await fileSystem.open(
			temporaryPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			options.mode,
		);
		phase = "write_temporary";
		await handle.writeFile(content, { encoding: "utf8" });
		phase = "sync_temporary";
		await handle.sync();
		phase = "close_temporary";
		await handle.close();
		handle = undefined;
		phase = "rename";
		await fileSystem.rename(temporaryPath, filePath);
		commitState = "committed";
		phase = "sync_directory";
		const directorySync = await syncDirectoryWith(fileSystem, dirname(filePath));
		return Object.freeze({ commitState, directorySync });
	} catch (cause) {
		const cleanupFailures =
			commitState === "committed"
				? []
				: await cleanTemporaryFile(fileSystem, temporaryPath, handle);
		throw new AtomicWriteError({ cause, cleanupFailures, commitState, filePath, phase });
	}
}

export async function writeJsonAtomically(
	filePath: string,
	value: unknown,
	options: AtomicWriteOptions = {},
): Promise<AtomicWriteOutcome> {
	return writeTextAtomically(filePath, `${JSON.stringify(value, undefined, 2)}\n`, options);
}

async function syncDirectoryWith(
	fileSystem: AtomicWriteFileSystem,
	directory: string,
): Promise<"synced" | "unsupported"> {
	let handle: AtomicFileHandle | undefined;
	try {
		handle = await fileSystem.open(directory, constants.O_RDONLY);
		await handle.sync();
		await handle.close();
		return "synced";
	} catch (cause) {
		if (handle) await handle.close().catch(() => undefined);
		if (isUnsupportedDirectorySync(cause)) return "unsupported";
		throw cause;
	}
}

export async function syncDirectory(directory: string): Promise<"synced" | "unsupported"> {
	return syncDirectoryWith(nodeAtomicWriteFileSystem, directory);
}

async function cleanTemporaryFile(
	fileSystem: AtomicWriteFileSystem,
	temporaryPath: string,
	handle: AtomicFileHandle | undefined,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	if (handle) await handle.close().catch((cause: unknown) => failures.push(cause));
	await fileSystem.unlink(temporaryPath).catch((cause: unknown) => {
		if (!hasCode(cause, "ENOENT")) failures.push(cause);
	});
	return failures;
}

function isUnsupportedDirectorySync(value: unknown): boolean {
	return ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].some((code) =>
		hasCode(value, code),
	);
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
