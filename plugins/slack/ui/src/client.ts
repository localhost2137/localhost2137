import {
	type SlackUiCreateChannelInput,
	type SlackUiCreateChannelResponse,
	type SlackUiCreateMessageInput,
	type SlackUiCreateMessageResponse,
	type SlackUiErrorResponse,
	type SlackUiMembershipInput,
	type SlackUiMembershipResponse,
	type SlackUiSnapshot,
	slackUiRoutes,
} from "../../src/ui/contract.js";

const REQUEST_TIMEOUT_MS = 5_000;

export interface SlackDashboardClient {
	createChannel(
		input: SlackUiCreateChannelInput,
		signal?: AbortSignal,
	): Promise<SlackUiCreateChannelResponse>;
	joinChannel(
		input: SlackUiMembershipInput,
		signal?: AbortSignal,
	): Promise<SlackUiMembershipResponse>;
	sendMessage(
		input: SlackUiCreateMessageInput,
		signal?: AbortSignal,
	): Promise<SlackUiCreateMessageResponse>;
	snapshot(channel: string | null, signal?: AbortSignal): Promise<SlackUiSnapshot>;
}

export interface SlackDashboardClientOptions {
	readonly baseUrl: () => string;
	readonly fetch: typeof globalThis.fetch;
}

export class SlackDashboardRequestError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "SlackDashboardRequestError";
		this.code = code;
		this.status = status;
	}
}

export function createSlackDashboardClient(
	options: SlackDashboardClientOptions,
): SlackDashboardClient {
	const client: SlackDashboardClient = {
		createChannel: (input, signal) =>
			requestJson<SlackUiCreateChannelResponse>(options, slackUiRoutes.channels, {
				body: JSON.stringify(input),
				headers: jsonHeaders(),
				method: "POST",
				...(signal ? { signal } : {}),
			}),
		joinChannel: (input, signal) =>
			requestJson<SlackUiMembershipResponse>(options, slackUiRoutes.memberships, {
				body: JSON.stringify(input),
				headers: jsonHeaders(),
				method: "POST",
				...(signal ? { signal } : {}),
			}),
		sendMessage: (input, signal) =>
			requestJson<SlackUiCreateMessageResponse>(options, slackUiRoutes.messages, {
				body: JSON.stringify(input),
				headers: jsonHeaders(),
				method: "POST",
				...(signal ? { signal } : {}),
			}),
		snapshot: (channel, signal) => {
			const url = new URL(slackUiRoutes.snapshot, options.baseUrl());
			if (channel) url.searchParams.set("channel", channel);
			return requestJson<SlackUiSnapshot>(options, url, signal ? { signal } : {});
		},
	};
	return Object.freeze(client);
}

async function requestJson<Value>(
	options: SlackDashboardClientOptions,
	path: string | URL,
	init: RequestInit,
): Promise<Value> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
	const response = await options.fetch(new URL(path, options.baseUrl()), {
		...init,
		cache: "no-store",
		headers: { accept: "application/json", ...init.headers },
		signal,
	});
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) {
		throw new SlackDashboardRequestError(
			response.status,
			"invalid_response",
			"The local Slack dashboard received a non-JSON response.",
		);
	}
	const value: unknown = await response.json();
	if (!response.ok) throw responseError(response.status, value);
	return value as Value;
}

function responseError(status: number, value: unknown): SlackDashboardRequestError {
	if (isErrorResponse(value)) {
		return new SlackDashboardRequestError(status, value.error.code, value.error.message);
	}
	return new SlackDashboardRequestError(
		status,
		"request_failed",
		`The local Slack dashboard request failed with HTTP ${String(status)}.`,
	);
}

function isErrorResponse(value: unknown): value is SlackUiErrorResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"error" in value &&
		typeof value.error === "object" &&
		value.error !== null &&
		"code" in value.error &&
		typeof value.error.code === "string" &&
		"message" in value.error &&
		typeof value.error.message === "string"
	);
}

function jsonHeaders(): Readonly<Record<string, string>> {
	return { "content-type": "application/json" };
}

export const slackDashboardClient: SlackDashboardClient = createSlackDashboardClient({
	baseUrl: () => document.baseURI,
	fetch: globalThis.fetch.bind(globalThis),
});
