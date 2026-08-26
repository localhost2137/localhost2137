import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUPERVISOR_SHUTDOWN_MESSAGE = "localhost2137:plugin-testkit:shutdown:v1";

export interface SupervisorProtocolSource {
	emitInterrupt(): void;
	onDisconnect(listener: () => void): () => void;
	onMessage(listener: (message: unknown) => void): () => void;
}

export function installSupervisorProtocol(source: SupervisorProtocolSource): () => void {
	let settled = false;
	let removeDisconnect: () => void = () => undefined;
	let removeMessage: () => void = () => undefined;
	const settle = (): void => {
		if (settled) return;
		settled = true;
		removeMessage();
		removeDisconnect();
		source.emitInterrupt();
	};
	removeMessage = source.onMessage((message) => {
		if (message === SUPERVISOR_SHUTDOWN_MESSAGE) settle();
	});
	removeDisconnect = source.onDisconnect(settle);
	return () => {
		if (settled) return;
		settled = true;
		removeMessage();
		removeDisconnect();
	};
}

export function ownSupervisorCliArguments(value: readonly string[]): readonly string[] {
	const [configFlag, configPath, instanceId, portFlag, port, ...extra] = value;
	if (
		configFlag !== "--config" ||
		!configPath ||
		!isAbsolute(configPath) ||
		configPath.includes("\0") ||
		instanceId !== "dev" ||
		portFlag !== "--port" ||
		!port ||
		extra.length > 0
	) {
		throw new TypeError("Durability supervisor received invalid CLI arguments.");
	}
	if (!/^[1-9]\d{0,4}$/.test(port)) {
		throw new TypeError("Durability supervisor port must be a canonical decimal integer.");
	}
	const portNumber = Number(port);
	if (!Number.isSafeInteger(portNumber) || portNumber > 65_535) {
		throw new TypeError("Durability supervisor port is outside the TCP port range.");
	}
	return Object.freeze(["--config", configPath, "dev", "--port", port]);
}

export async function resolveSupervisorHostBin(): Promise<string> {
	const manifestPath = fileURLToPath(import.meta.resolve("localhost2137/package.json"));
	const packageRoot = dirname(manifestPath);
	const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
	if (typeof manifest !== "object" || manifest === null) {
		throw new TypeError("localhost2137 package manifest must be an object.");
	}
	const bin = Reflect.get(manifest, "bin");
	const target =
		typeof bin === "object" && bin !== null ? Reflect.get(bin, "localhost") : undefined;
	if (typeof target !== "string" || isAbsolute(target)) {
		throw new TypeError("localhost2137 package manifest must declare a relative bin.localhost.");
	}
	const candidate = resolve(packageRoot, target);
	if (!isWithin(packageRoot, candidate)) {
		throw new TypeError("localhost2137 bin.localhost resolves outside its package root.");
	}
	const [realRoot, realBin] = await Promise.all([realpath(packageRoot), realpath(candidate)]);
	if (!isWithin(realRoot, realBin)) {
		throw new TypeError(
			"localhost2137 bin.localhost resolves through a path outside its package root.",
		);
	}
	return realBin;
}

async function runSupervisor(): Promise<void> {
	if (!process.send) throw new TypeError("Durability supervisor requires an IPC channel.");
	const bin = await resolveSupervisorHostBin();
	const cliArguments = ownSupervisorCliArguments(process.argv.slice(2));
	process.argv = [process.execPath, bin, ...cliArguments];
	const removeProtocol = installSupervisorProtocol({
		emitInterrupt: () => {
			process.emit("SIGINT");
		},
		onDisconnect(listener) {
			process.on("disconnect", listener);
			return () => process.off("disconnect", listener);
		},
		onMessage(listener) {
			process.on("message", listener);
			return () => process.off("message", listener);
		},
	});
	try {
		await import(pathToFileURL(bin).href);
	} finally {
		removeProtocol();
	}
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runSupervisor();
}
