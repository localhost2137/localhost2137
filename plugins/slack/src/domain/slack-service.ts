import type { SlackConfig, SlackSeed } from "../config.js";
import type { SlackDatabase } from "../persistence/database.js";
import type { MessagePageOptions } from "../persistence/message-repository.js";
import type {
	ChannelId,
	EventId,
	SlackChannel,
	SlackMessage,
	SlackUser,
	SlackWorkspace,
	UserId,
} from "./models.js";
import { SlackError } from "./slack-error.js";

const LOCAL_TEAM_ID = "T000001";
const LOCAL_BOT_USER_ID = "U000000";
export const LOCAL_BOT_ID = "B000001";
const LOCAL_BOT_NAME = "localhost2137-bot";

export interface CreatedMessage {
	readonly deliveryEventId: EventId | null;
	readonly message: SlackMessage;
}

export class SlackService {
	readonly #database: SlackDatabase;

	constructor(database: SlackDatabase) {
		this.#database = database;
	}

	addUserToChannel(
		channelReference: string,
		userReference: string,
	): Readonly<{
		added: boolean;
		channel: ChannelId;
		user: UserId;
	}> {
		const channel = this.requireChannel(channelReference);
		const user = this.requireUser(userReference);
		return Object.freeze({
			added: this.#database.channels.addMember(channel.id, user.id),
			channel: channel.id,
			user: user.id,
		});
	}

	authenticate(token: string): SlackUser {
		const user = this.#database.users.findByToken(token);
		if (!user) throw new SlackError("invalid_auth", "Slack token is not valid in this workspace.");
		return user;
	}

	createChannel(input: Readonly<{ id?: string; name: string; now: Date }>): SlackChannel {
		const name = normalizeChannelName(input.name);
		if (this.#database.channels.find(name)) {
			throw new SlackError("name_taken", `A Slack channel named ${name} already exists.`);
		}
		return this.#database.transaction(() => {
			const channel = this.#database.channels.create({
				...(input.id ? { id: input.id } : {}),
				name,
				now: input.now,
			});
			this.#database.channels.addMember(channel.id, LOCAL_BOT_USER_ID);
			return channel;
		});
	}

	createUser(
		input: Readonly<{
			admin: boolean;
			id?: string;
			name: string;
			now: Date;
		}>,
	): SlackUser {
		const name = normalizeUserName(input.name);
		if (this.#database.users.find(name)) {
			throw new SlackError("name_taken", `A Slack user named ${name} already exists.`);
		}
		return this.#database.users.create({ ...input, name });
	}

	initialize(config: SlackConfig, now: Date): void {
		this.#database.transaction(() => {
			if (!this.#database.users.findById(LOCAL_BOT_USER_ID)) {
				this.#database.users.create({
					admin: false,
					bot: true,
					id: LOCAL_BOT_USER_ID,
					name: LOCAL_BOT_NAME,
					now,
				});
			}
			this.#database.users.replaceBotToken(config.botToken, LOCAL_BOT_USER_ID);
			this.#database.workspace.upsert({
				botUserId: LOCAL_BOT_USER_ID,
				id: LOCAL_TEAM_ID,
				name: config.workspaceName,
			});
		});
	}

	listChannels(input: Readonly<{ afterId?: string; limit: number }>): readonly SlackChannel[] {
		return this.#database.channels.listPage(input);
	}

	isMember(channelId: ChannelId, userId: UserId): boolean {
		return this.#database.channels.hasMember(channelId, userId);
	}

	memberCount(channelId: ChannelId): number {
		return this.#database.channels.memberCount(channelId);
	}

	listMembers(
		channelReference: string,
		input: Readonly<{ afterId?: string; limit: number }>,
	): readonly UserId[] {
		return this.#database.channels.listMembers(this.requireChannel(channelReference).id, input);
	}

	listMessages(channelReference: string, input: MessagePageOptions): readonly SlackMessage[] {
		return this.#database.messages.listPage(this.requireChannel(channelReference).id, input);
	}

	listUsers(input: Readonly<{ afterId?: string; limit: number }>): readonly SlackUser[] {
		return this.#database.users.listPage(input);
	}

	postMessage(
		input: Readonly<{
			channel: string;
			emitEvent: boolean;
			now: Date;
			text: string;
			threadTs?: string;
			user: string;
		}>,
	): CreatedMessage {
		const channel = this.requireChannel(input.channel);
		const user = this.requireUser(input.user);
		if (!this.#database.channels.hasMember(channel.id, user.id)) {
			throw new SlackError("not_in_channel", `Slack user ${user.id} is not in ${channel.id}.`);
		}
		const text = input.text.trim();
		if (text.length === 0)
			throw new SlackError("invalid_arguments", "Slack message text is empty.");
		if (input.threadTs) {
			const parent = this.#database.messages.findByTimestamp(input.threadTs);
			if (!parent || parent.channelId !== channel.id || parent.deleted) {
				throw new SlackError(
					"invalid_arguments",
					"Slack thread_ts is not a message in this channel.",
				);
			}
		}
		return this.#database.transaction(() => {
			const message = this.#database.messages.create({
				channelId: channel.id,
				now: input.now,
				text,
				...(input.threadTs ? { threadTs: input.threadTs } : {}),
				userId: user.id,
			});
			const delivery = input.emitEvent
				? this.#database.deliveries.enqueue(message.id, input.now)
				: undefined;
			return Object.freeze({ deliveryEventId: delivery?.eventId ?? null, message });
		});
	}

	requireChannel(reference: string): SlackChannel {
		const channel = this.#database.channels.find(reference);
		if (!channel)
			throw new SlackError("channel_not_found", `Slack channel ${reference} was not found.`);
		return channel;
	}

	requireUser(reference: string): SlackUser {
		const user = this.#database.users.find(reference);
		if (!user) throw new SlackError("user_not_found", `Slack user ${reference} was not found.`);
		return user;
	}

	seed(seed: SlackSeed, now: Date): void {
		this.#database.transaction(() => {
			for (const input of seed.users) {
				this.createUser({
					admin: input.admin,
					...(input.id ? { id: input.id } : {}),
					name: input.name,
					now,
				});
			}
			for (const input of seed.channels) {
				const channel = this.createChannel({
					...(input.id ? { id: input.id } : {}),
					name: input.name,
					now,
				});
				for (const member of input.members) this.addUserToChannel(channel.id, member);
			}
		});
	}

	workspace(): SlackWorkspace {
		return this.#database.workspace.get();
	}
}

function normalizeChannelName(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) {
		throw new SlackError(
			"invalid_arguments",
			"Slack channel names must contain 1-80 lowercase letters, numbers, underscores, or hyphens.",
		);
	}
	return normalized;
}

function normalizeUserName(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > 80) {
		throw new SlackError("invalid_arguments", "Slack user names must contain 1-80 characters.");
	}
	return normalized;
}
