import type { EventId, SlackMessage, SlackUser, SlackWorkspace } from "../domain/models.js";
import { LOCAL_BOT_ID } from "../domain/slack-service.js";

export interface SlackEventEnvelope {
	readonly api_app_id: string;
	readonly authorizations: readonly Readonly<{
		enterprise_id: null;
		is_bot: true;
		is_enterprise_install: false;
		team_id: string;
		user_id: string;
	}>[];
	readonly context_enterprise_id: null;
	readonly context_team_id: string;
	readonly event: Readonly<Record<string, boolean | string>>;
	readonly event_context: string;
	readonly event_id: EventId;
	readonly event_time: number;
	readonly is_ext_shared_channel: false;
	readonly team_id: string;
	readonly type: "event_callback";
}

export function createMessageEventEnvelope(
	input: Readonly<{
		actor: SlackUser;
		eventId: EventId;
		message: SlackMessage;
		workspace: SlackWorkspace;
	}>,
): SlackEventEnvelope {
	const event: Record<string, boolean | string> = {
		channel: input.message.channelId,
		channel_type: "channel",
		event_ts: input.message.ts,
		text: input.message.text,
		ts: input.message.ts,
		type: "message",
		user: input.message.userId,
	};
	if (input.message.threadTs) event.thread_ts = input.message.threadTs;
	if (input.actor.bot) {
		event.bot_id = LOCAL_BOT_ID;
		event.subtype = "bot_message";
	}
	return Object.freeze({
		api_app_id: "A000001",
		authorizations: Object.freeze([
			Object.freeze({
				enterprise_id: null,
				is_bot: true as const,
				is_enterprise_install: false as const,
				team_id: input.workspace.id,
				user_id: input.workspace.botUserId,
			}),
		]),
		context_enterprise_id: null,
		context_team_id: input.workspace.id,
		event: Object.freeze(event),
		event_context: `localhost2137:${input.eventId}`,
		event_id: input.eventId,
		event_time: Math.floor(input.message.createdAt.getTime() / 1_000),
		is_ext_shared_channel: false,
		team_id: input.workspace.id,
		type: "event_callback",
	});
}
