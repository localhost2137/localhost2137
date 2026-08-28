import type { Context, Hono } from "hono";
import type { PluginEnv } from "localhost2137";
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { SlackChannel, SlackMessage, SlackUser } from "../domain/models.js";
import { SlackError } from "../domain/slack-error.js";
import { postSlackMessage } from "../post-message.js";
import type { SlackState } from "../state.js";

const UI_TRANSPORT_ROOT = "/_localhost2137/ui/v1";
const PAGE_SIZE = 500;
const MESSAGE_LIMIT = 200;

type SlackUiContext = Context<PluginEnv<SlackState, SlackConfig>>;
type SlackUiApp = Hono<PluginEnv<SlackState, SlackConfig>>;

const channelInput = z.object({
	creator: z.string().min(1),
	name: z.string().min(1),
});

const membershipInput = z.object({
	channel: z.string().min(1),
	user: z.string().min(1),
});

const messageInput = membershipInput.extend({ text: z.string().min(1) });

export function registerSlackDashboardTransport(app: SlackUiApp): void {
	app.get(`${UI_TRANSPORT_ROOT}/snapshot`, uiRoute(snapshot));
	app.post(`${UI_TRANSPORT_ROOT}/channels`, uiRoute(createChannel));
	app.post(`${UI_TRANSPORT_ROOT}/memberships`, uiRoute(addMembership));
	app.post(`${UI_TRANSPORT_ROOT}/messages`, uiRoute(createMessage));
}

async function snapshot(context: SlackUiContext): Promise<Response> {
	const runtime = context.get("lh");
	const users = listAllUsers(runtime.state.service);
	const channels = listAllChannels(runtime.state.service);
	const requestedChannel = new URL(context.req.url).searchParams.get("channel");
	const selectedChannel = requestedChannel
		? runtime.state.service.requireChannel(requestedChannel)
		: undefined;
	const messages = selectedChannel
		? runtime.state.service.listMessages(selectedChannel.id, { limit: MESSAGE_LIMIT })
		: [];

	return jsonNoStore(context, {
		channels: channels.map((channel) => ({
			createdAt: channel.createdAt.toISOString(),
			id: channel.id,
			memberIds: listAllMembers(runtime.state.service, channel.id),
			name: channel.name,
			private: channel.private,
		})),
		messages: messages.map(uiMessage),
		selectedChannelId: selectedChannel?.id ?? null,
		users: users.map(uiUser),
		version: 1,
		workspace: runtime.state.service.workspace(),
	});
}

async function createChannel(context: SlackUiContext): Promise<Response> {
	const input = await readJson(context, channelInput);
	const runtime = context.get("lh");
	const channel = runtime.state.service.createChannel({
		creator: input.creator,
		name: input.name,
		now: runtime.clock.now(),
	});
	return jsonNoStore(
		context,
		{
			channel: {
				createdAt: channel.createdAt.toISOString(),
				id: channel.id,
				memberIds: listAllMembers(runtime.state.service, channel.id),
				name: channel.name,
				private: channel.private,
			},
		},
		201,
	);
}

async function addMembership(context: SlackUiContext): Promise<Response> {
	const input = await readJson(context, membershipInput);
	const membership = context.get("lh").state.service.addUserToChannel(input.channel, input.user);
	return jsonNoStore(context, { membership });
}

async function createMessage(context: SlackUiContext): Promise<Response> {
	const input = await readJson(context, messageInput);
	const created = postSlackMessage(context.get("lh"), input);
	return jsonNoStore(context, { message: uiMessage(created.message) }, 201);
}

function uiRoute(
	handler: (context: SlackUiContext) => Promise<Response>,
): (context: SlackUiContext) => Promise<Response> {
	return async (context) => {
		try {
			return await handler(context);
		} catch (cause) {
			if (cause instanceof SlackError) {
				return jsonNoStore(
					context,
					{ error: { code: cause.code, message: cause.message } },
					slackErrorStatus(cause),
				);
			}
			if (cause instanceof InvalidUiRequestError) {
				return jsonNoStore(
					context,
					{ error: { code: "invalid_request", message: cause.message } },
					400,
				);
			}
			throw cause;
		}
	};
}

async function readJson<Schema extends z.ZodType>(
	context: SlackUiContext,
	schema: Schema,
): Promise<z.output<Schema>> {
	if (context.req.header("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
		throw new InvalidUiRequestError("Request content type must be application/json.");
	}
	const body = await context.req.json().catch(() => {
		throw new InvalidUiRequestError("Request body must be valid JSON.");
	});
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new InvalidUiRequestError("Request body does not match the dashboard contract.");
	}
	return parsed.data;
}

function listAllUsers(service: SlackState["service"]): readonly SlackUser[] {
	return collectPages((afterId) =>
		service.listUsers({ ...(afterId ? { afterId } : {}), limit: PAGE_SIZE }),
	);
}

function listAllChannels(service: SlackState["service"]): readonly SlackChannel[] {
	return collectPages((afterId) =>
		service.listChannels({ ...(afterId ? { afterId } : {}), limit: PAGE_SIZE }),
	);
}

function listAllMembers(service: SlackState["service"], channel: string): readonly string[] {
	return collectPages((afterId) =>
		service.listMembers(channel, { ...(afterId ? { afterId } : {}), limit: PAGE_SIZE }),
	);
}

function collectPages<Item>(
	page: (afterId: string | undefined) => readonly Item[],
): readonly Item[] {
	const items: Item[] = [];
	let afterId: string | undefined;
	for (;;) {
		const next = page(afterId);
		items.push(...next);
		if (next.length < PAGE_SIZE) return Object.freeze(items);
		const last = next.at(-1);
		if (typeof last === "string") afterId = last;
		else if (last && typeof last === "object" && "id" in last && typeof last.id === "string") {
			afterId = last.id;
		} else {
			throw new Error("Slack dashboard pagination item has no stable ID.");
		}
	}
}

function uiUser(user: SlackUser) {
	return {
		admin: user.admin,
		bot: user.bot,
		createdAt: user.createdAt.toISOString(),
		id: user.id,
		name: user.name,
	};
}

function uiMessage(message: SlackMessage) {
	return {
		channelId: message.channelId,
		createdAt: message.createdAt.toISOString(),
		id: message.id,
		text: message.text,
		threadTs: message.threadTs,
		ts: message.ts,
		userId: message.userId,
	};
}

function slackErrorStatus(error: SlackError): 400 | 404 | 409 {
	if (error.code === "channel_not_found" || error.code === "user_not_found") return 404;
	if (error.code === "name_taken" || error.code === "not_in_channel") return 409;
	return 400;
}

function jsonNoStore(
	context: SlackUiContext,
	value: unknown,
	status: 200 | 201 | 400 | 404 | 409 = 200,
): Response {
	context.header("cache-control", "no-store");
	return context.json(value, status);
}

class InvalidUiRequestError extends Error {}
