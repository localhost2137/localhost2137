import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStorageLock, StorageLockError } from "../../src/node/storage-lock.js";
import { storagePaths } from "../../src/node/storage-paths.js";

const temporaryDirectories: string[] = [];

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
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-lock-"));
	temporaryDirectories.push(directory);
	return directory;
}
