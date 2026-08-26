import { CliUsageError } from "./cli-errors.js";

export interface CliBootstrapArguments {
	readonly arguments: readonly string[];
	readonly configPath?: string;
}

/** Owns the stateless options needed before command-specific composition. */
export function parseCliBootstrapArguments(value: unknown): CliBootstrapArguments {
	if (!Array.isArray(value)) throw new TypeError("CLI arguments must be an array.");
	const arguments_: string[] = [];
	let configPath: string | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const argument = ownArgument(value[index]);
		if (argument === "--") {
			arguments_.push(argument);
			for (let childIndex = index + 1; childIndex < value.length; childIndex += 1) {
				arguments_.push(ownArgument(value[childIndex]));
			}
			break;
		}
		if (argument === "--config") {
			if (configPath !== undefined) throw duplicateConfig();
			const rawCandidate = value[index + 1];
			if (rawCandidate === undefined) throw missingConfigPath();
			const candidate = ownArgument(rawCandidate);
			if (candidate === "" || candidate === "--" || candidate.startsWith("-")) {
				throw missingConfigPath();
			}
			configPath = candidate;
			index += 1;
			continue;
		}
		if (argument.startsWith("--config=")) {
			if (configPath !== undefined) throw duplicateConfig();
			const candidate = argument.slice("--config=".length);
			if (candidate === "") throw missingConfigPath();
			configPath = candidate;
			continue;
		}
		arguments_.push(argument);
	}
	return Object.freeze({
		arguments: Object.freeze(arguments_),
		...(configPath === undefined ? {} : { configPath }),
	});
}

function ownArgument(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new TypeError("CLI arguments must contain only NUL-free strings.");
	}
	return value;
}

function duplicateConfig(): CliUsageError {
	return new CliUsageError("--config may be specified only once.");
}

function missingConfigPath(): CliUsageError {
	return new CliUsageError("--config requires a path.");
}
