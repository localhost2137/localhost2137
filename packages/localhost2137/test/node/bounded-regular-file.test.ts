import { type FileHandle, lstat, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BoundedRegularFileSystem,
	readBoundedRegularFile,
} from "../../src/node/bounded-regular-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("bounded regular-file reader", () => {
	it("returns the bytes from one stable regular-file identity", async () => {
		const path = await temporaryFile("stable contents");

		await expect(readBoundedRegularFile(path, 64)).resolves.toEqual(
			new TextEncoder().encode("stable contents"),
		);
	});

	it("rejects replacement between pathname inspection and opening", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "artifact");
		const retiredPath = join(directory, "retired");
		const replacementPath = join(directory, "replacement");
		await writeFile(path, "first");
		await writeFile(replacementPath, "second");
		const fileSystem = injectedFileSystem({
			beforeOpen: async () => {
				await rename(path, retiredPath);
				await rename(replacementPath, path);
			},
		});

		await expect(readBoundedRegularFile(path, 64, fileSystem)).rejects.toMatchObject({
			code: "FILE_CHANGED",
		});
	});

	it("rejects in-place mutation between reading and final identity validation", async () => {
		const path = await temporaryFile("first");
		const fileSystem = injectedFileSystem({
			beforeHandleStat: async (invocation) => {
				if (invocation === 2) await writeFile(path, "second-and-larger");
			},
		});

		await expect(readBoundedRegularFile(path, 64, fileSystem)).rejects.toMatchObject({
			code: "FILE_CHANGED",
		});
	});

	it("bounds growth without reading an unbounded file", async () => {
		const path = await temporaryFile("small");
		const fileSystem = injectedFileSystem({
			beforeHandleStat: async (invocation) => {
				if (invocation === 1) await writeFile(path, "x".repeat(128));
			},
		});

		await expect(readBoundedRegularFile(path, 16, fileSystem)).rejects.toMatchObject({
			code: "FILE_TOO_LARGE",
		});
	});
});

function injectedFileSystem(hooks: {
	readonly beforeHandleStat?: (invocation: number) => Promise<void>;
	readonly beforeOpen?: () => Promise<void>;
}): BoundedRegularFileSystem {
	return {
		lstat: (path) => lstat(path, { bigint: true }),
		async open(path, flags) {
			await hooks.beforeOpen?.();
			return injectedHandle(await open(path, flags), hooks.beforeHandleStat);
		},
	};
}

function injectedHandle(
	handle: FileHandle,
	beforeStat: ((invocation: number) => Promise<void>) | undefined,
) {
	let statInvocation = 0;
	return {
		close: () => handle.close(),
		read: (buffer: Uint8Array, offset: number, length: number, position: number) =>
			handle.read(buffer, offset, length, position),
		async stat() {
			statInvocation += 1;
			await beforeStat?.(statInvocation);
			return handle.stat({ bigint: true });
		},
	};
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "localhost2137-bounded-file-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function temporaryFile(contents: string): Promise<string> {
	const path = join(await temporaryDirectory(), "artifact");
	await writeFile(path, contents, { flag: "wx" });
	return path;
}
