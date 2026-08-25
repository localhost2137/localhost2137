import { dirname, resolve } from "node:path";
import { readConfiguredService } from "../authoring/plugin.js";
import { type ConfigIssue, issuePath, receivedType } from "./config-error.js";
import { createConfigFingerprint } from "./config-fingerprint.js";
import {
	resolveConfiguredService,
	type ResolvedServiceConfig,
} from "./configured-service-resolution.js";
import { validateServiceKey } from "./plugin-definition-validation.js";
import { invalidConfig, parseRuntimeConfig } from "./runtime-config.js";

export interface ResolvedConfig {
	readonly clock: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>;
	readonly configDirectory: string;
	readonly configPath: string;
	readonly fingerprint: string;
	readonly host: "127.0.0.1" | "localhost" | "::1";
	readonly port: number;
	readonly seed?: (...arguments_: readonly unknown[]) => unknown;
	readonly services: Readonly<Record<string, ResolvedServiceConfig>>;
	readonly storage: Readonly<{ dir: string }>;
}

export interface PathSemantics {
	dirname(path: string): string;
	resolve(...paths: string[]): string;
}

export function resolvePathFromConfig(
	configPath: string,
	configuredPath: string,
	pathSemantics: PathSemantics = { dirname, resolve },
): string {
	return pathSemantics.resolve(pathSemantics.dirname(configPath), configuredPath);
}

export function resolveConfig(rawConfig: unknown, configPath: string): ResolvedConfig {
	const parsed = parseRuntimeConfig(rawConfig, configPath);
	const issues: ConfigIssue[] = [];
	const causes: unknown[] = [];
	const services: Record<string, ResolvedServiceConfig> = {};
	const environmentOwners = new Map<string, string>();
	const baseUrl = formatBaseUrl(parsed.host, parsed.port);

	for (const [serviceKey, configuredValue] of Object.entries(parsed.services)) {
		const descriptor = readConfiguredService(configuredValue);
		if (!descriptor) {
			issues.push({
				code: "service_descriptor",
				expected: "a value returned by a definePlugin factory",
				message: `Service "${serviceKey}" is not a configured plugin descriptor.`,
				path: issuePath(["services", serviceKey]),
				received: receivedType(configuredValue),
				serviceKey,
			});
			continue;
		}

		validateServiceKey(serviceKey, issues);
		const service = resolveConfiguredService({
			baseUrl,
			causes,
			descriptor,
			environmentOwners,
			issues,
			serviceKey,
		});
		if (service) services[serviceKey] = service;
	}

	if (issues.length > 0) throw invalidConfig(configPath, issues, causes);

	const storageDirectory = resolvePathFromConfig(configPath, parsed.storage.dir);
	const immutableServices = Object.freeze({ ...services });
	const fingerprint = createConfigFingerprint({
		clock: parsed.clock,
		host: parsed.host,
		port: parsed.port,
		services: Object.fromEntries(
			Object.entries(immutableServices).map(([key, service]) => [
				key,
				{
					config: service.config,
					exportEnv: service.exportEnv,
					operations: Object.keys(service.operations),
					pluginId: service.pluginId,
					...(service.seed === undefined ? {} : { seed: service.seed }),
					stateVersion: service.stateVersion,
				},
			]),
		),
		storageDirectory,
	});

	return Object.freeze({
		clock: Object.freeze({ ...parsed.clock }),
		configDirectory: dirname(configPath),
		configPath,
		fingerprint,
		host: parsed.host,
		port: parsed.port,
		...(parsed.seed ? { seed: parsed.seed } : {}),
		services: immutableServices,
		storage: Object.freeze({ dir: storageDirectory }),
	});
}

function formatBaseUrl(host: "127.0.0.1" | "localhost" | "::1", port: number): string {
	return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}
