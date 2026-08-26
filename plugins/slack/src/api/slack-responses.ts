import type { SlackChannel, SlackMessage, SlackUser } from "../domain/models.js";
import { LOCAL_BOT_ID } from "../domain/slack-service.js";

export function slackUser(user: SlackUser, teamId: string): Readonly<Record<string, unknown>> {
	return {
		deleted: false,
		id: user.id,
		is_admin: user.admin,
		is_app_user: user.bot,
		is_bot: user.bot,
		is_owner: false,
		is_primary_owner: false,
		is_restricted: false,
		is_ultra_restricted: false,
		name: user.name,
		profile: {
			display_name: user.name,
			display_name_normalized: user.name,
			real_name: user.name,
			real_name_normalized: user.name,
		},
		real_name: user.name,
		team_id: teamId,
		updated: Math.floor(user.createdAt.getTime() / 1_000),
	};
}

export function slackChannel(
	channel: SlackChannel,
	input: Readonly<{ creator: string; isMember: boolean }>,
): Readonly<Record<string, unknown>> {
	const created = Math.floor(channel.createdAt.getTime() / 1_000);
	return {
		context_team_id: "T000001",
		created,
		creator: input.creator,
		id: channel.id,
		is_archived: false,
		is_channel: true,
		is_ext_shared: false,
		is_general: channel.name === "general",
		is_group: false,
		is_im: false,
		is_member: input.isMember,
		is_mpim: false,
		is_org_shared: false,
		is_pending_ext_shared: false,
		is_private: channel.private,
		is_shared: false,
		name: channel.name,
		name_normalized: channel.name,
		pending_shared: [],
		previous_names: [],
		purpose: { creator: "", last_set: 0, value: "" },
		topic: { creator: "", last_set: 0, value: "" },
		updated: created * 1_000,
	};
}

export function slackMessage(
	message: SlackMessage,
	actor: SlackUser,
): Readonly<Record<string, unknown>> {
	return {
		...(actor.bot ? { bot_id: LOCAL_BOT_ID, subtype: "bot_message" } : {}),
		...(message.threadTs ? { thread_ts: message.threadTs } : {}),
		text: message.text,
		ts: message.ts,
		type: "message",
		user: message.userId,
	};
}
