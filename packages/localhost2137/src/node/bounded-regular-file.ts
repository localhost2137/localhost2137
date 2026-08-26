import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

interface RegularFileHandle {
	close(): Promise<void>;
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<Readonly<{ bytesRead: number }>>;
	stat(): Promise<BigIntStats>;
}

export interface BoundedRegularFileSystem {
	lstat(path: string): Promise<BigIntStats>;
	open(path: string, flags: number): Promise<RegularFileHandle>;
}

type BoundedRegularFileErrorCode = "FILE_CHANGED" | "FILE_TOO_LARGE" | "NOT_REGULAR";

class BoundedRegularFileError extends Error {
	readonly code: BoundedRegularFileErrorCode;

	constructor(code: BoundedRegularFileErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BoundedRegularFileError";
		this.code = code;
	}
}

const nodeRegularFileSystem: BoundedRegularFileSystem = {
	lstat: (path) => lstat(path, { bigint: true }),
	async open(path, flags) {
		const handle = await open(path, flags);
		return {
			close: () => handle.close(),
			read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
			stat: () => handle.stat({ bigint: true }),
		};
	},
};

/** Reads one unchanged regular file without following its pathname through a symlink. */
export async function readBoundedRegularFile(
	path: string,
	limitBytes: number,
	fileSystem: BoundedRegularFileSystem = nodeRegularFileSystem,
): Promise<Uint8Array> {
	if (typeof path !== "string" || path.length === 0) {
		throw new TypeError("Bounded regular-file path must be a non-empty string.");
	}
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
		throw new TypeError("Bounded regular-file limit must be a non-negative safe integer.");
	}

	const pathBefore = await fileSystem.lstat(path);
	assertRegular(pathBefore);
	assertBounded(pathBefore, limitBytes);

	let handle: RegularFileHandle;
	try {
		handle = await fileSystem.open(path, readOnlyNoFollowFlags());
	} catch (cause) {
		throw changedFile(cause);
	}
	try {
		const handleBefore = await handle.stat();
		assertRegular(handleBefore);
		assertBounded(handleBefore, limitBytes);
		if (!sameSnapshot(pathBefore, handleBefore)) throw changedFile();

		const bytes = await readAtMost(handle, limitBytes);
		const handleAfter = await handle.stat();
		let pathAfter: BigIntStats;
		try {
			pathAfter = await fileSystem.lstat(path);
		} catch (cause) {
			throw changedFile(cause);
		}
		assertRegular(handleAfter);
		assertRegular(pathAfter);
		if (
			!sameSnapshot(handleBefore, handleAfter) ||
			!sameIdentity(handleAfter, pathAfter) ||
			BigInt(bytes.byteLength) !== handleAfter.size
		) {
			throw changedFile();
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function readAtMost(handle: RegularFileHandle, limitBytes: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(limitBytes + 1);
	let offset = 0;
	while (offset < bytes.byteLength) {
		const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
		if (result.bytesRead === 0) break;
		offset += result.bytesRead;
	}
	if (offset > limitBytes) {
		throw new BoundedRegularFileError("FILE_TOO_LARGE", "Regular file exceeds its size limit.");
	}
	return bytes.slice(0, offset);
}

function assertRegular(metadata: BigIntStats): void {
	if (!metadata.isFile()) {
		throw new BoundedRegularFileError("NOT_REGULAR", "Path must name a regular file.");
	}
}

function assertBounded(metadata: BigIntStats, limitBytes: number): void {
	if (metadata.size > BigInt(limitBytes)) {
		throw new BoundedRegularFileError("FILE_TOO_LARGE", "Regular file exceeds its size limit.");
	}
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return (
		sameIdentity(left, right) &&
		left.ctimeNs === right.ctimeNs &&
		left.mode === right.mode &&
		left.mtimeNs === right.mtimeNs &&
		left.nlink === right.nlink &&
		left.size === right.size
	);
}

function readOnlyNoFollowFlags(): number {
	const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
	return constants.O_RDONLY | noFollow;
}

function changedFile(cause?: unknown): BoundedRegularFileError {
	return new BoundedRegularFileError(
		"FILE_CHANGED",
		"Regular file identity or contents changed while it was being read.",
		cause === undefined ? undefined : { cause },
	);
}
