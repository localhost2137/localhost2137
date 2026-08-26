import type { Context } from "hono";
import type { PluginEnv } from "localhost2137";
import type { StripeConfig } from "../config.js";
import { StripeError } from "../domain/stripe-error.js";
import type { StripeState } from "../state.js";

export interface StripeRequest {
	readonly values: Readonly<Record<string, string>>;
}

type StripeContext = Context<PluginEnv<StripeState, StripeConfig>>;

export async function readStripeRequest(context: StripeContext): Promise<StripeRequest> {
	authenticate(context);
	const parameters =
		context.req.method === "POST"
			? new URLSearchParams(await readFormBody(context))
			: new URL(context.req.url).searchParams;
	const values: Record<string, string> = {};
	for (const [key, value] of parameters) {
		if (Object.hasOwn(values, key)) {
			throw new StripeError("invalid_argument", `Stripe parameter '${key}' was repeated.`, key);
		}
		values[key] = value;
	}
	return Object.freeze({ values: Object.freeze(values) });
}

export function requiredString(request: StripeRequest, name: string): string {
	const value = request.values[name]?.trim();
	if (!value) throw new StripeError("invalid_argument", `Missing required param: ${name}.`, name);
	return value;
}

export function optionalString(request: StripeRequest, name: string): string | undefined {
	const value = request.values[name];
	return value === undefined || value === "" ? undefined : value;
}

export function listParameters(request: StripeRequest): Readonly<{
	afterId?: string;
	limit: number;
}> {
	const rawLimit = optionalString(request, "limit");
	const limit = rawLimit === undefined ? 10 : Number(rawLimit);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new StripeError(
			"invalid_argument",
			"Stripe limit must be an integer from 1 to 100.",
			"limit",
		);
	}
	const afterId = optionalString(request, "starting_after");
	return Object.freeze({ ...(afterId ? { afterId } : {}), limit });
}

function authenticate(context: StripeContext): void {
	const authorization = context.req.header("authorization");
	const expected = `Bearer ${context.get("lh").config.secretKey}`;
	if (authorization !== expected) {
		throw new StripeError("invalid_api_key", "Invalid API Key provided.");
	}
}

async function readFormBody(context: StripeContext): Promise<string> {
	const mediaType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/x-www-form-urlencoded") {
		throw new StripeError(
			"invalid_argument",
			"Stripe POST requests must use application/x-www-form-urlencoded.",
		);
	}
	return context.req.text();
}
