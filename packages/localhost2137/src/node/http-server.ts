import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { Hono } from "hono";
import { responseWithFinalizer } from "../http/response-lifecycle.js";

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
	#activeRequests = 0;
	#address: HttpServerAddress | undefined;
	#closeReport: Promise<void> | undefined;
	#server: Server | undefined;
	#settled: Promise<void> | undefined;
	#start: Promise<HttpServerAddress> | undefined;

	constructor(app: Hono) {
		this.#app = app;
	}

	start(options: Readonly<{ host: LoopbackHost; port: number }>): Promise<HttpServerAddress> {
		if (this.#closeReport) return Promise.reject(new Error("HTTP server shutdown has started."));
		if (this.#start) return this.#start;
		if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
			return Promise.reject(new TypeError("HTTP server port must be an integer from 0 to 65535."));
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
		const server = createAdaptorServer({
			autoCleanupIncoming: true,
			fetch: (request) => this.#dispatch(request),
			overrideGlobalObjects: false,
		}) as Server;
		this.#server = server;
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
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve()));
		});
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
