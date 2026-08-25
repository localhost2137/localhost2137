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

export async function writeTextAtomically(
	filePath: string,
	content: string,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const fileSystem = options.fileSystem ?? nodeAtomicWriteFileSystem;
	const token = options.token?.() ?? `${process.pid}-${randomUUID()}`;
	const temporaryPath = `${filePath}.tmp-${token}`;
	let handle: AtomicFileHandle | undefined;
	try {
		handle = await fileSystem.open(
			temporaryPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			options.mode,
		);
		await handle.writeFile(content, { encoding: "utf8" });
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fileSystem.rename(temporaryPath, filePath);
		await syncDirectory(fileSystem, dirname(filePath));
	} catch (cause) {
		await closeAfterFailure(handle, cause);
		await removeTemporaryFile(fileSystem, temporaryPath, cause);
		throw cause;
	}
}

export async function writeJsonAtomically(
	filePath: string,
	value: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await writeTextAtomically(filePath, `${JSON.stringify(value, undefined, 2)}\n`, options);
}

async function syncDirectory(fileSystem: AtomicWriteFileSystem, directory: string): Promise<void> {
	let handle: AtomicFileHandle | undefined;
	try {
		handle = await fileSystem.open(directory, constants.O_RDONLY);
		await handle.sync();
		await handle.close();
	} catch (cause) {
		if (handle) await handle.close().catch(() => undefined);
		if (!isUnsupportedDirectorySync(cause)) throw cause;
	}
}

async function closeAfterFailure(
	handle: AtomicFileHandle | undefined,
	primaryCause: unknown,
): Promise<void> {
	if (!handle) return;
	try {
		await handle.close();
	} catch (cleanupCause) {
		attachCleanupCause(primaryCause, cleanupCause);
	}
}

async function removeTemporaryFile(
	fileSystem: AtomicWriteFileSystem,
	temporaryPath: string,
	primaryCause: unknown,
): Promise<void> {
	try {
		await fileSystem.unlink(temporaryPath);
	} catch (cleanupCause) {
		if (!hasCode(cleanupCause, "ENOENT")) attachCleanupCause(primaryCause, cleanupCause);
	}
}

function attachCleanupCause(primaryCause: unknown, cleanupCause: unknown): void {
	if (primaryCause instanceof Error && primaryCause.cause === undefined) {
		Object.defineProperty(primaryCause, "cause", { value: cleanupCause });
	}
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
