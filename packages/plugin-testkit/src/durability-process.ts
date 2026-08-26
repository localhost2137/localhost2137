import type { Serializable } from "node:child_process";
import { SUPERVISOR_SHUTDOWN_MESSAGE } from "./durability-supervisor.js";

export interface SupervisedProcess {
	readonly connected: boolean;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal: "SIGKILL"): boolean;
	send(message: Serializable, callback: (error: Error | null) => void): boolean;
}

export interface SupervisedStopResult {
	readonly exitCode: number | null;
	readonly forced: boolean;
}

export async function stopSupervisedProcess(
	child: SupervisedProcess,
	closed: Promise<number | null>,
	deadlineMs = 2_000,
): Promise<SupervisedStopResult> {
	if (!isActive(child)) {
		return Object.freeze({ exitCode: await withinDeadline(closed, deadlineMs), forced: false });
	}

	let cooperativeFailure: unknown;
	try {
		const outcome = await withinDeadline(cooperativeStop(child, closed), deadlineMs);
		if (outcome.kind === "exit") {
			return Object.freeze({ exitCode: outcome.exitCode, forced: false });
		}
		cooperativeFailure = outcome.cause;
	} catch (cause) {
		cooperativeFailure = cause;
	}

	const forced = isActive(child);
	if (forced) child.kill("SIGKILL");
	try {
		return Object.freeze({
			exitCode: await withinDeadline(closed, deadlineMs),
			forced,
		});
	} catch (cleanupFailure) {
		throw new AggregateError(
			[cooperativeFailure, cleanupFailure],
			"Durability supervisor shutdown and forced cleanup failed.",
		);
	}
}

async function cooperativeStop(
	child: SupervisedProcess,
	closed: Promise<number | null>,
): Promise<
	| Readonly<{ cause: unknown; kind: "delivery-failure" }>
	| Readonly<{ exitCode: number | null; kind: "exit" }>
> {
	if (!child.connected) {
		return Object.freeze({
			cause: new Error("Durability supervisor IPC channel is disconnected."),
			kind: "delivery-failure",
		});
	}
	const delivery = sendShutdown(child);
	return Promise.race([
		closed.then(
			(exitCode) => Object.freeze({ exitCode, kind: "exit" as const }),
			(cause) => Object.freeze({ cause, kind: "delivery-failure" as const }),
		),
		delivery.then(
			() =>
				closed.then(
					(exitCode) => Object.freeze({ exitCode, kind: "exit" as const }),
					(cause) => Object.freeze({ cause, kind: "delivery-failure" as const }),
				),
			(cause) => Object.freeze({ cause, kind: "delivery-failure" as const }),
		),
	]);
}

function sendShutdown(child: SupervisedProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			child.send(SUPERVISOR_SHUTDOWN_MESSAGE, (cause) => (cause ? reject(cause) : resolve()));
		} catch (cause) {
			reject(cause);
		}
	});
}

function isActive(child: SupervisedProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

class ProcessCleanupTimeoutError extends Error {
	constructor() {
		super("Durability process exceeded its cleanup deadline.");
		this.name = "ProcessCleanupTimeoutError";
	}
}

async function withinDeadline<Value>(promise: Promise<Value>, deadlineMs: number): Promise<Value> {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new ProcessCleanupTimeoutError()), deadlineMs);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
