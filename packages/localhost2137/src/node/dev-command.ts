import type { CliDevOptions, CliIo } from "../cli/cli-actions.js";
import { renderDevReady } from "../cli/dev-ready-renderer.js";
import { type DevDaemon, startDevDaemon } from "./dev-daemon.js";

type TerminationSignal = "SIGINT" | "SIGTERM";
const TERMINATION_SIGNALS: readonly TerminationSignal[] = Object.freeze(["SIGINT", "SIGTERM"]);

interface DevCommandSignalSource {
	subscribe(signal: TerminationSignal, listener: () => void): () => void;
}

export interface DevCommandDependencies {
	readonly signals?: DevCommandSignalSource;
	readonly startDaemon?: typeof startDevDaemon;
}

export interface RunDevCommandInput {
	readonly configPath?: string;
	readonly cwd: string;
	readonly io: CliIo;
	readonly options: CliDevOptions;
}

export class SignalInterruption extends Error {
	readonly signal: TerminationSignal;

	constructor(signal: TerminationSignal) {
		super(`Interrupted by ${signal}.`);
		this.name = "SignalInterruption";
		this.signal = signal;
	}
}

export class DevDaemonFatalError extends Error {
	declare readonly cause: unknown;

	constructor(cause: unknown) {
		super("The dev runtime stopped after a fatal server failure.");
		this.name = "DevDaemonFatalError";
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

/** Owns process-signal subscriptions for exactly one foreground dev session. */
export async function runDevCommand(
	input: RunDevCommandInput,
	dependencies: DevCommandDependencies = {},
): Promise<void> {
	const signalEvent = deferred<TerminationSignal>();
	const signals = dependencies.signals ?? nodeSignals;
	const unsubscribe = TERMINATION_SIGNALS.map((signal) =>
		signals.subscribe(signal, () => signalEvent.resolve(signal)),
	);
	let closeAttempted = false;
	let daemon: DevDaemon | undefined;
	try {
		daemon = await (dependencies.startDaemon ?? startDevDaemon)({
			...(input.configPath === undefined ? {} : { configPath: input.configPath }),
			cwd: input.cwd,
			...input.options,
		});
		input.io.writeError(renderDevReady(daemon));
		const outcome = await Promise.race([
			signalEvent.promise.then((signal) => Object.freeze({ kind: "signal" as const, signal })),
			daemon.fatal.then((cause) => Object.freeze({ cause, kind: "fatal" as const })),
		]);
		closeAttempted = true;
		await daemon.close();
		if (outcome.kind === "fatal") throw new DevDaemonFatalError(outcome.cause);
		throw new SignalInterruption(outcome.signal);
	} finally {
		for (const remove of unsubscribe) remove();
		if (daemon && !closeAttempted) await daemon.close();
	}
}

function deferred<Value>(): Readonly<{
	promise: Promise<Value>;
	resolve(value: Value): void;
}> {
	let settled = false;
	let resolvePromise!: (value: Value) => void;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({
		promise,
		resolve(value) {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		},
	});
}

const nodeSignals: DevCommandSignalSource = Object.freeze({
	subscribe(signal: TerminationSignal, listener: () => void) {
		process.on(signal, listener);
		return () => process.off(signal, listener);
	},
});
