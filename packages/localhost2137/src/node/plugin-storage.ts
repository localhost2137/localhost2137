import { isAbsolute, relative, resolve } from "node:path";
import type { PluginStorage } from "../authoring/context.js";

export class InvalidPluginStoragePathError extends Error {
	readonly relativePath: string;

	constructor(relativePath: string, reason: string) {
		super(`Invalid plugin storage path ${JSON.stringify(relativePath)}: ${reason}`);
		this.name = "InvalidPluginStoragePathError";
		this.relativePath = relativePath;
	}
}

export class NodePluginStorage implements PluginStorage {
	readonly #dataRoot: string;

	constructor(dataRoot: string) {
		this.#dataRoot = resolve(dataRoot);
	}

	path(relativePath: string): string {
		validatePortableRelativePath(relativePath);
		const candidate = resolve(this.#dataRoot, ...relativePath.split(/[\\/]/));
		const pathFromRoot = relative(this.#dataRoot, candidate);
		if (pathFromRoot === "" || isAbsolute(pathFromRoot) || pathFromRoot.startsWith("..")) {
			throw new InvalidPluginStoragePathError(relativePath, "path escapes the service data root");
		}
		return candidate;
	}
}

function validatePortableRelativePath(relativePath: string): void {
	if (relativePath.length === 0) {
		throw new InvalidPluginStoragePathError(relativePath, "path is empty");
	}
	if (relativePath.includes("\0")) {
		throw new InvalidPluginStoragePathError(relativePath, "path contains a NUL byte");
	}
	if (
		isAbsolute(relativePath) ||
		/^[a-zA-Z]:[\\/]/.test(relativePath) ||
		relativePath.startsWith("\\\\") ||
		relativePath.startsWith("//")
	) {
		throw new InvalidPluginStoragePathError(relativePath, "absolute paths are not allowed");
	}
	const segments = relativePath.split(/[\\/]/);
	if (segments.some((segment) => segment.length === 0)) {
		throw new InvalidPluginStoragePathError(relativePath, "empty path segments are not allowed");
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new InvalidPluginStoragePathError(
			relativePath,
			"dot and traversal segments are not allowed",
		);
	}
}
