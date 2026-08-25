import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { Hono } from "hono";
import { responseWithFinalizer } from "../http/response-lifecycle.js";

type AdapterServerFactory = (options: Parameters<typeof createAdaptorServer>[0]) => Server;

export interface HttpServerAddress {
	readonly host: LoopbackHost;
	readonly port: number;
	readonly url: string;
}

export type LoopbackHost = "127.0.0.1" | "::1" | "localhost";

export class HttpServerCloseTimeoutError extends Error {
	readonly activeRequests: number;
	readonly timeoutMs: number;

	constructor(timeoutMs: number, activeRequests: number) {
		super(
			`Timed out closing the HTTP server after ${timeoutMs}ms (${activeRequests} active request${activeRequests === 1 ? "" : "s"}).`,
		);
		this.name = "HttpServerCloseTimeoutError";
		this.timeoutMs = timeoutMs;
		this.activeRequests = activeRequests;
	}
}

export class NodeHttpServer {
	readonly #app: Hono;
	readonly #createServer: AdapterServerFactory;
	#activeRequests = 0;
	#address: HttpServerAddress | undefined;
	#closeReport: Promise<void> | undefined;
	#listening = false;
	readonly #postListenFailures: unknown[] = [];
	#server: Server | undefined;
	#settled: Promise<void> | undefined;
	#start: Promise<HttpServerAddress> | undefined;

	constructor(
		app: Hono,
		createServer: AdapterServerFactory = createAdaptorServer as AdapterServerFactory,
	) {
		this.#app = app;
		this.#createServer = createServer;
	}

	start(options: Readonly<{ host: LoopbackHost; port: number }>): Promise<HttpServerAddress> {
		if (this.#closeReport) return Promise.reject(new Error("HTTP server shutdown has started."));
		if (this.#start) return this.#start;
		try {
			validateHttpServerOptions(options);
		} catch (cause) {
			return Promise.reject(cause);
		}
		this.#start = this.#startServer(options);
		return this.#start;
	}

	close(timeoutMs: number): Promise<void> {
		if (this.#closeReport) return this.#closeReport;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
			return Promise.reject(new TypeError("HTTP close timeoutMs must be a non-negative integer."));
		}
		this.#settled = this.#closeServer();
		void this.#settled.catch(() => undefined);
		this.#closeReport = reportDeadline(this.#settled, timeoutMs, () => this.#activeRequests);
		return this.#closeReport;
	}

	settled(): Promise<void> {
		if (!this.#settled) {
			throw new TypeError("HTTP server settlement is available only after shutdown starts.");
		}
		return this.#settled;
	}

	async #startServer(
		options: Readonly<{ host: LoopbackHost; port: number }>,
	): Promise<HttpServerAddress> {
		const server = this.#createServer({
			autoCleanupIncoming: true,
			fetch: (request) => this.#dispatch(request),
			overrideGlobalObjects: false,
		}) as Server;
		this.#server = server;
		server.on("error", (cause) => this.#handlePostListenError(cause));
		const address = await new Promise<AddressInfo>((resolve, reject) => {
			const error = (cause: Error) => {
				server.removeListener("listening", listening);
				reject(cause);
			};
			const listening = () => {
				server.removeListener("error", error);
				const value = server.address();
				if (!value || typeof value === "string") {
					reject(new Error("HTTP server did not expose a TCP address."));
					return;
				}
				this.#listening = true;
				resolve(value);
			};
			server.once("error", error);
			server.once("listening", listening);
			server.listen({ host: options.host, port: options.port });
		});
		const result = Object.freeze({
			host: options.host,
			port: address.port,
			url: `http://${options.host === "::1" ? `[${options.host}]` : options.host}:${address.port}`,
		});
		this.#address = result;
		return result;
	}

	async #dispatch(request: Request): Promise<Response> {
		this.#activeRequests += 1;
		try {
			const response = await this.#app.fetch(request);
			return responseWithFinalizer(response, () => {
				this.#activeRequests -= 1;
			});
		} catch (cause) {
			this.#activeRequests -= 1;
			throw cause;
		}
	}

	async #closeServer(): Promise<void> {
		await this.#start?.catch(() => undefined);
		const server = this.#server;
		if (!server || !this.#address) return;
		const closeFailure = await new Promise<unknown>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve(undefined)));
		}).catch((cause: unknown) => cause);
		this.#listening = false;
		const failures = [
			...this.#postListenFailures,
			...(closeFailure === undefined ? [] : [closeFailure]),
		];
		if (failures.length > 0) {
			throw new AggregateError(failures, "HTTP server failed after it started listening.");
		}
	}

	#handlePostListenError(cause: unknown): void {
		if (!this.#listening) return;
		this.#postListenFailures.push(cause);
		if (this.#closeReport) return;
		this.#settled = this.#closeServer();
		void this.#settled.catch(() => undefined);
		this.#closeReport = this.#settled;
	}
}

export function validateHttpServerOptions(
	options: Readonly<{ host: unknown; port: unknown }>,
): asserts options is Readonly<{ host: LoopbackHost; port: number }> {
	if (typeof options !== "object" || options === null) {
		throw new TypeError("HTTP server options must be an object.");
	}
	if (options.host !== "127.0.0.1" && options.host !== "::1" && options.host !== "localhost") {
		throw new TypeError("HTTP server host must be localhost, 127.0.0.1, or ::1.");
	}
	if (
		!Number.isSafeInteger(options.port) ||
		(options.port as number) < 0 ||
		(options.port as number) > 65_535
	) {
		throw new TypeError("HTTP server port must be an integer from 0 to 65535.");
	}
}

async function reportDeadline(
	settled: Promise<void>,
	timeoutMs: number,
	activeRequests: () => number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new HttpServerCloseTimeoutError(timeoutMs, activeRequests())),
			timeoutMs,
		);
	});
	try {
		await Promise.race([settled, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
