import type { Context } from "hono";
import type { SlackConfig } from "../config.js";
import type { SlackUser } from "../domain/models.js";
import { SlackError } from "../domain/slack-error.js";
import type { SlackState } from "../state.js";
import type { PluginEnv } from "localhost2137";

export interface SlackRequestArguments {
	readonly formToken?: string;
	readonly values: Readonly<Record<string, boolean | number | string>>;
}

export async function readSlackRequest(
	context: Context<PluginEnv<SlackState, SlackConfig>>,
): Promise<SlackRequestArguments> {
	const query = readUrlEncoded(new URL(context.req.url).searchParams);
	if (context.req.method === "GET") return Object.freeze({ values: query });

	const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (!contentType) return Object.freeze({ values: query });
	if (contentType === "application/x-www-form-urlencoded") {
		const form = readUrlEncoded(new URLSearchParams(await context.req.text()));
		return Object.freeze({
			...(typeof form.token === "string" ? { formToken: form.token } : {}),
			values: Object.freeze({ ...query, ...form }),
		});
	}
	if (contentType === "application/json") {
		const body = await context.req.json().catch(() => {
			throw new SlackError("invalid_arguments", "Slack request body is not valid JSON.");
		});
		if (!isPlainObject(body)) {
			throw new SlackError("invalid_arguments", "Slack JSON request body must be an object.");
		}
		const values: Record<string, boolean | number | string> = { ...query };
		for (const [key, value] of Object.entries(body)) {
			if (value === null || !["boolean", "number", "string"].includes(typeof value)) {
				throw new SlackError("invalid_arguments", `Slack argument ${key} must be scalar.`);
			}
			values[key] = value as boolean | number | string;
		}
		return Object.freeze({ values: Object.freeze(values) });
	}
	throw new SlackError(
		"invalid_arguments",
		`Unsupported Slack request content type ${contentType}.`,
	);
}

export function authenticateSlackRequest(
	context: Context<PluginEnv<SlackState, SlackConfig>>,
	request: SlackRequestArguments,
): SlackUser {
	const authorization = context.req.header("authorization");
	let token: string | undefined;
	if (authorization !== undefined) {
		const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
		if (!match?.[1]) throw new SlackError("invalid_auth", "Slack bearer token is malformed.");
		token = match[1];
	} else {
		token = request.formToken;
	}
	if (!token) throw new SlackError("not_authed", "Slack request has no authentication token.");
	return context.get("lh").state.service.authenticate(token);
}

export function optionalString(request: SlackRequestArguments, name: string): string | undefined {
	const value = request.values[name];
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") {
		throw new SlackError("invalid_arguments", `Slack argument ${name} must be a string.`);
	}
	return value;
}

export function requiredString(
	request: SlackRequestArguments,
	name: string,
	error: "channel_not_found" | "missing_argument" | "no_text" = "missing_argument",
): string {
	const value = optionalString(request, name);
	if (!value) throw new SlackError(error, `Slack argument ${name} is required.`);
	return value;
}

export function optionalBoolean(request: SlackRequestArguments, name: string): boolean | undefined {
	const value = request.values[name];
	if (value === undefined || value === "") return undefined;
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new SlackError("invalid_arguments", `Slack argument ${name} must be a boolean.`);
}

function readUrlEncoded(parameters: URLSearchParams): Readonly<Record<string, string>> {
	const values: Record<string, string> = {};
	for (const key of new Set(parameters.keys())) {
		const matches = parameters.getAll(key);
		if (matches.length !== 1) {
			throw new SlackError("invalid_arguments", `Slack argument ${key} may appear only once.`);
		}
		const value = matches[0];
		if (value !== undefined) values[key] = value;
	}
	return Object.freeze(values);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
