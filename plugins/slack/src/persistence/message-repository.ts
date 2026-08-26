import type Database from "better-sqlite3";
import type { ChannelId, SlackMessage, UserId } from "../domain/models.js";
import { nextId } from "./id-sequence.js";

interface MessageRow {
	readonly channel_id: string;
	readonly created_at_ms: number;
	readonly deleted: number;
	readonly id: string;
	readonly text: string;
	readonly thread_ts: string | null;
	readonly ts: string;
	readonly user_id: string;
}

export interface MessagePageOptions {
	readonly beforeId?: string;
	readonly latest?: string;
	readonly limit: number;
	readonly oldest?: string;
}

export class MessageRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	create(
		input: Readonly<{
			channelId: ChannelId;
			now: Date;
			text: string;
			threadTs?: string;
			userId: UserId;
		}>,
	): SlackMessage {
		const id = nextId(this.#database, "message");
		const ts = this.#nextTimestamp(input.now);
		this.#database
			.prepare(
				`INSERT INTO messages(id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
			)
			.run(
				id,
				input.channelId,
				input.userId,
				input.text,
				ts,
				input.now.getTime(),
				input.threadTs ?? null,
			);
		return this.getById(id);
	}

	getById(id: string): SlackMessage {
		const row = this.#database
			.prepare(
				`SELECT id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted
				 FROM messages WHERE id = ?`,
			)
			.get(id) as MessageRow | undefined;
		if (!row) throw new Error(`Slack message ${id} is missing after persistence.`);
		return toMessage(row);
	}

	findByTimestamp(ts: string): SlackMessage | undefined {
		const row = this.#database
			.prepare(
				`SELECT id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted
				 FROM messages WHERE ts = ?`,
			)
			.get(ts) as MessageRow | undefined;
		return row ? toMessage(row) : undefined;
	}

	listPage(channelId: ChannelId, input: MessagePageOptions): readonly SlackMessage[] {
		const conditions = ["channel_id = ?", "deleted = 0"];
		const parameters: Array<number | string> = [channelId];
		if (input.beforeId) {
			conditions.push("id < ?");
			parameters.push(input.beforeId);
		}
		if (input.oldest) {
			conditions.push(
				"CAST(REPLACE(ts, '.', '') AS INTEGER) > CAST(REPLACE(?, '.', '') AS INTEGER)",
			);
			parameters.push(input.oldest);
		}
		if (input.latest) {
			conditions.push(
				"CAST(REPLACE(ts, '.', '') AS INTEGER) < CAST(REPLACE(?, '.', '') AS INTEGER)",
			);
			parameters.push(input.latest);
		}
		parameters.push(input.limit);
		const rows = this.#database
			.prepare(
				`SELECT id, channel_id, user_id, text, ts, created_at_ms, thread_ts, deleted
				 FROM messages WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
			)
			.all(...parameters) as MessageRow[];
		return Object.freeze(rows.map(toMessage));
	}

	#nextTimestamp(now: Date): string {
		const current = this.#database
			.prepare("SELECT value FROM counters WHERE kind = 'message_ts'")
			.get() as { value: number } | undefined;
		const next = Math.max(now.getTime() * 1_000, (current?.value ?? 0) + 1);
		this.#database
			.prepare(
				`INSERT INTO counters(kind, value) VALUES ('message_ts', ?)
				 ON CONFLICT(kind) DO UPDATE SET value = excluded.value`,
			)
			.run(next);
		const seconds = Math.floor(next / 1_000_000);
		const micros = next % 1_000_000;
		return `${seconds}.${String(micros).padStart(6, "0")}`;
	}
}

function toMessage(row: MessageRow): SlackMessage {
	return Object.freeze({
		channelId: row.channel_id,
		createdAt: new Date(row.created_at_ms),
		deleted: row.deleted === 1,
		id: row.id,
		text: row.text,
		threadTs: row.thread_ts,
		ts: row.ts,
		userId: row.user_id,
	});
}
