import type Database from "better-sqlite3";
import type { ChannelId, SlackChannel, UserId } from "../domain/models.js";
import { nextId } from "./id-sequence.js";

interface ChannelRow {
	readonly created_at_ms: number;
	readonly id: string;
	readonly is_private: number;
	readonly name: string;
}

export class ChannelRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	addMember(channelId: ChannelId, userId: UserId): boolean {
		const result = this.#database
			.prepare("INSERT OR IGNORE INTO channel_memberships(channel_id, user_id) VALUES (?, ?)")
			.run(channelId, userId);
		return result.changes === 1;
	}

	create(
		input: Readonly<{ id?: ChannelId; name: string; now: Date; private?: boolean }>,
	): SlackChannel {
		const id = input.id ?? nextId(this.#database, "channel");
		this.#database
			.prepare("INSERT INTO channels(id, name, is_private, created_at_ms) VALUES (?, ?, ?, ?)")
			.run(id, input.name, input.private ? 1 : 0, input.now.getTime());
		return this.getById(id);
	}

	find(reference: string): SlackChannel | undefined {
		const row = this.#database
			.prepare(
				`SELECT id, name, is_private, created_at_ms FROM channels
				 WHERE id = ? OR name = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
			)
			.get(reference, reference, reference) as ChannelRow | undefined;
		return row ? toChannel(row) : undefined;
	}

	findById(id: ChannelId): SlackChannel | undefined {
		const row = this.#database
			.prepare("SELECT id, name, is_private, created_at_ms FROM channels WHERE id = ?")
			.get(id) as ChannelRow | undefined;
		return row ? toChannel(row) : undefined;
	}

	getById(id: ChannelId): SlackChannel {
		const channel = this.findById(id);
		if (!channel) throw new Error(`Slack channel ${id} is missing after persistence.`);
		return channel;
	}

	hasMember(channelId: ChannelId, userId: UserId): boolean {
		return (
			this.#database
				.prepare(
					"SELECT 1 AS present FROM channel_memberships WHERE channel_id = ? AND user_id = ?",
				)
				.get(channelId, userId) !== undefined
		);
	}

	memberCount(channelId: ChannelId): number {
		const row = this.#database
			.prepare("SELECT COUNT(*) AS count FROM channel_memberships WHERE channel_id = ?")
			.get(channelId) as { count: number };
		return row.count;
	}

	listMembers(
		channelId: ChannelId,
		input: Readonly<{ afterId?: string; limit: number }>,
	): readonly UserId[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							`SELECT user_id FROM channel_memberships
						 WHERE channel_id = ? AND user_id > ? ORDER BY user_id ASC LIMIT ?`,
						)
						.all(channelId, input.afterId, input.limit)
				: this.#database
						.prepare(
							`SELECT user_id FROM channel_memberships
						 WHERE channel_id = ? ORDER BY user_id ASC LIMIT ?`,
						)
						.all(channelId, input.limit)
		) as Array<{ user_id: string }>;
		return Object.freeze(rows.map((row) => row.user_id));
	}

	listPage(input: Readonly<{ afterId?: string; limit: number }>): readonly SlackChannel[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							`SELECT id, name, is_private, created_at_ms FROM channels
						 WHERE id > ? ORDER BY id ASC LIMIT ?`,
						)
						.all(input.afterId, input.limit)
				: this.#database
						.prepare(
							"SELECT id, name, is_private, created_at_ms FROM channels ORDER BY id ASC LIMIT ?",
						)
						.all(input.limit)
		) as ChannelRow[];
		return Object.freeze(rows.map(toChannel));
	}
}

function toChannel(row: ChannelRow): SlackChannel {
	return Object.freeze({
		createdAt: new Date(row.created_at_ms),
		id: row.id,
		name: row.name,
		private: row.is_private === 1,
	});
}
