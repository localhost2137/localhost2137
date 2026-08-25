import { constants } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStorageLock, type StorageLockFileSystem } from "../../src/node/storage-lock.js";
import { storagePaths } from "../../src/node/storage-paths.js";

const temporaryDirectories: string[] = [];
const nodeFileSystem: StorageLockFileSystem = {
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

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("storage root lock", () => {
	it("rejects a live owner with useful diagnostics", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const first = await acquireStorageLock(paths, { ownerToken: () => "owner-one" });

		await expect(
			acquireStorageLock(paths, {
				isProcessAlive: async () => true,
				ownerToken: () => "owner-two",
			}),
		).rejects.toMatchObject({ code: "LOCKED", owner: { pid: process.pid } });
		await first.release();
	});

	it("refuses automatic takeover of a stale owner", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const first = await acquireStorageLock(paths, { ownerToken: () => "stale-owner" });

		await expect(
			acquireStorageLock(paths, {
				isProcessAlive: async () => false,
				ownerToken: () => "new-owner",
			}),
		).rejects.toMatchObject({
			code: "LOCK_STALE",
			message: expect.stringContaining("remove that exact lock path explicitly"),
			owner: { pid: process.pid },
		});
		expect(await readOwner(paths.lock)).toMatchObject({ ownerToken: "stale-owner" });

		await first.release();
		const second = await acquireStorageLock(paths, { ownerToken: () => "new-owner" });
		await second.release();
	});

	it("fails closed for an incomplete lock directory", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await mkdir(paths.lock);

		await expect(acquireStorageLock(paths)).rejects.toMatchObject({
			code: "LOCK_CORRUPT",
			message: expect.stringContaining("Retry if another runtime is starting"),
		});
	});

	it("reports the obsolete lock-file format without replacing it", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await writeFile(paths.lock, `${JSON.stringify(lockOwner("old-owner", 101))}\n`, {
			flag: "wx",
		});

		await expect(acquireStorageLock(paths)).rejects.toMatchObject({
			code: "LOCK_CORRUPT",
			message: expect.stringContaining("obsolete lock-file format"),
		});
		expect(JSON.parse(await readFile(paths.lock, "utf8"))).toMatchObject({
			ownerToken: "old-owner",
		});
	});

	it("release is idempotent and permits a later owner", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const first = await acquireStorageLock(paths, { ownerToken: () => "owner-one" });
		await first.release();
		await first.release();

		const second = await acquireStorageLock(paths, { ownerToken: () => "owner-two" });
		await second.release();
	});

	it("observes owner metadata through one open file handle", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await writeLockDirectory(paths.lock, lockOwner("stale-owner", 101));
		const retiredPath = `${paths.lock}.retired`;
		let replaced = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async open(path, flags, mode) {
				const handle = await open(path, flags, mode);
				if (path === join(paths.lock, "stale-owner") && flags === constants.O_RDONLY && !replaced) {
					replaced = true;
					await rename(paths.lock, retiredPath);
					await writeLockDirectory(paths.lock, lockOwner("replacement-owner", 202));
				}
				return handle;
			},
		};

		await expect(
			acquireStorageLock(paths, {
				fileSystem,
				isProcessAlive: async () => false,
				ownerToken: () => "candidate-owner",
			}),
		).rejects.toMatchObject({ code: "LOCK_STALE", owner: { pid: 101 } });
		expect(await readOwner(paths.lock)).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it("preserves a replacement installed immediately before owner removal", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const retiredPath = `${paths.lock}.retired`;
		let replaceBeforeOwnerRemoval = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async unlink(path) {
				if (path === join(paths.lock, "original-owner") && replaceBeforeOwnerRemoval) {
					replaceBeforeOwnerRemoval = false;
					await rename(paths.lock, retiredPath);
					await writeLockDirectory(paths.lock, lockOwner("replacement-owner", 202));
				}
				await unlink(path);
			},
		};
		const lock = await acquireStorageLock(paths, {
			fileSystem,
			ownerToken: () => "original-owner",
		});
		replaceBeforeOwnerRemoval = true;

		await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
		expect(await readOwner(paths.lock)).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it("preserves a replacement installed before the empty lock directory is removed", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const retiredPath = `${paths.lock}.retired`;
		let replaceBeforeDirectoryRemoval = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async removeDirectory(path) {
				if (path === paths.lock && replaceBeforeDirectoryRemoval) {
					replaceBeforeDirectoryRemoval = false;
					await rename(paths.lock, retiredPath);
					await writeLockDirectory(paths.lock, lockOwner("replacement-owner", 202));
				}
				await rmdir(path);
			},
		};
		const lock = await acquireStorageLock(paths, {
			fileSystem,
			ownerToken: () => "original-owner",
		});
		replaceBeforeDirectoryRemoval = true;

		await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
		expect(await readOwner(paths.lock)).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it.each([
		["zero pid", { ...lockOwner("invalid-owner", 101), pid: 0 }],
		["negative pid", { ...lockOwner("invalid-owner", 101), pid: -1 }],
		["unsafe pid", { ...lockOwner("invalid-owner", 101), pid: Number.MAX_SAFE_INTEGER + 1 }],
		[
			"invalid timestamp",
			{ ...lockOwner("invalid-owner", 101), acquiredAt: "2026-02-30T12:00:00.000Z" },
		],
	])("rejects metadata with a %s", async (_label, owner) => {
		const paths = storagePaths(await temporaryDirectory());
		await writeLockDirectory(paths.lock, owner);

		await expect(acquireStorageLock(paths)).rejects.toMatchObject({ code: "LOCK_CORRUPT" });
	});
});

function lockOwner(ownerToken: string, pid: number) {
	return {
		acquiredAt: "2026-08-25T12:00:00.000Z",
		ownerToken,
		pid,
		schemaVersion: 1,
	};
}

async function readOwner(lockPath: string): Promise<Record<string, unknown>> {
	const entries = await readdir(lockPath);
	expect(entries).toHaveLength(1);
	return JSON.parse(await readFile(join(lockPath, entries[0] ?? "missing"), "utf8"));
}

async function writeLockDirectory(
	lockPath: string,
	owner: Readonly<{ ownerToken: string }>,
): Promise<void> {
	await mkdir(lockPath);
	await writeFile(join(lockPath, owner.ownerToken), `${JSON.stringify(owner)}\n`);
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-lock-"));
	temporaryDirectories.push(directory);
	return directory;
}
