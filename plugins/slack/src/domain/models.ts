export type UserId = string;
export type ChannelId = string;
export type MessageId = string;
export type EventId = string;

export interface SlackWorkspace {
	readonly botUserId: UserId;
	readonly id: string;
	readonly name: string;
}

export interface SlackUser {
	readonly admin: boolean;
	readonly bot: boolean;
	readonly createdAt: Date;
	readonly id: UserId;
	readonly name: string;
}

export interface SlackChannel {
	readonly createdAt: Date;
	readonly id: ChannelId;
	readonly name: string;
	readonly private: boolean;
}

export interface SlackMessage {
	readonly channelId: ChannelId;
	readonly createdAt: Date;
	readonly deleted: boolean;
	readonly id: MessageId;
	readonly text: string;
	readonly threadTs: string | null;
	readonly ts: string;
	readonly userId: UserId;
}

type DeliveryStatus = "exhausted" | "pending" | "retry_scheduled" | "succeeded";

export interface EventDelivery {
	readonly attemptCount: number;
	readonly completedAt: Date | null;
	readonly error: string | null;
	readonly eventId: EventId;
	readonly messageId: MessageId;
	readonly nextAttemptAt: Date | null;
	readonly requestedAt: Date;
	readonly retryReason: string | null;
	readonly status: DeliveryStatus;
	readonly statusCode: number | null;
}
