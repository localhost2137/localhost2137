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

export interface HttpServerOptions {
	readonly host: LoopbackHost;
	readonly port: number;
}

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
	#closingServer = false;
	#fatalNotified = false;
	readonly #fatalListeners = new Set<(cause: unknown) => void>();
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

	onFatal(listener: (cause: unknown) => void): () => void {
		this.#fatalListeners.add(listener);
		return () => this.#fatalListeners.delete(listener);
	}

	start(options: HttpServerOptions): Promise<HttpServerAddress> {
		if (this.#settled || this.#closeReport)
			return Promise.reject(new Error("HTTP server shutdown has started."));
		if (this.#start) return this.#start;
		let ownedOptions: HttpServerOptions;
		try {
			ownedOptions = ownHttpServerOptions(options);
		} catch (cause) {
			return Promise.reject(cause);
		}
		this.#start = this.#startServer(ownedOptions);
		return this.#start;
	}

	close(timeoutMs: number): Promise<void> {
		if (this.#closeReport) return this.#closeReport;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
			return Promise.reject(new TypeError("HTTP close timeoutMs must be a non-negative integer."));
		}
		this.#beginShutdown();
		if (!this.#settled) throw new Error("HTTP shutdown did not publish its settlement.");
		this.#closeReport = reportDeadline(this.#settled, timeoutMs, () => this.#activeRequests);
		return this.#closeReport;
	}

	settled(): Promise<void> {
		if (!this.#settled) {
			throw new TypeError("HTTP server settlement is available only after shutdown starts.");
		}
		return this.#settled;
	}

	async #startServer(options: HttpServerOptions): Promise<HttpServerAddress> {
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
				this.#requestFinished();
			});
		} catch (cause) {
			this.#requestFinished();
			throw cause;
		}
	}

	async #closeServer(): Promise<void> {
		await this.#start?.catch(() => undefined);
		const server = this.#server;
		if (!server || !this.#address) return;
		this.#closingServer = true;
		const closeFailure = await new Promise<unknown>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve(undefined)));
			if (this.#activeRequests === 0) server.closeIdleConnections();
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

	#requestFinished(): void {
		this.#activeRequests -= 1;
		if (this.#closingServer && this.#activeRequests === 0) {
			const server = this.#server;
			server?.closeIdleConnections();
			setImmediate(() => {
				if (this.#closingServer && this.#activeRequests === 0) server?.closeIdleConnections();
			});
		}
	}

	#handlePostListenError(cause: unknown): void {
		if (!this.#listening) return;
		this.#postListenFailures.push(cause);
		this.#beginShutdown();
		if (this.#fatalNotified) return;
		this.#fatalNotified = true;
		for (const listener of this.#fatalListeners) {
			try {
				listener(cause);
			} catch {
				// Observers cannot escape the transport's owned error boundary.
			}
		}
	}

	#beginShutdown(): void {
		if (this.#settled) return;
		this.#settled = this.#closeServer();
		void this.#settled.catch(() => undefined);
	}
}

export function ownHttpServerOptions(options: unknown): HttpServerOptions {
	if (typeof options !== "object" || options === null) {
		throw new TypeError("HTTP server options must be an object.");
	}
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("HTTP server options must be a plain object.");
	}
	const hostDescriptor = Object.getOwnPropertyDescriptor(options, "host");
	const portDescriptor = Object.getOwnPropertyDescriptor(options, "port");
	if (!hostDescriptor || !("value" in hostDescriptor)) {
		throw new TypeError("HTTP server host must be an own data property.");
	}
	if (!portDescriptor || !("value" in portDescriptor)) {
		throw new TypeError("HTTP server port must be an own data property.");
	}
	const host = hostDescriptor.value;
	const port = portDescriptor.value;
	if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
		throw new TypeError("HTTP server host must be localhost, 127.0.0.1, or ::1.");
	}
	if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) > 65_535) {
		throw new TypeError("HTTP server port must be an integer from 0 to 65535.");
	}
	return Object.freeze({ host, port: port as number });
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
