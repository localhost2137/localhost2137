import { constants } from "node:fs";
import {
	link,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireStorageLock,
	StorageLockError,
	type StorageLockFileSystem,
} from "../../src/node/storage-lock.js";
import { storagePaths } from "../../src/node/storage-paths.js";

const temporaryDirectories: string[] = [];
const nodeFileSystem: StorageLockFileSystem = { link, mkdir, open, unlink };

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

	it("quarantines a stale owner and acquires with a new token", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const first = await acquireStorageLock(paths, { ownerToken: () => "stale-owner" });
		const second = await acquireStorageLock(paths, {
			isProcessAlive: async () => false,
			ownerToken: () => "new-owner",
		});

		const current = JSON.parse(await readFile(paths.lock, "utf8"));
		expect(current.ownerToken).toBe("new-owner");
		await expect(first.release()).rejects.toBeInstanceOf(StorageLockError);
		await second.release();
	});

	it("does not steal a recently incomplete lock file", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await writeFile(paths.lock, "", { flag: "wx" });

		await expect(acquireStorageLock(paths)).rejects.toMatchObject({ code: "LOCK_CORRUPT" });
	});

	it("release is idempotent", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const lock = await acquireStorageLock(paths);
		await lock.release();
		await lock.release();
	});

	it("observes ownership bytes and identity through one open file handle", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await writeLock(paths.lock, lockOwner("stale-owner", 101));
		const retiredPath = `${paths.lock}.retired`;
		let replaced = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async open(path, flags, mode) {
				const handle = await open(path, flags, mode);
				if (path === paths.lock && flags === constants.O_RDONLY && !replaced) {
					replaced = true;
					await rename(paths.lock, retiredPath);
					await writeLock(paths.lock, lockOwner("replacement-owner", 202));
				}
				return handle;
			},
		};

		await expect(
			acquireStorageLock(paths, {
				fileSystem,
				isProcessAlive: async (pid) => pid === 202,
				ownerToken: () => "candidate-owner",
				quarantineToken: () => "observe-race",
			}),
		).rejects.toMatchObject({ code: "LOCKED", owner: { pid: 202 } });
		expect(JSON.parse(await readFile(paths.lock, "utf8"))).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it("does not quarantine a replacement installed after observation", async () => {
		const paths = storagePaths(await temporaryDirectory());
		await writeLock(paths.lock, lockOwner("stale-owner", 101));
		const retiredPath = `${paths.lock}.retired`;
		let replaced = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async link(existingPath, newPath) {
				if (existingPath === paths.lock && !replaced) {
					replaced = true;
					await rename(paths.lock, retiredPath);
					await writeLock(paths.lock, lockOwner("replacement-owner", 202));
				}
				await link(existingPath, newPath);
			},
		};

		await expect(
			acquireStorageLock(paths, {
				fileSystem,
				isProcessAlive: async (pid) => pid === 202,
				ownerToken: () => "candidate-owner",
				quarantineToken: () => "replace-race",
			}),
		).rejects.toMatchObject({ code: "LOCKED", owner: { pid: 202 } });
		expect(JSON.parse(await readFile(paths.lock, "utf8"))).toMatchObject({
			ownerToken: "replacement-owner",
		});
	});

	it("refuses to release a path replaced after ownership observation", async () => {
		const paths = storagePaths(await temporaryDirectory());
		const retiredPath = `${paths.lock}.retired`;
		let replaceDuringLink = false;
		const fileSystem: StorageLockFileSystem = {
			...nodeFileSystem,
			async link(existingPath, newPath) {
				if (existingPath === paths.lock && replaceDuringLink) {
					replaceDuringLink = false;
					await rename(paths.lock, retiredPath);
					await writeLock(paths.lock, lockOwner("replacement-owner", 202));
				}
				await link(existingPath, newPath);
			},
		};
		const lock = await acquireStorageLock(paths, {
			fileSystem,
			ownerToken: () => "original-owner",
			quarantineToken: () => "release-race",
		});
		replaceDuringLink = true;

		await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
		expect(JSON.parse(await readFile(paths.lock, "utf8"))).toMatchObject({
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
	])("rejects recently written metadata with a %s", async (_label, owner) => {
		const paths = storagePaths(await temporaryDirectory());
		await writeLock(paths.lock, owner);

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

async function writeLock(path: string, owner: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(owner)}\n`);
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-lock-"));
	temporaryDirectories.push(directory);
	return directory;
}
