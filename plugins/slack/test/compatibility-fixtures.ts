type NormalizedResponse = Readonly<Record<string, unknown>>;

export const expectedSlackResponses: Readonly<Record<string, NormalizedResponse>> = Object.freeze({
	"auth.test": Object.freeze({
		bot_id: "B000001",
		ok: true,
		team: "Local Test",
		team_id: "T000001",
		user: "localhost2137-bot",
		user_id: "U000000",
	}),
	"chat.postMessage": Object.freeze({
		channel: "C000001",
		message: Object.freeze({
			bot_id: "B000001",
			subtype: "bot_message",
			text: "pong",
			ts: "1767225600.000001",
			type: "message",
			user: "U000000",
		}),
		ok: true,
		ts: "1767225600.000001",
	}),
	"conversations.history": Object.freeze({
		has_more: false,
		messages: Object.freeze([
			Object.freeze({
				bot_id: "B000001",
				subtype: "bot_message",
				text: "pong",
				ts: "1767225600.000001",
				type: "message",
				user: "U000000",
			}),
			Object.freeze({
				text: "ping",
				ts: "1767225600.000000",
				type: "message",
				user: "U000001",
			}),
		]),
		ok: true,
		pin_count: 0,
		response_metadata: Object.freeze({ next_cursor: "" }),
	}),
	"conversations.list": Object.freeze({
		channels: Object.freeze([
			Object.freeze({
				id: "C000001",
				is_channel: true,
				is_member: true,
				is_private: false,
				name: "general",
				num_members: 2,
			}),
		]),
		ok: true,
		response_metadata: Object.freeze({ next_cursor: "" }),
	}),
	"conversations.members": Object.freeze({
		members: Object.freeze(["U000000", "U000001"]),
		ok: true,
		response_metadata: Object.freeze({ next_cursor: "" }),
	}),
	"users.list": Object.freeze({
		members: Object.freeze([
			Object.freeze({ id: "U000000", is_admin: false, is_bot: true, name: "localhost2137-bot" }),
			Object.freeze({ id: "U000001", is_admin: true, is_bot: false, name: "Ada" }),
		]),
		ok: true,
		response_metadata: Object.freeze({ next_cursor: "" }),
	}),
});

export function normalizeSlackResponse(method: string, body: unknown): NormalizedResponse {
	if (!isRecord(body)) throw new TypeError(`${method} response must be an object.`);
	if (method === "auth.test")
		return select(body, ["bot_id", "ok", "team", "team_id", "user", "user_id"]);
	if (method === "users.list") {
		return Object.freeze({
			members: normalizeRecords(body.members, ["id", "is_admin", "is_bot", "name"]),
			ok: body.ok,
			response_metadata: body.response_metadata,
		});
	}
	if (method === "conversations.list") {
		return Object.freeze({
			channels: normalizeRecords(body.channels, [
				"id",
				"is_channel",
				"is_member",
				"is_private",
				"name",
				"num_members",
			]),
			ok: body.ok,
			response_metadata: body.response_metadata,
		});
	}
	if (method === "conversations.members") {
		return select(body, ["members", "ok", "response_metadata"]);
	}
	if (method === "conversations.history") {
		return Object.freeze({
			has_more: body.has_more,
			messages: normalizeRecords(body.messages, [
				"bot_id",
				"subtype",
				"text",
				"ts",
				"type",
				"user",
			]),
			ok: body.ok,
			pin_count: body.pin_count,
			response_metadata: body.response_metadata,
		});
	}
	if (method === "chat.postMessage") {
		return Object.freeze({
			channel: body.channel,
			message: isRecord(body.message)
				? select(body.message, ["bot_id", "subtype", "text", "ts", "type", "user"])
				: body.message,
			ok: body.ok,
			ts: body.ts,
		});
	}
	throw new TypeError(`No normalized Slack fixture for ${method}.`);
}

function normalizeRecords(value: unknown, keys: readonly string[]): readonly NormalizedResponse[] {
	if (!Array.isArray(value)) throw new TypeError("Slack collection response must be an array.");
	return Object.freeze(
		value.map((entry) => {
			if (!isRecord(entry)) throw new TypeError("Slack collection entry must be an object.");
			return select(
				entry,
				keys.filter((key) => Object.hasOwn(entry, key)),
			);
		}),
	);
}

function select(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): NormalizedResponse {
	return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
