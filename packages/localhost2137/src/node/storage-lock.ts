import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { StoragePaths } from "./storage-paths.js";

const LOCK_SCHEMA_VERSION = 1;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const OWNER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;

interface LockOwner {
	readonly acquiredAt: string;
	readonly ownerToken: string;
	readonly pid: number;
	readonly schemaVersion: 1;
}

interface LockFileIdentity {
	readonly device: number;
	readonly inode: number;
}

interface ObservedLock {
	readonly bytes: string;
	readonly identity: LockFileIdentity;
	readonly modifiedAtMs: number;
	readonly owner?: LockOwner;
}

export interface StorageLockFileSystem {
	link(existingPath: string, newPath: string): Promise<void>;
	mkdir(path: string, options: Readonly<{ recursive: true }>): Promise<string | undefined>;
	open(path: string, flags: number, mode?: number): Promise<FileHandle>;
	unlink(path: string): Promise<void>;
}

const nodeStorageLockFileSystem: StorageLockFileSystem = { link, mkdir, open, unlink };

export interface StorageLockOptions {
	readonly fileSystem?: StorageLockFileSystem;
	readonly isProcessAlive?: (pid: number) => Promise<boolean>;
	readonly now?: () => Date;
	readonly ownerToken?: () => string;
	readonly quarantineToken?: () => string;
}

export class StorageLockError extends Error {
	readonly code: "LOCKED" | "LOCK_CORRUPT" | "LOCK_OWNERSHIP_LOST";
	readonly owner?: Readonly<{ acquiredAt: string; pid: number }>;

	constructor(
		code: "LOCKED" | "LOCK_CORRUPT" | "LOCK_OWNERSHIP_LOST",
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
	readonly #ownerToken: string;
	readonly #quarantineDirectory: string;
	readonly #quarantineToken: () => string;
	#released = false;

	constructor(input: {
		readonly fileSystem: StorageLockFileSystem;
		readonly lockPath: string;
		readonly ownerToken: string;
		readonly quarantineDirectory: string;
		readonly quarantineToken: () => string;
	}) {
		this.#fileSystem = input.fileSystem;
		this.#lockPath = input.lockPath;
		this.#ownerToken = input.ownerToken;
		this.#quarantineDirectory = input.quarantineDirectory;
		this.#quarantineToken = input.quarantineToken;
	}

	async release(): Promise<void> {
		if (this.#released) return;
		const observed = await observeIfPresent(this.#fileSystem, this.#lockPath);
		if (!observed) {
			this.#released = true;
			return;
		}
		if (observed.owner?.ownerToken !== this.#ownerToken) {
			throw ownershipLost(this.#lockPath);
		}
		const removed = await quarantineObservedLock(
			this.#fileSystem,
			this.#lockPath,
			this.#quarantineDirectory,
			observed,
			this.#quarantineToken(),
		);
		if (!removed) throw ownershipLost(this.#lockPath);
		this.#released = true;
	}
}

export async function acquireStorageLock(
	paths: StoragePaths,
	options: StorageLockOptions = {},
): Promise<StorageLock> {
	const fileSystem = options.fileSystem ?? nodeStorageLockFileSystem;
	const lockQuarantineDirectory = resolve(paths.trash, "locks");
	await fileSystem.mkdir(paths.root, { recursive: true });
	await fileSystem.mkdir(lockQuarantineDirectory, { recursive: true });
	const now = options.now ?? (() => new Date());
	const isProcessAlive = options.isProcessAlive ?? nodeProcessIsAlive;
	const ownerToken = options.ownerToken?.() ?? randomUUID();
	const quarantineToken = options.quarantineToken ?? randomUUID;
	assertSafeToken(ownerToken, "ownerToken");
	const owner: LockOwner = {
		acquiredAt: now().toISOString(),
		ownerToken,
		pid: process.pid,
		schemaVersion: LOCK_SCHEMA_VERSION,
	};

	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await createLockFile(fileSystem, paths.lock, owner);
			return new StorageLock({
				fileSystem,
				lockPath: paths.lock,
				ownerToken,
				quarantineDirectory: lockQuarantineDirectory,
				quarantineToken,
			});
		} catch (cause) {
			if (!hasCode(cause, "EEXIST")) throw cause;
		}
		const observed = await observeIfPresent(fileSystem, paths.lock);
		if (!observed) continue;
		if (!observed.owner) {
			if (now().getTime() - observed.modifiedAtMs < INCOMPLETE_LOCK_GRACE_MS) {
				throw new StorageLockError(
					"LOCK_CORRUPT",
					`Storage lock ${paths.lock} is incomplete; retry after its initialization grace period.`,
				);
			}
			await quarantineObservedLock(
				fileSystem,
				paths.lock,
				lockQuarantineDirectory,
				observed,
				quarantineToken(),
			);
			continue;
		}
		if (await isProcessAlive(observed.owner.pid)) {
			throw new StorageLockError(
				"LOCKED",
				`Storage root is already locked by process ${observed.owner.pid} since ${observed.owner.acquiredAt}.`,
				{ acquiredAt: observed.owner.acquiredAt, pid: observed.owner.pid },
			);
		}
		await quarantineObservedLock(
			fileSystem,
			paths.lock,
			lockQuarantineDirectory,
			observed,
			quarantineToken(),
		);
	}
	throw new StorageLockError(
		"LOCKED",
		`Storage lock ${paths.lock} changed repeatedly while acquiring it; retry the command.`,
	);
}

async function observeIfPresent(
	fileSystem: StorageLockFileSystem,
	lockPath: string,
): Promise<ObservedLock | undefined> {
	let handle: FileHandle;
	try {
		handle = await fileSystem.open(lockPath, constants.O_RDONLY);
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
		const owner = parseLockOwner(bytes);
		return {
			bytes,
			identity: { device: after.dev, inode: after.ino },
			modifiedAtMs: after.mtimeMs,
			...(owner ? { owner } : {}),
		};
	} finally {
		await handle.close();
	}
}

async function quarantineObservedLock(
	fileSystem: StorageLockFileSystem,
	lockPath: string,
	quarantineDirectory: string,
	observed: ObservedLock,
	quarantineToken: string,
): Promise<boolean> {
	assertSafeToken(quarantineToken, "quarantineToken");
	const identity = observed.owner?.ownerToken ?? hashBytes(observed.bytes);
	const quarantinePath = resolve(
		quarantineDirectory,
		`${basename(lockPath)}-${identity}-${quarantineToken}`,
	);
	try {
		await fileSystem.link(lockPath, quarantinePath);
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return false;
		throw cause;
	}
	const linked = await observeIfPresent(fileSystem, quarantinePath);
	if (!linked || !sameObservedLock(observed, linked)) {
		await removeKnownLink(fileSystem, quarantinePath);
		return false;
	}
	const current = await observeIfPresent(fileSystem, lockPath);
	if (!current || !sameObservedLock(observed, current)) return false;
	await fileSystem.unlink(lockPath);
	return true;
}

function sameObservedLock(left: ObservedLock, right: ObservedLock): boolean {
	return (
		left.identity.device === right.identity.device &&
		left.identity.inode === right.identity.inode &&
		left.bytes === right.bytes &&
		left.owner?.ownerToken === right.owner?.ownerToken
	);
}

async function removeKnownLink(
	fileSystem: StorageLockFileSystem,
	quarantinePath: string,
): Promise<void> {
	await fileSystem.unlink(quarantinePath).catch((cause: unknown) => {
		if (!hasCode(cause, "ENOENT")) throw cause;
	});
}

async function createLockFile(
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

function hashBytes(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
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
