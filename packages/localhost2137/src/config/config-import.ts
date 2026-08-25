import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ConfigError } from "./config-error.js";

export async function importConfigDefault(configPath: string): Promise<unknown> {
	let imported: unknown;
	try {
		imported = await tsImport(pathToFileURL(configPath).href, import.meta.url);
	} catch (cause) {
		throw new ConfigError(
			"CONFIG_IMPORT_FAILED",
			`Failed to import localhost2137 config at ${configPath}.`,
			{ configPath },
			cause,
		);
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
