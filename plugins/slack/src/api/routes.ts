import { Hono, type Context } from "hono";
import type { PluginEnv } from "localhost2137";
import type { SlackConfig } from "../config.js";
import { LOCAL_BOT_ID } from "../domain/slack-service.js";
import { SlackError } from "../domain/slack-error.js";
import type { SlackState } from "../state.js";
import { pageResult, readPagination } from "./pagination.js";
import { slackChannel, slackMessage, slackUser } from "./slack-responses.js";
import {
	authenticateSlackRequest,
	optionalBoolean,
	optionalString,
	readSlackRequest,
	requiredString,
} from "./slack-request.js";

type SlackContext = Context<PluginEnv<SlackState, SlackConfig>>;
type SlackHandler = (context: SlackContext) => Promise<Response>;

export function createSlackApi(): Hono<PluginEnv<SlackState, SlackConfig>> {
	const api = new Hono<PluginEnv<SlackState, SlackConfig>>();
	api.on(["GET", "POST"], "/api/auth.test", slackMethod(authTest));
	api.on(["GET", "POST"], "/api/users.list", slackMethod(usersList));
	api.on(["GET", "POST"], "/api/conversations.list", slackMethod(conversationsList));
	api.on(["GET", "POST"], "/api/conversations.members", slackMethod(conversationsMembers));
	api.on(["GET", "POST"], "/api/conversations.history", slackMethod(conversationsHistory));
	api.on(["GET", "POST"], "/api/chat.postMessage", slackMethod(chatPostMessage));
	return api;
}

async function authTest(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	const actor = authenticateSlackRequest(context, request);
	const runtime = context.get("lh");
	const workspace = runtime.state.service.workspace();
	const origin = new URL(context.req.url).origin;
	return context.json({
		...(actor.bot ? { bot_id: LOCAL_BOT_ID } : {}),
		ok: true,
		team: workspace.name,
		team_id: workspace.id,
		url: `${origin}/${runtime.instanceId}/${runtime.serviceKey}/`,
		user: actor.name,
		user_id: actor.id,
	});
}

async function usersList(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	authenticateSlackRequest(context, request);
	const runtime = context.get("lh");
	const workspace = runtime.state.service.workspace();
	const pagination = readPagination(request, { filter: "", method: "users.list" });
	const result = pageResult(
		runtime.state.service.listUsers({
			...(pagination.afterKey ? { afterId: pagination.afterKey } : {}),
			limit: pagination.limit + 1,
		}),
		{
			filter: "",
			key: (user) => user.id,
			limit: pagination.limit,
			method: "users.list",
		},
	);
	return context.json({
		cache_ts: Math.floor(runtime.clock.now().getTime() / 1_000),
		members: result.items.map((user) => slackUser(user, workspace.id)),
		ok: true,
		response_metadata: { next_cursor: result.nextCursor },
	});
}

async function conversationsList(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	const actor = authenticateSlackRequest(context, request);
	const types = optionalString(request, "types");
	if (types && types !== "public_channel") {
		throw new SlackError("invalid_types", "Only public_channel conversations are supported.");
	}
	optionalBoolean(request, "exclude_archived");
	const runtime = context.get("lh");
	const pagination = readPagination(request, {
		filter: types ?? "public_channel",
		method: "conversations.list",
	});
	const result = pageResult(
		runtime.state.service.listChannels({
			...(pagination.afterKey ? { afterId: pagination.afterKey } : {}),
			limit: pagination.limit + 1,
		}),
		{
			filter: types ?? "public_channel",
			key: (channel) => channel.id,
			limit: pagination.limit,
			method: "conversations.list",
		},
	);
	return context.json({
		channels: result.items.map((channel) =>
			slackChannel(channel, {
				creator: runtime.state.service.workspace().botUserId,
				isMember: runtime.state.service.isMember(channel.id, actor.id),
				memberCount: runtime.state.service.memberCount(channel.id),
			}),
		),
		ok: true,
		response_metadata: { next_cursor: result.nextCursor },
	});
}

async function conversationsMembers(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	authenticateSlackRequest(context, request);
	const channel = requiredString(request, "channel", "channel_not_found");
	const runtime = context.get("lh");
	const resolvedChannel = runtime.state.service.requireChannelById(channel);
	const pagination = readPagination(request, {
		filter: resolvedChannel.id,
		method: "conversations.members",
	});
	const result = pageResult(
		runtime.state.service.listMembers(resolvedChannel.id, {
			...(pagination.afterKey ? { afterId: pagination.afterKey } : {}),
			limit: pagination.limit + 1,
		}),
		{
			filter: resolvedChannel.id,
			key: (userId) => userId,
			limit: pagination.limit,
			method: "conversations.members",
		},
	);
	return context.json({
		members: result.items,
		ok: true,
		response_metadata: { next_cursor: result.nextCursor },
	});
}

async function conversationsHistory(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	const actor = authenticateSlackRequest(context, request);
	const channel = requiredString(request, "channel", "channel_not_found");
	const runtime = context.get("lh");
	const resolvedChannel = runtime.state.service.requireChannelById(channel);
	if (!runtime.state.service.isMember(resolvedChannel.id, actor.id)) {
		throw new SlackError("not_in_channel", "Authenticated Slack user is not in the channel.");
	}
	const inclusive = optionalBoolean(request, "inclusive") ?? false;
	const oldest = readTimestamp(request, "oldest");
	const latest = readTimestamp(request, "latest");
	const filter = JSON.stringify({ channel: resolvedChannel.id, inclusive, latest, oldest });
	const pagination = readPagination(request, { filter, method: "conversations.history" });
	const result = pageResult(
		runtime.state.service.listMessages(resolvedChannel.id, {
			...(pagination.afterKey ? { beforeId: pagination.afterKey } : {}),
			...(latest ? { latest: inclusive ? shiftTimestamp(latest, 1) : latest } : {}),
			limit: pagination.limit + 1,
			...(oldest ? { oldest: inclusive ? shiftTimestamp(oldest, -1) : oldest } : {}),
		}),
		{
			filter,
			key: (message) => message.id,
			limit: pagination.limit,
			method: "conversations.history",
		},
	);
	return context.json({
		has_more: result.nextCursor !== "",
		messages: result.items.map((message) =>
			slackMessage(message, runtime.state.service.requireUser(message.userId)),
		),
		ok: true,
		pin_count: 0,
		response_metadata: { next_cursor: result.nextCursor },
	});
}

async function chatPostMessage(context: SlackContext): Promise<Response> {
	const request = await readSlackRequest(context);
	const actor = authenticateSlackRequest(context, request);
	const channel = requiredString(request, "channel", "channel_not_found");
	const text = requiredString(request, "text", "no_text");
	const threadTs = optionalString(request, "thread_ts");
	const runtime = context.get("lh");
	const resolvedChannel = runtime.state.service.requireChannelById(channel);
	const created = runtime.state.service.postMessage({
		channel: resolvedChannel.id,
		emitEvent: runtime.config.eventsUrl !== null,
		now: runtime.clock.now(),
		text,
		...(threadTs ? { threadTs } : {}),
		user: actor.id,
	});
	if (created.deliveryEventId) {
		runtime.state.events.schedule(runtime, {
			actor,
			eventId: created.deliveryEventId,
			message: created.message,
		});
	}
	return context.json({
		channel: created.message.channelId,
		message: slackMessage(created.message, actor),
		ok: true,
		ts: created.message.ts,
	});
}

function slackMethod(handler: SlackHandler): SlackHandler {
	return async (context) => {
		try {
			return await handler(context);
		} catch (cause) {
			if (!(cause instanceof SlackError)) throw cause;
			return context.json({ error: cause.code, ok: false });
		}
	};
}

function readTimestamp(
	request: Readonly<{ values: Readonly<Record<string, boolean | number | string>> }>,
	name: "latest" | "oldest",
): string | undefined {
	const value = request.values[name];
	if (value === undefined || value === "") return undefined;
	const text = String(value);
	if (!/^\d+\.\d{1,6}$/.test(text)) {
		throw new SlackError(
			name === "latest" ? "invalid_ts_latest" : "invalid_ts_oldest",
			`Slack ${name} must be a seconds.microseconds timestamp.`,
		);
	}
	return normalizeTimestamp(text);
}

function shiftTimestamp(value: string, microseconds: -1 | 1): string {
	const [secondsText, fractionText] = value.split(".");
	const total = Number(secondsText) * 1_000_000 + Number(fractionText?.padEnd(6, "0"));
	const shifted = total + microseconds;
	return `${Math.floor(shifted / 1_000_000)}.${String(shifted % 1_000_000).padStart(6, "0")}`;
}

function normalizeTimestamp(value: string): string {
	const [seconds, fraction] = value.split(".");
	return `${seconds}.${fraction?.padEnd(6, "0")}`;
}
