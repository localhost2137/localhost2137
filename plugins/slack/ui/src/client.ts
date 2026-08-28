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
			requestJson<SlackUiCreateChannelResponse>(
				options,
				slackUiRoutes.channels,
				{
					body: JSON.stringify(input),
					headers: jsonHeaders(),
					method: "POST",
					...(signal ? { signal } : {}),
				},
				trustContract,
			),
		joinChannel: (input, signal) =>
			requestJson<SlackUiMembershipResponse>(
				options,
				slackUiRoutes.memberships,
				{
					body: JSON.stringify(input),
					headers: jsonHeaders(),
					method: "POST",
					...(signal ? { signal } : {}),
				},
				trustContract,
			),
		sendMessage: (input, signal) =>
			requestJson<SlackUiCreateMessageResponse>(
				options,
				slackUiRoutes.messages,
				{
					body: JSON.stringify(input),
					headers: jsonHeaders(),
					method: "POST",
					...(signal ? { signal } : {}),
				},
				trustContract,
			),
		snapshot: (channel, signal) => {
			const url = new URL(slackUiRoutes.snapshot, options.baseUrl());
			if (channel) url.searchParams.set("channel", channel);
			return requestJson(options, url, signal ? { signal } : {}, decodeSnapshot);
		},
	};
	return Object.freeze(client);
}

async function requestJson<Value>(
	options: SlackDashboardClientOptions,
	path: string | URL,
	init: RequestInit,
	decode: (value: unknown, status: number) => Value,
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
	const value: unknown = await response.json().catch(() => {
		throw invalidResponse(response.status, "The local Slack dashboard received invalid JSON.");
	});
	if (!response.ok) throw responseError(response.status, value);
	return decode(value, response.status);
}

function decodeSnapshot(value: unknown, status: number): SlackUiSnapshot {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.channels) ||
		!Array.isArray(value.messages) ||
		!Array.isArray(value.users) ||
		typeof value.hasMoreMessages !== "boolean" ||
		(value.selectedChannelId !== null && typeof value.selectedChannelId !== "string") ||
		!isRecord(value.workspace) ||
		typeof value.workspace.id !== "string" ||
		typeof value.workspace.name !== "string"
	) {
		throw invalidResponse(status, "The local Slack dashboard snapshot is incompatible.");
	}
	return value as unknown as SlackUiSnapshot;
}

function trustContract<Value>(value: unknown): Value {
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
		isRecord(value) &&
		"error" in value &&
		isRecord(value.error) &&
		"code" in value.error &&
		typeof value.error.code === "string" &&
		"message" in value.error &&
		typeof value.error.message === "string"
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(status: number, message: string): SlackDashboardRequestError {
	return new SlackDashboardRequestError(status, "invalid_response", message);
}

function jsonHeaders(): Readonly<Record<string, string>> {
	return { "content-type": "application/json" };
}

export const slackDashboardClient: SlackDashboardClient = createSlackDashboardClient({
	baseUrl: () => document.baseURI,
	fetch: globalThis.fetch.bind(globalThis),
});
