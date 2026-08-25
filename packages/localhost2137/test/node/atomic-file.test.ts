import { access, mkdtemp, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AtomicFileHandle,
	AtomicWriteError,
	type AtomicWriteFileSystem,
	writeTextAtomically,
} from "../../src/node/atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("atomic file writes", () => {
	it("replaces a file and leaves no sibling temporary artifact", async () => {
		const directory = await temporaryDirectory();
		const destination = join(directory, "instance.json");
		await writeTextAtomically(destination, "first", { token: () => "first" });
		const outcome = await writeTextAtomically(destination, "second", { token: () => "second" });

		expect(outcome).toEqual({ commitState: "committed", directorySync: "synced" });
		expect(await readFile(destination, "utf8")).toBe("second");
		await expect(access(`${destination}.tmp-second`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("closes and removes the temporary file when writing fails", async () => {
		const failure = new Error("disk full");
		const handle: AtomicFileHandle = {
			close: vi.fn(async () => undefined),
			sync: vi.fn(async () => undefined),
			writeFile: vi.fn(async () => {
				throw failure;
			}),
		};
		const fileSystem: AtomicWriteFileSystem = {
			open: vi.fn(async () => handle),
			rename: vi.fn(async () => undefined),
			unlink: vi.fn(async () => undefined),
		};

		const write = writeTextAtomically("/virtual/instance.json", "data", {
			fileSystem,
			token: () => "failure",
		});
		await expect(write).rejects.toMatchObject({
			cause: failure,
			commitState: "not_committed",
			phase: "write_temporary",
		});
		await expect(write).rejects.toBeInstanceOf(AtomicWriteError);
		expect(handle.close).toHaveBeenCalledOnce();
		expect(fileSystem.unlink).toHaveBeenCalledWith("/virtual/instance.json.tmp-failure");
		expect(fileSystem.rename).not.toHaveBeenCalled();
	});

	it("classifies rename failure as not committed and removes the temporary file", async () => {
		const failure = new Error("rename denied");
		const handle = successfulHandle();
		const fileSystem: AtomicWriteFileSystem = {
			open: vi.fn(async () => handle),
			rename: vi.fn(async () => {
				throw failure;
			}),
			unlink: vi.fn(async () => undefined),
		};

		await expect(
			writeTextAtomically("/virtual/instance.json", "data", {
				fileSystem,
				token: () => "rename-failure",
			}),
		).rejects.toMatchObject({
			cause: failure,
			commitState: "not_committed",
			phase: "rename",
		});
		expect(fileSystem.unlink).toHaveBeenCalledWith("/virtual/instance.json.tmp-rename-failure");
	});

	it("reports a committed replacement when the post-rename directory sync fails", async () => {
		const directory = await temporaryDirectory();
		const destination = join(directory, "instance.json");
		const directorySyncFailure = new Error("directory sync failed");
		const directoryHandle: AtomicFileHandle = {
			close: vi.fn(async () => undefined),
			sync: vi.fn(async () => {
				throw directorySyncFailure;
			}),
			writeFile: vi.fn(async () => undefined),
		};
		const fileSystem: AtomicWriteFileSystem = {
			async open(path, flags, mode) {
				if (path === directory) return directoryHandle;
				return open(path, flags, mode);
			},
			rename,
			unlink,
		};

		await expect(
			writeTextAtomically(destination, "committed data", {
				fileSystem,
				token: () => "directory-failure",
			}),
		).rejects.toMatchObject({
			cause: directorySyncFailure,
			commitState: "committed",
			phase: "sync_directory",
		});
		expect(await readFile(destination, "utf8")).toBe("committed data");
		await expect(access(`${destination}.tmp-directory-failure`)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

function successfulHandle(): AtomicFileHandle {
	return {
		close: vi.fn(async () => undefined),
		sync: vi.fn(async () => undefined),
		writeFile: vi.fn(async () => undefined),
	};
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-atomic-"));
	temporaryDirectories.push(directory);
	return directory;
}
