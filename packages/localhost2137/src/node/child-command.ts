import { type ChildProcess, spawn } from "node:child_process";

const FORWARDED_SIGNALS: readonly ["SIGINT", "SIGTERM", "SIGHUP"] = Object.freeze([
	"SIGINT",
	"SIGTERM",
	"SIGHUP",
]);
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export interface ChildCommandOptions {
	readonly argv: readonly string[];
	readonly connectionEnv: Readonly<Record<string, string>>;
	readonly cwd: string;
	readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
}

export interface ChildCommandDependencies {
	readonly signals?: ChildCommandSignalSource;
	readonly spawn?: ChildCommandSpawner;
}

export interface ChildCommandSignalSource {
	subscribe(signal: ForwardedSignal, listener: () => void): () => void;
}

export type ChildCommandSpawner = (
	file: string,
	arguments_: readonly string[],
	options: Readonly<{
		cwd: string;
		env: Readonly<Record<string, string | undefined>>;
		shell: false;
		stdio: "inherit";
	}>,
) => ChildProcess;

export class ChildCommandStartError extends Error {
	declare readonly cause: unknown;
	readonly file: string;

	constructor(file: string, cause: unknown) {
		super(`Could not start child command ${JSON.stringify(file)}.`);
		this.name = "ChildCommandStartError";
		this.file = file;
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

export class ChildSignalForwardError extends Error {
	declare readonly cause: unknown;
	readonly signal: ForwardedSignal;

	constructor(signal: ForwardedSignal, cause: unknown) {
		super(`Could not forward ${signal} to the child command.`);
		this.name = "ChildSignalForwardError";
		this.signal = signal;
		Object.defineProperty(this, "cause", {
			configurable: false,
			enumerable: false,
			value: cause,
			writable: false,
		});
	}
}

/** Runs exactly one child with inherited stdio; it does not restart or supervise it. */
export async function runChildCommand(
	optionsValue: ChildCommandOptions,
	dependencies: ChildCommandDependencies = {},
): Promise<number> {
	const options = ownOptions(optionsValue);
	const spawnChild = dependencies.spawn ?? nodeSpawn;
	const signals = dependencies.signals ?? nodeSignals;
	const [file, ...arguments_] = options.argv;
	if (!file) throw new TypeError("Child command argv must not be empty.");
	let child: ChildProcess;
	try {
		child = spawnChild(file, arguments_, {
			cwd: options.cwd,
			env: Object.freeze({ ...options.inheritedEnv, ...options.connectionEnv }),
			shell: false,
			stdio: "inherit",
		});
	} catch (cause) {
		throw new ChildCommandStartError(file, cause);
	}

	let forwardFailure: ChildSignalForwardError | undefined;
	const unsubscribe = FORWARDED_SIGNALS.map((signal) =>
		signals.subscribe(signal, () => {
			try {
				child.kill(signal);
			} catch (cause) {
				forwardFailure ??= new ChildSignalForwardError(signal, cause);
			}
		}),
	);
	try {
		const outcome = await childOutcome(child, file);
		if (forwardFailure) throw forwardFailure;
		return outcome;
	} finally {
		for (const remove of unsubscribe) remove();
	}
}

function childOutcome(child: ChildProcess, file: string): Promise<number> {
	return new Promise((resolve, reject) => {
		let settled = false;
		child.once("error", (cause) => {
			if (settled) return;
			settled = true;
			reject(new ChildCommandStartError(file, cause));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			if (code !== null) {
				resolve(code);
				return;
			}
			resolve(signalExitCode(signal));
		});
	});
}

function ownOptions(value: unknown): ChildCommandOptions {
	if (!isPlainRecord(value)) throw new TypeError("Child command options must be a plain object.");
	const argv = stringArray(dataProperty(value, "argv"), "argv");
	if (argv.length === 0) throw new TypeError("Child command argv must not be empty.");
	const cwd = safeText(dataProperty(value, "cwd"), "cwd");
	const connectionEnv = stringRecord(dataProperty(value, "connectionEnv"), "connectionEnv", false);
	const inheritedEnv = stringRecord(dataProperty(value, "inheritedEnv"), "inheritedEnv", true);
	return Object.freeze({ argv, connectionEnv, cwd, inheritedEnv });
}

function stringArray(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`Child command ${label} must be an array.`);
	return Object.freeze(value.map((entry) => safeText(entry, label)));
}

function stringRecord(
	value: unknown,
	label: string,
	allowUndefined: false,
): Readonly<Record<string, string>>;
function stringRecord(
	value: unknown,
	label: string,
	allowUndefined: true,
): Readonly<Record<string, string | undefined>>;
function stringRecord(
	value: unknown,
	label: string,
	allowUndefined: boolean,
): Readonly<Record<string, string | undefined>> {
	if (!isRecord(value) || (!allowUndefined && !isPlainRecord(value))) {
		throw new TypeError(
			`Child command ${label} must be ${allowUndefined ? "an object" : "a plain object"}.`,
		);
	}
	const result: Record<string, string | undefined> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
			throw new TypeError(`Child command ${label} must contain string data properties.`);
		}
		if (key.includes("\0")) throw new TypeError(`Child command ${label} names cannot contain NUL.`);
		if (descriptor.value === undefined && allowUndefined) {
			defineEntry(result, key, undefined);
		} else {
			defineEntry(result, key, safeText(descriptor.value, `${label}.${key}`, true));
		}
	}
	return Object.freeze(result);
}

function safeText(value: unknown, label: string, allowEmpty: boolean = false): string {
	if (typeof value !== "string" || (!allowEmpty && value === "") || value.includes("\0")) {
		throw new TypeError(
			`Child command ${label} must be a ${allowEmpty ? "NUL-free" : "non-empty"} string.`,
		);
	}
	return value;
}

function dataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor?.enumerable || !("value" in descriptor)) {
		throw new TypeError(`Child command option ${key} must be an enumerable data property.`);
	}
	return descriptor.value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineEntry(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	});
}

function signalExitCode(signal: NodeJS.Signals | null): number {
	switch (signal) {
		case "SIGHUP":
			return 129;
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		default:
			return 1;
	}
}

const nodeSpawn: ChildCommandSpawner = (file, arguments_, options) =>
	spawn(file, [...arguments_], options);

const nodeSignals: ChildCommandSignalSource = Object.freeze({
	subscribe(signal: ForwardedSignal, listener: () => void) {
		process.on(signal, listener);
		return () => process.off(signal, listener);
	},
});
