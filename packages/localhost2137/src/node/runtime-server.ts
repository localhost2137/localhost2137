import {
	type HttpServerAddress,
	type LoopbackHost,
	validateHttpServerOptions,
} from "./http-server.js";

export interface InstanceRuntimeOwner {
	settled(): Promise<void>;
	startPersisted(): Promise<void>;
	stopAll(options: Readonly<{ timeoutMs: number }>): Promise<void>;
}

export interface HttpServerOwner {
	close(timeoutMs: number): Promise<void>;
	settled(): Promise<void>;
	start(options: Readonly<{ host: LoopbackHost; port: number }>): Promise<HttpServerAddress>;
}

export class RuntimeServer {
	readonly #http: HttpServerOwner;
	readonly #runtime: InstanceRuntimeOwner;
	#closeReport: Promise<void> | undefined;
	#settled: Promise<void> | undefined;
	#start: Promise<HttpServerAddress> | undefined;

	constructor(runtime: InstanceRuntimeOwner, http: HttpServerOwner) {
		this.#runtime = runtime;
		this.#http = http;
	}

	start(options: Readonly<{ host: LoopbackHost; port: number }>): Promise<HttpServerAddress> {
		if (this.#closeReport) return Promise.reject(new Error("Runtime server shutdown has started."));
		try {
			validateHttpServerOptions(options);
		} catch (cause) {
			return Promise.reject(cause);
		}
		this.#start ??= this.#startOwned(options);
		return this.#start;
	}

	close(timeoutMs: number): Promise<void> {
		if (this.#closeReport) return this.#closeReport;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
			return Promise.reject(
				new TypeError("Runtime close timeoutMs must be a non-negative integer."),
			);
		}
		const httpReport = invokeOwner(() => this.#http.close(timeoutMs));
		const runtimeReport = invokeOwner(() => this.#runtime.stopAll({ timeoutMs }));
		const httpSettlement = invokeOwner(() => this.#http.settled());
		const runtimeSettlement = invokeOwner(() => this.#runtime.settled());
		this.#settled = settleOwners([httpSettlement, runtimeSettlement]);
		void this.#settled.catch(() => undefined);
		this.#closeReport = settleOwners([httpReport, runtimeReport]);
		return this.#closeReport;
	}

	settled(): Promise<void> {
		if (!this.#settled) {
			throw new TypeError("Runtime server settlement is available only after shutdown starts.");
		}
		return this.#settled;
	}

	async #startOwned(
		options: Readonly<{ host: LoopbackHost; port: number }>,
	): Promise<HttpServerAddress> {
		await this.#runtime.startPersisted();
		try {
			return await this.#http.start(options);
		} catch (cause) {
			const cleanupFailures: unknown[] = [cause];
			await this.#runtime
				.stopAll({ timeoutMs: 30_000 })
				.catch((failure: unknown) => cleanupFailures.push(failure));
			await this.#runtime.settled().catch((failure: unknown) => cleanupFailures.push(failure));
			throw new AggregateError(cleanupFailures, "Runtime HTTP startup failed.");
		}
	}
}

function invokeOwner(start: () => Promise<void>): Promise<void> {
	try {
		return start();
	} catch (cause) {
		return Promise.reject(cause);
	}
}

async function settleOwners(promises: readonly Promise<void>[]): Promise<void> {
	const results = await Promise.allSettled(promises);
	const failures = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (failures.length > 0)
		throw new AggregateError(failures, "Runtime server shutdown had failures.");
}
