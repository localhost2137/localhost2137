import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "./config-error.js";

export const CONFIG_FILE_NAMES: readonly string[] = Object.freeze([
	"localhost.config.ts",
	"localhost.config.mts",
	"localhost.config.cts",
	"localhost.config.js",
	"localhost.config.mjs",
	"localhost.config.cjs",
]);

export interface ConfigDiscoveryOptions {
	readonly cwd: string;
	readonly explicitPath?: string;
}

export async function discoverConfigFile(options: ConfigDiscoveryOptions): Promise<string> {
	const startDirectory = resolve(options.cwd);
	if (options.explicitPath) {
		const candidate = isAbsolute(options.explicitPath)
			? options.explicitPath
			: resolve(startDirectory, options.explicitPath);
		return existingFile(candidate, startDirectory);
	}

	let directory = startDirectory;
	while (true) {
		for (const fileName of CONFIG_FILE_NAMES) {
			const candidate = join(directory, fileName);
			if (await isFile(candidate)) {
				return realpath(candidate);
			}
		}
		const parent = dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}

	throw new ConfigError(
		"CONFIG_NOT_FOUND",
		`No localhost2137 config found while walking upward from ${startDirectory}.`,
		{ searchedFrom: startDirectory },
	);
}

async function existingFile(candidate: string, searchedFrom: string): Promise<string> {
	if (await isFile(candidate)) {
		return realpath(candidate);
	}
	throw new ConfigError("CONFIG_NOT_FOUND", `Config file does not exist: ${candidate}.`, {
		configPath: candidate,
		searchedFrom,
	});
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (cause) {
		if (isMissingPathError(cause)) {
			return false;
		}
		throw cause;
	}
}

function isMissingPathError(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		(value.code === "ENOENT" || value.code === "ENOTDIR")
	);
}
