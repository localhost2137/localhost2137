/** Browser-safe private transport shared by the Slack dashboard and its Hono adapter. */
const slackUiTransportRoot = "_localhost2137/ui/v1";

export interface SlackUiRoutes {
	readonly channels: string;
	readonly memberships: string;
	readonly messages: string;
	readonly snapshot: string;
}

export const slackUiRoutes: Readonly<SlackUiRoutes> = Object.freeze({
	channels: `${slackUiTransportRoot}/channels`,
	memberships: `${slackUiTransportRoot}/memberships`,
	messages: `${slackUiTransportRoot}/messages`,
	snapshot: `${slackUiTransportRoot}/snapshot`,
});

export interface SlackUiUser {
	readonly admin: boolean;
	readonly bot: boolean;
	readonly createdAt: string;
	readonly id: string;
	readonly name: string;
}

export interface SlackUiChannel {
	readonly createdAt: string;
	readonly id: string;
	readonly memberIds: readonly string[];
	readonly name: string;
	readonly private: boolean;
}

export interface SlackUiMessage {
	readonly channelId: string;
	readonly createdAt: string;
	readonly id: string;
	readonly text: string;
	readonly threadTs: string | null;
	readonly ts: string;
	readonly userId: string;
}

export interface SlackUiSnapshot {
	readonly channels: readonly SlackUiChannel[];
	readonly hasMoreMessages: boolean;
	readonly messages: readonly SlackUiMessage[];
	readonly selectedChannelId: string | null;
	readonly users: readonly SlackUiUser[];
	readonly version: 1;
	readonly workspace: Readonly<{ id: string; name: string }>;
}

export interface SlackUiCreateChannelInput {
	readonly creator: string;
	readonly name: string;
}

export interface SlackUiCreateChannelResponse {
	readonly channel: SlackUiChannel;
}

export interface SlackUiMembershipInput {
	readonly channel: string;
	readonly user: string;
}

export interface SlackUiMembershipResponse {
	readonly membership: Readonly<{ added: boolean; channel: string; user: string }>;
}

export interface SlackUiCreateMessageInput extends SlackUiMembershipInput {
	readonly text: string;
}

export interface SlackUiCreateMessageResponse {
	readonly message: SlackUiMessage;
}

export interface SlackUiErrorResponse {
	readonly error: Readonly<{ code: string; message: string }>;
}
