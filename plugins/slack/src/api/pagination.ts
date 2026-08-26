import { SlackError } from "../domain/slack-error.js";
import type { SlackRequestArguments } from "./slack-request.js";
import { optionalString } from "./slack-request.js";

interface CursorPayload {
	readonly filter: string;
	readonly key: string;
	readonly method: string;
	readonly version: 1;
}

export interface PaginationInput {
	readonly afterKey?: string;
	readonly limit: number;
}

export function readPagination(
	request: SlackRequestArguments,
	input: Readonly<{ filter: string; method: string }>,
): PaginationInput {
	const rawLimit = request.values.limit;
	let limit = 100;
	if (rawLimit !== undefined && rawLimit !== "") {
		const numeric = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
		if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) {
			throw new SlackError("invalid_limit", "Slack limit must be an integer from 1 to 999.");
		}
		limit = numeric;
	}
	const cursor = optionalString(request, "cursor");
	if (!cursor) return Object.freeze({ limit });
	const payload = decodeCursor(cursor);
	if (payload.method !== input.method || payload.filter !== input.filter) {
		throw new SlackError("invalid_cursor", "Slack cursor does not belong to this result set.");
	}
	return Object.freeze({ afterKey: payload.key, limit });
}

export function pageResult<Item>(
	items: readonly Item[],
	input: Readonly<{
		filter: string;
		key: (item: Item) => string;
		limit: number;
		method: string;
	}>,
): Readonly<{ items: readonly Item[]; nextCursor: string }> {
	const page = Object.freeze(items.slice(0, input.limit));
	const last = page.at(-1);
	const nextCursor =
		items.length > input.limit && last
			? encodeCursor({
					filter: input.filter,
					key: input.key(last),
					method: input.method,
					version: 1,
				})
			: "";
	return Object.freeze({ items: page, nextCursor });
}

function encodeCursor(payload: CursorPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("method" in value) ||
			typeof value.method !== "string" ||
			!("filter" in value) ||
			typeof value.filter !== "string" ||
			!("key" in value) ||
			typeof value.key !== "string"
		) {
			throw new TypeError("invalid cursor payload");
		}
		return Object.freeze({
			filter: value.filter,
			key: value.key,
			method: value.method,
			version: 1,
		});
	} catch {
		throw new SlackError("invalid_cursor", "Slack cursor is invalid.");
	}
}
