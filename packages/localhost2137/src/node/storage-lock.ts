import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { StoragePaths } from "./storage-paths.js";

type StorageLockPaths = Pick<StoragePaths, "lock" | "root">;

const LOCK_SCHEMA_VERSION = 1;
const OWNER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;

interface LockOwner {
	readonly acquiredAt: string;
	readonly ownerToken: string;
	readonly pid: number;
	readonly schemaVersion: 1;
}

export interface StorageLockFileSystem {
	createDirectory(path: string): Promise<void>;
	ensureDirectory(path: string): Promise<void>;
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	readDirectory(path: string): Promise<readonly string[]>;
	removeDirectory(path: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

const nodeStorageLockFileSystem: StorageLockFileSystem = {
	async createDirectory(path) {
		await mkdir(path);
	},
	async ensureDirectory(path) {
		await mkdir(path, { recursive: true });
	},
	open,
	readDirectory: readdir,
	removeDirectory: rmdir,
	unlink,
};

export interface StorageLockOptions {
	readonly fileSystem?: StorageLockFileSystem;
	readonly isProcessAlive?: (pid: number) => Promise<boolean>;
	readonly now?: () => Date;
	readonly ownerToken?: () => string;
}

type StorageLockErrorCode = "LOCKED" | "LOCK_CORRUPT" | "LOCK_OWNERSHIP_LOST" | "LOCK_STALE";

class StorageLockError extends Error {
	readonly code: StorageLockErrorCode;
	readonly owner?: Readonly<{ acquiredAt: string; pid: number }>;

	constructor(
		code: StorageLockErrorCode,
		message: string,
		owner?: Readonly<{ acquiredAt: string; pid: number }>,
	) {
		super(message);
		this.name = "StorageLockError";
		this.code = code;
		if (owner) this.owner = Object.freeze(owner);
	}
}

export class StorageLock {
	readonly #fileSystem: StorageLockFileSystem;
	readonly #lockPath: string;
	readonly #ownerPath: string;
	#released = false;

	constructor(input: {
		readonly fileSystem: StorageLockFileSystem;
		readonly lockPath: string;
		readonly ownerPath: string;
	}) {
		this.#fileSystem = input.fileSystem;
		this.#lockPath = input.lockPath;
		this.#ownerPath = input.ownerPath;
	}

	async release(): Promise<void> {
		if (this.#released) return;
		try {
			await this.#fileSystem.unlink(this.#ownerPath);
		} catch (cause) {
			if (hasCode(cause, "ENOENT")) throw ownershipLost(this.#lockPath);
			throw cause;
		}
		try {
			await this.#fileSystem.removeDirectory(this.#lockPath);
		} catch (cause) {
			if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTEMPTY")) {
				throw ownershipLost(this.#lockPath);
			}
			throw cause;
		}
		this.#released = true;
	}
}

export async function acquireStorageLock(
	paths: StorageLockPaths,
	options: StorageLockOptions = {},
): Promise<StorageLock> {
	const fileSystem = options.fileSystem ?? nodeStorageLockFileSystem;
	await fileSystem.ensureDirectory(paths.root);
	const now = options.now ?? (() => new Date());
	const isProcessAlive = options.isProcessAlive ?? nodeProcessIsAlive;
	const ownerToken = options.ownerToken?.() ?? randomUUID();
	assertSafeToken(ownerToken, "ownerToken");
	const owner: LockOwner = {
		acquiredAt: now().toISOString(),
		ownerToken,
		pid: process.pid,
		schemaVersion: LOCK_SCHEMA_VERSION,
	};
	const ownerPath = resolve(paths.lock, ownerToken);

	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await fileSystem.createDirectory(paths.lock);
		} catch (cause) {
			if (!hasCode(cause, "EEXIST")) throw cause;
			const observed = await observeLockOwner(fileSystem, paths.lock);
			if (!observed) continue;
			if (observed.kind === "corrupt") {
				throw corruptLock(paths.lock, observed.reason);
			}
			if (await isProcessAlive(observed.owner.pid)) {
				throw new StorageLockError(
					"LOCKED",
					`Storage root is already locked by process ${observed.owner.pid} since ${observed.owner.acquiredAt}.`,
					{ acquiredAt: observed.owner.acquiredAt, pid: observed.owner.pid },
				);
			}
			throw new StorageLockError("LOCK_STALE", staleLockMessage(paths.lock, observed.owner), {
				acquiredAt: observed.owner.acquiredAt,
				pid: observed.owner.pid,
			});
		}

		try {
			await createOwnerFile(fileSystem, ownerPath, owner);
		} catch (cause) {
			await fileSystem.removeDirectory(paths.lock).catch(() => undefined);
			throw cause;
		}
		return new StorageLock({ fileSystem, lockPath: paths.lock, ownerPath });
	}

	throw new StorageLockError(
		"LOCKED",
		`Storage lock ${paths.lock} changed repeatedly while acquiring it; retry the command.`,
	);
}

type LockObservation =
	| Readonly<{ kind: "corrupt"; reason: string }>
	| Readonly<{ kind: "owned"; owner: LockOwner }>;

async function observeLockOwner(
	fileSystem: StorageLockFileSystem,
	lockPath: string,
): Promise<LockObservation | undefined> {
	let entries: readonly string[];
	try {
		entries = await fileSystem.readDirectory(lockPath);
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return undefined;
		if (hasCode(cause, "ENOTDIR")) {
			return { kind: "corrupt", reason: "it uses the obsolete lock-file format" };
		}
		throw cause;
	}
	if (entries.length !== 1) {
		return {
			kind: "corrupt",
			reason:
				entries.length === 0 ? "its owner record is missing" : "it contains multiple owner records",
		};
	}
	const ownerToken = entries[0];
	if (!ownerToken || !OWNER_TOKEN_PATTERN.test(ownerToken)) {
		return { kind: "corrupt", reason: "its owner record name is invalid" };
	}
	const owner = await readOwnerFile(fileSystem, resolve(lockPath, ownerToken));
	if (owner === undefined) return undefined;
	if (owner === null) {
		return { kind: "corrupt", reason: "its owner record metadata is invalid" };
	}
	if (owner.ownerToken !== ownerToken) {
		return { kind: "corrupt", reason: "its owner record identity does not match its name" };
	}
	return { kind: "owned", owner };
}

async function readOwnerFile(
	fileSystem: StorageLockFileSystem,
	ownerPath: string,
): Promise<LockOwner | null | undefined> {
	let handle: FileHandle;
	try {
		handle = await fileSystem.open(ownerPath, constants.O_RDONLY);
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return undefined;
		throw cause;
	}
	try {
		const before = await handle.stat();
		const bytes = await handle.readFile("utf8");
		const after = await handle.stat();
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.mtimeMs !== after.mtimeMs ||
			before.size !== after.size
		) {
			return undefined;
		}
		return parseLockOwner(bytes) ?? null;
	} finally {
		await handle.close();
	}
}

async function createOwnerFile(
	fileSystem: StorageLockFileSystem,
	path: string,
	owner: LockOwner,
): Promise<void> {
	const handle = await fileSystem.open(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
		0o600,
	);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.sync();
	} catch (cause) {
		await handle.close().catch(() => undefined);
		await fileSystem.unlink(path).catch(() => undefined);
		throw cause;
	}
	await handle.close();
}

function parseLockOwner(bytes: string): LockOwner | undefined {
	try {
		const value: unknown = JSON.parse(bytes);
		if (
			isUnknownRecord(value) &&
			value.schemaVersion === LOCK_SCHEMA_VERSION &&
			typeof value.pid === "number" &&
			Number.isSafeInteger(value.pid) &&
			value.pid > 0 &&
			typeof value.ownerToken === "string" &&
			OWNER_TOKEN_PATTERN.test(value.ownerToken) &&
			isCanonicalTimestamp(value.acquiredAt)
		) {
			return {
				acquiredAt: value.acquiredAt,
				ownerToken: value.ownerToken,
				pid: value.pid,
				schemaVersion: LOCK_SCHEMA_VERSION,
			};
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertSafeToken(value: string, label: string): void {
	if (!OWNER_TOKEN_PATTERN.test(value)) {
		throw new TypeError(`Storage lock ${label} must be a path-safe opaque identifier.`);
	}
}

function corruptLock(lockPath: string, reason: string): StorageLockError {
	return new StorageLockError(
		"LOCK_CORRUPT",
		`Storage lock ${lockPath} is incomplete or damaged because ${reason}. Retry if another runtime is starting. If the error persists, confirm that no runtime uses this storage root, remove that exact lock path explicitly, and retry.`,
	);
}

function staleLockMessage(lockPath: string, owner: LockOwner): string {
	return `Storage lock ${lockPath} belongs to stopped process ${owner.pid} (acquired ${owner.acquiredAt}). Automatic takeover is disabled because replacing a lock path cannot be made conditional with the Node filesystem API. Confirm that no runtime uses this storage root, remove that exact lock path explicitly, and retry.`;
}

function ownershipLost(lockPath: string): StorageLockError {
	return new StorageLockError(
		"LOCK_OWNERSHIP_LOST",
		`Storage lock ${lockPath} changed ownership; refusing to release it.`,
	);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

async function nodeProcessIsAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		if (hasCode(cause, "ESRCH")) return false;
		if (hasCode(cause, "EPERM")) return true;
		throw cause;
	}
}

function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}
