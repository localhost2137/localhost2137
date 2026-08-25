import { discoverConfigFile, type ConfigDiscoveryOptions } from "./config-discovery.js";
import { importConfigDefault } from "./config-import.js";
import { resolveConfig, type ResolvedConfig } from "./config-resolution.js";

export async function loadResolvedConfig(options: ConfigDiscoveryOptions): Promise<ResolvedConfig> {
	const configPath = await discoverConfigFile(options);
	const rawConfig = await importConfigDefault(configPath);
	return resolveConfig(rawConfig, configPath);
}
