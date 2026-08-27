import type { BigIntStats } from "node:fs";
import { CliUsageError } from "../cli/cli-errors.js";
import {
	appendNoFollowFlags,
	assertOwnedProjectFile,
	createOwnedProjectFile,
	type FileIdentity,
	fileIdentity,
	hasCode,
	hasIdentity,
	lstatIfPresent,
	type OwnedProjectFile,
	type ProjectInitFileHandle,
	type ProjectInitFileSystem,
	readOnlyNoFollowFlags,
	sameFileSnapshot,
} from "./project-init-file.js";

const IGNORE_ENTRY = ".localhost2137/";
const MAX_BYTES = 1024 * 1024;

interface ExistingProjectGitignore {
	append?: Uint8Array;
	closed: boolean;
	handle: ProjectInitFileHandle;
	readonly identity: FileIdentity;
	readonly original: Uint8Array;
	readonly snapshot: BigIntStats;
	readonly path: string;
}

interface MissingProjectGitignore {
	created?: OwnedProjectFile;
	readonly path: string;
}

export type ProjectGitignore = ExistingProjectGitignore | MissingProjectGitignore;

export async function inspectProjectGitignore(
	path: string,
	fileSystem: ProjectInitFileSystem,
): Promise<ProjectGitignore> {
	const pathSnapshot = await lstatIfPresent(path, fileSystem);
	if (!pathSnapshot) return { path };
	assertRegularBounded(pathSnapshot);
	let handle: ProjectInitFileHandle;
	try {
		handle = await fileSystem.open(path, readOnlyNoFollowFlags());
	} catch (cause) {
		throw new CliUsageError(".gitignore changed while localhost init was opening it.", { cause });
	}
	try {
		const handleSnapshot = await handle.stat();
		assertRegularBounded(handleSnapshot);
		if (!sameFileSnapshot(pathSnapshot, handleSnapshot)) throw changedGitignore();
		const original = await readAtMost(handle, MAX_BYTES);
		const afterRead = await handle.stat();
		const pathAfter = await lstatIfPresent(path, fileSystem);
		if (
			!pathAfter ||
			!sameFileSnapshot(handleSnapshot, afterRead) ||
			!hasIdentity(pathAfter, fileIdentity(afterRead)) ||
			BigInt(original.byteLength) !== afterRead.size
		) {
			throw changedGitignore();
		}
		return {
			closed: false,
			handle,
			identity: fileIdentity(afterRead),
			original,
			path,
			snapshot: afterRead,
		};
	} catch (cause) {
		await handle.close().catch((cleanup: unknown) => {
			throw new AggregateError([cause, cleanup], "Reading .gitignore and closing it both failed.");
		});
		throw cause;
	}
}

export async function commitProjectGitignore(
	gitignore: ProjectGitignore,
	fileSystem: ProjectInitFileSystem,
): Promise<"created" | "unchanged" | "updated"> {
	if (!("handle" in gitignore)) {
		try {
			gitignore.created = await createOwnedProjectFile(
				gitignore.path,
				`${IGNORE_ENTRY}\n`,
				0o644,
				fileSystem,
			);
		} catch (cause) {
			if (hasCode(cause, "EEXIST")) {
				throw new CliUsageError(".gitignore appeared while localhost init was running.");
			}
			throw cause;
		}
		return "created";
	}
	const append = planAppend(gitignore.original);
	if (append.byteLength === 0) return "unchanged";
	await assertUnchanged(gitignore, fileSystem);
	const writeHandle = await openAppendHandle(gitignore, fileSystem);
	try {
		await gitignore.handle.close();
		gitignore.handle = writeHandle;
	} catch (cause) {
		await writeHandle.close().catch((cleanup: unknown) => {
			throw new AggregateError(
				[cause, cleanup],
				"Opening .gitignore for append and closing its read handle both failed.",
			);
		});
		throw cause;
	}
	gitignore.append = append;
	await writeAll(gitignore.handle, append);
	await gitignore.handle.sync();
	await validateProjectGitignore(gitignore, fileSystem);
	return "updated";
}

export async function validateProjectGitignore(
	gitignore: ProjectGitignore,
	fileSystem: ProjectInitFileSystem,
): Promise<void> {
	if (!("handle" in gitignore)) {
		if (gitignore.created) {
			await assertOwnedProjectFile(gitignore.created, fileSystem).catch((cause: unknown) => {
				throw changedGitignore(cause);
			});
		}
		return;
	}
	const expected = concatenate(gitignore.original, gitignore.append ?? new Uint8Array());
	const metadata = await gitignore.handle.stat();
	const pathMetadata = await lstatIfPresent(gitignore.path, fileSystem);
	if (
		!pathMetadata ||
		!hasIdentity(metadata, gitignore.identity) ||
		!hasIdentity(pathMetadata, gitignore.identity) ||
		metadata.mode !== gitignore.snapshot.mode ||
		metadata.size !== BigInt(expected.byteLength) ||
		!(await handleBytesEqual(gitignore.handle, expected))
	) {
		throw changedGitignore();
	}
}

export async function rollbackProjectGitignore(
	gitignore: ExistingProjectGitignore,
	fileSystem: ProjectInitFileSystem,
): Promise<unknown[]> {
	if (!gitignore.append) return [];
	try {
		const pathMetadata = await lstatIfPresent(gitignore.path, fileSystem);
		if (!pathMetadata || !hasIdentity(pathMetadata, gitignore.identity)) {
			throw new Error(
				".gitignore moved or was replaced after localhost init appended its entry; refusing to truncate it.",
			);
		}
		if (
			!(await handleBytesEqual(gitignore.handle, concatenate(gitignore.original, gitignore.append)))
		) {
			throw new Error(
				".gitignore changed after localhost init appended its entry; refusing to truncate it.",
			);
		}
		await gitignore.handle.truncate(gitignore.original.byteLength);
		await gitignore.handle.sync();
		delete gitignore.append;
		return [];
	} catch (cause) {
		return [cause];
	}
}

async function openAppendHandle(
	gitignore: ExistingProjectGitignore,
	fileSystem: ProjectInitFileSystem,
): Promise<ProjectInitFileHandle> {
	let handle: ProjectInitFileHandle;
	try {
		handle = await fileSystem.open(gitignore.path, appendNoFollowFlags());
	} catch (cause) {
		throw new CliUsageError(".gitignore is not writable; localhost init left it unchanged.", {
			cause,
		});
	}
	try {
		const handleMetadata = await handle.stat();
		const pathMetadata = await lstatIfPresent(gitignore.path, fileSystem);
		if (
			!pathMetadata ||
			!sameFileSnapshot(handleMetadata, gitignore.snapshot) ||
			!hasIdentity(pathMetadata, gitignore.identity)
		) {
			throw changedGitignore();
		}
		return handle;
	} catch (cause) {
		await handle.close().catch((cleanup: unknown) => {
			throw new AggregateError(
				[cause, cleanup],
				"Revalidating .gitignore and closing its append handle both failed.",
			);
		});
		throw cause;
	}
}

export async function closeProjectGitignore(gitignore: ExistingProjectGitignore): Promise<void> {
	await gitignore.handle.close();
	gitignore.closed = true;
}

function planAppend(original: Uint8Array): Uint8Array {
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(original);
	} catch (cause) {
		throw new CliUsageError(".gitignore must be valid UTF-8 before localhost init can update it.", {
			cause,
		});
	}
	const meaningful = content
		.split(/\r?\n/u)
		.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
	if (meaningful.at(-1) === IGNORE_ENTRY) return new Uint8Array();
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const separator = content.length === 0 || content.endsWith("\n") ? "" : newline;
	return new TextEncoder().encode(`${separator}${IGNORE_ENTRY}${newline}`);
}

async function assertUnchanged(
	gitignore: ExistingProjectGitignore,
	fileSystem: ProjectInitFileSystem,
): Promise<void> {
	const handleMetadata = await gitignore.handle.stat();
	const pathMetadata = await lstatIfPresent(gitignore.path, fileSystem);
	if (
		!pathMetadata ||
		!sameFileSnapshot(handleMetadata, gitignore.snapshot) ||
		!hasIdentity(pathMetadata, gitignore.identity)
	) {
		throw changedGitignore();
	}
}

async function readAtMost(handle: ProjectInitFileHandle, limit: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(limit + 1);
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > limit) throw oversizedGitignore();
	return bytes.slice(0, offset);
}

async function writeAll(handle: ProjectInitFileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
		if (bytesWritten === 0) throw new Error("Writing .gitignore made no progress.");
		offset += bytesWritten;
	}
}

async function handleBytesEqual(
	handle: ProjectInitFileHandle,
	expected: Uint8Array,
): Promise<boolean> {
	if ((await handle.stat()).size !== BigInt(expected.byteLength)) return false;
	const actual = await readAtMost(handle, expected.byteLength);
	return actual.every((byte, index) => byte === expected[index]);
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left);
	combined.set(right, left.byteLength);
	return combined;
}

function assertRegularBounded(metadata: BigIntStats): void {
	if (!metadata.isFile()) throw new CliUsageError(".gitignore must be a regular file.");
	if (metadata.size > BigInt(MAX_BYTES)) throw oversizedGitignore();
}

function oversizedGitignore(): CliUsageError {
	return new CliUsageError(`.gitignore exceeds the ${MAX_BYTES}-byte localhost init safety limit.`);
}

function changedGitignore(cause?: unknown): CliUsageError {
	return new CliUsageError(
		".gitignore changed while localhost init was running.",
		cause === undefined ? undefined : { cause },
	);
}
