import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { syncDirectory } from "./atomic-file.js";

export interface ProjectInitFileHandle {
	close(): Promise<void>;
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<Readonly<{ bytesRead: number }>>;
	stat(): Promise<BigIntStats>;
	sync(): Promise<void>;
	truncate(length: number): Promise<void>;
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<Readonly<{ bytesWritten: number }>>;
	writeFile(content: string): Promise<void>;
}

export interface ProjectInitFileSystem {
	lstat(path: string): Promise<BigIntStats>;
	open(path: string, flags: number, mode?: number): Promise<ProjectInitFileHandle>;
	syncDirectory(path: string): Promise<"synced" | "unsupported">;
	unlink(path: string): Promise<void>;
}

export interface OwnedProjectFile {
	closed: boolean;
	readonly handle: ProjectInitFileHandle;
	readonly identity: FileIdentity;
	readonly path: string;
	readonly snapshot: BigIntStats;
}

export type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

export class ProjectFileCommittedError extends Error {
	override readonly cause: unknown;
	readonly owned: OwnedProjectFile;

	constructor(owned: OwnedProjectFile, cause: unknown) {
		super(
			`localhost init created ${owned.path}, but could not confirm the directory entry's durability. The created file was preserved.`,
		);
		this.name = "ProjectFileCommittedError";
		this.cause = cause;
		this.owned = owned;
	}
}

export const nodeProjectInitFileSystem: ProjectInitFileSystem = {
	lstat: (path) => lstat(path, { bigint: true }),
	async open(path, flags, mode) {
		return nodeHandle(await open(path, flags, mode));
	},
	syncDirectory,
	unlink,
};

export async function createOwnedProjectFile(
	path: string,
	content: string,
	mode: number,
	fileSystem: ProjectInitFileSystem,
): Promise<OwnedProjectFile> {
	const handle = await fileSystem.open(path, exclusiveNoFollowFlags(), mode);
	let identity: FileIdentity | undefined;
	try {
		await handle.writeFile(content);
		await handle.sync();
		const snapshot = await handle.stat();
		identity = fileIdentity(snapshot);
		try {
			await fileSystem.syncDirectory(dirname(path));
		} catch (cause) {
			throw new ProjectFileCommittedError(
				{ closed: false, handle, identity, path, snapshot },
				cause,
			);
		}
		return { closed: false, handle, identity, path, snapshot };
	} catch (cause) {
		if (cause instanceof ProjectFileCommittedError) throw cause;
		const cleanup: unknown[] = [];
		identity ??= await handle
			.stat()
			.then(fileIdentity)
			.catch(() => undefined);
		await handle.close().catch((failure: unknown) => cleanup.push(failure));
		if (identity) cleanup.push(...(await unlinkOwnedPath(path, identity, fileSystem)));
		throw withCleanup(cause, cleanup);
	}
}

export async function removeOwnedProjectFile(
	file: OwnedProjectFile,
	fileSystem: ProjectInitFileSystem,
): Promise<unknown[]> {
	const failures: unknown[] = [];
	if (!file.closed)
		await closeOwnedProjectFile(file).catch((cause: unknown) => failures.push(cause));
	failures.push(...(await unlinkOwnedPath(file.path, file.identity, fileSystem)));
	return failures;
}

export async function closeOwnedProjectFile(file: OwnedProjectFile): Promise<void> {
	await file.handle.close();
	file.closed = true;
}

export async function assertOwnedProjectFile(
	file: OwnedProjectFile,
	fileSystem: ProjectInitFileSystem,
): Promise<void> {
	const handleMetadata = await file.handle.stat();
	const pathMetadata = await lstatIfPresent(file.path, fileSystem);
	if (
		!pathMetadata ||
		!sameFileSnapshot(handleMetadata, file.snapshot) ||
		!hasIdentity(pathMetadata, file.identity)
	) {
		throw new Error(`${file.path} changed while localhost init was running.`);
	}
}

export async function lstatIfPresent(
	path: string,
	fileSystem: ProjectInitFileSystem,
): Promise<BigIntStats | undefined> {
	try {
		return await fileSystem.lstat(path);
	} catch (cause) {
		if (hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")) return undefined;
		throw cause;
	}
}

export function fileIdentity(metadata: BigIntStats): FileIdentity {
	return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

export function hasIdentity(metadata: BigIntStats, identity: FileIdentity): boolean {
	return metadata.dev === identity.dev && metadata.ino === identity.ino;
}

export function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return (
		hasIdentity(left, fileIdentity(right)) &&
		left.ctimeNs === right.ctimeNs &&
		left.mode === right.mode &&
		left.mtimeNs === right.mtimeNs &&
		left.nlink === right.nlink &&
		left.size === right.size
	);
}

export function withCleanup(primary: unknown, failures: readonly unknown[]): unknown {
	return failures.length === 0
		? primary
		: new AggregateError(
				[primary, ...failures],
				"localhost init failed and rollback or cleanup also failed.",
			);
}

export function hasCode(value: unknown, expected: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		Reflect.get(value, "code") === expected
	);
}

export function readWriteNoFollowFlags(): number {
	return constants.O_RDWR | noFollowFlag();
}

async function unlinkOwnedPath(
	path: string,
	identity: FileIdentity,
	fileSystem: ProjectInitFileSystem,
): Promise<unknown[]> {
	try {
		const metadata = await lstatIfPresent(path, fileSystem);
		if (!metadata) return [];
		if (!hasIdentity(metadata, identity))
			throw new Error(`Refusing to remove replaced path: ${path}`);
		await fileSystem.unlink(path);
		await fileSystem.syncDirectory(dirname(path));
		return [];
	} catch (cause) {
		return [cause];
	}
}

function exclusiveNoFollowFlags(): number {
	return constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag();
}

function noFollowFlag(): number {
	return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

function nodeHandle(handle: FileHandle): ProjectInitFileHandle {
	return {
		close: () => handle.close(),
		read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
		stat: () => handle.stat({ bigint: true }),
		sync: () => handle.sync(),
		truncate: (length) => handle.truncate(length),
		write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
		writeFile: (content) => handle.writeFile(content, "utf8"),
	};
}
