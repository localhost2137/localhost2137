import { extname } from "node:path";
import { require as tsRequire } from "tsx/cjs/api";
import { tsImport } from "tsx/esm/api";
import { ConfigError } from "./config-error.js";

export async function importConfigDefault(configPath: string): Promise<unknown> {
	let imported: unknown;
	try {
		imported = isCommonJsConfig(configPath)
			? tsRequire(configPath, import.meta.url)
			: await tsImport(configPath, import.meta.url);
	} catch (cause) {
		throw new ConfigError(
			"CONFIG_IMPORT_FAILED",
			`Failed to import localhost2137 config at ${configPath}.`,
			{ configPath },
			cause,
		);
	}

	if (
		extname(configPath) === ".cjs" &&
		isModuleNamespace(imported) &&
		!Object.hasOwn(imported, "default")
	) {
		return imported;
	}

	if (!isModuleNamespace(imported) || !Object.hasOwn(imported, "default")) {
		throw new ConfigError(
			"CONFIG_DEFAULT_EXPORT_MISSING",
			`Config must default-export defineConfig({...}): ${configPath}.`,
			{ configPath },
		);
	}

	return imported.default;
}

function isModuleNamespace(value: unknown): value is Readonly<Record<string, unknown>> {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isCommonJsConfig(configPath: string): boolean {
	const extension = extname(configPath);
	return extension === ".cjs" || extension === ".cts";
}
