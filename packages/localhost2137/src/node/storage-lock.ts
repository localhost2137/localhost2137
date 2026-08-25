import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { StoragePaths } from "./storage-paths.js";

const LOCK_SCHEMA_VERSION = 1;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

interface LockOwner {
	readonly acquiredAt: string;
	readonly ownerToken: string;
	readonly pid: number;
	readonly schemaVersion: 1;
}

export interface StorageLockOptions {
	readonly isProcessAlive?: (pid: number) => Promise<boolean>;
	readonly now?: () => Date;
	readonly ownerToken?: () => string;
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
	readonly #lockPath: string;
	readonly #ownerToken: string;
	#released = false;

	constructor(lockPath: string, ownerToken: string) {
		this.#lockPath = lockPath;
		this.#ownerToken = ownerToken;
	}

	async release(): Promise<void> {
		if (this.#released) return;
		const owner = await readOwner(this.#lockPath).catch((cause: unknown) => {
			if (hasCode(cause, "ENOENT")) return undefined;
			throw cause;
		});
		if (!owner) {
			this.#released = true;
			return;
		}
		if (owner.ownerToken !== this.#ownerToken) {
			throw new StorageLockError(
				"LOCK_OWNERSHIP_LOST",
				`Storage lock ${this.#lockPath} is owned by another runtime; refusing to release it.`,
			);
		}
		await unlink(this.#lockPath);
		this.#released = true;
	}
}

export async function acquireStorageLock(
	paths: StoragePaths,
	options: StorageLockOptions = {},
): Promise<StorageLock> {
	await mkdir(paths.root, { recursive: true });
	await mkdir(resolve(paths.trash, "locks"), { recursive: true });
	const now = options.now ?? (() => new Date());
	const isProcessAlive = options.isProcessAlive ?? nodeProcessIsAlive;
	const ownerToken = options.ownerToken?.() ?? randomUUID();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(ownerToken)) {
		throw new TypeError("Storage lock ownerToken must be a path-safe opaque identifier.");
	}
	const owner: LockOwner = {
		acquiredAt: now().toISOString(),
		ownerToken,
		pid: process.pid,
		schemaVersion: LOCK_SCHEMA_VERSION,
	};

	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await createLockFile(paths.lock, owner);
			return new StorageLock(paths.lock, ownerToken);
		} catch (cause) {
			if (!hasCode(cause, "EEXIST")) throw cause;
		}
		const observed = await observeLock(paths.lock);
		if (!observed.owner) {
			if (now().getTime() - observed.modifiedAtMs < INCOMPLETE_LOCK_GRACE_MS) {
				throw new StorageLockError(
					"LOCK_CORRUPT",
					`Storage lock ${paths.lock} is incomplete; retry after its initialization grace period.`,
				);
			}
			await quarantineObservedLock(paths, observed);
			continue;
		}
		if (await isProcessAlive(observed.owner.pid)) {
			throw new StorageLockError(
				"LOCKED",
				`Storage root is already locked by process ${observed.owner.pid} since ${observed.owner.acquiredAt}.`,
				{ acquiredAt: observed.owner.acquiredAt, pid: observed.owner.pid },
			);
		}
		await quarantineObservedLock(paths, observed);
	}
	throw new StorageLockError(
		"LOCKED",
		`Storage lock ${paths.lock} changed repeatedly while acquiring it; retry the command.`,
	);
}

interface ObservedLock {
	readonly bytes: string;
	readonly modifiedAtMs: number;
	readonly owner?: LockOwner;
}

async function observeLock(lockPath: string): Promise<ObservedLock> {
	const [bytes, fileStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
	const owner = parseLockOwner(bytes);
	return { bytes, modifiedAtMs: fileStat.mtimeMs, ...(owner ? { owner } : {}) };
}

async function readOwner(lockPath: string): Promise<LockOwner> {
	const owner = parseLockOwner(await readFile(lockPath, "utf8"));
	if (!owner) {
		throw new StorageLockError(
			"LOCK_OWNERSHIP_LOST",
			`Storage lock ${lockPath} no longer contains valid ownership metadata.`,
		);
	}
	return owner;
}

async function quarantineObservedLock(paths: StoragePaths, observed: ObservedLock): Promise<void> {
	const identity =
		observed.owner?.ownerToken ?? createHash("sha256").update(observed.bytes).digest("hex");
	const quarantinePath = resolve(paths.trash, "locks", `${basename(paths.lock)}-${identity}`);
	try {
		await link(paths.lock, quarantinePath);
	} catch (cause) {
		if (hasCode(cause, "ENOENT")) return;
		if (hasCode(cause, "EEXIST")) {
			await unlinkIfSameFile(paths.lock, quarantinePath);
			return;
		}
		throw cause;
	}
	await unlinkIfSameFile(paths.lock, quarantinePath);
}

async function unlinkIfSameFile(lockPath: string, quarantinePath: string): Promise<void> {
	const [currentStat, quarantineStat] = await Promise.all([stat(lockPath), stat(quarantinePath)]);
	if (currentStat.dev === quarantineStat.dev && currentStat.ino === quarantineStat.ino) {
		await unlink(lockPath).catch((cause: unknown) => {
			if (!hasCode(cause, "ENOENT")) throw cause;
		});
	}
}

async function createLockFile(path: string, owner: LockOwner): Promise<void> {
	const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.sync();
	} catch (cause) {
		await handle.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
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
			Number.isInteger(value.pid) &&
			typeof value.pid === "number" &&
			typeof value.ownerToken === "string" &&
			/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value.ownerToken) &&
			typeof value.acquiredAt === "string"
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
