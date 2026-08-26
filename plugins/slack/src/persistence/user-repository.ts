import type Database from "better-sqlite3";
import type { SlackUser, UserId } from "../domain/models.js";
import { nextId } from "./id-sequence.js";

interface UserRow {
	readonly created_at_ms: number;
	readonly id: string;
	readonly is_admin: number;
	readonly is_bot: number;
	readonly name: string;
}

export class UserRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	create(
		input: Readonly<{ admin: boolean; bot?: boolean; id?: UserId; name: string; now: Date }>,
	): SlackUser {
		const id = input.id ?? nextId(this.#database, "user");
		this.#database
			.prepare(
				"INSERT INTO users(id, name, is_admin, is_bot, created_at_ms) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, input.name, input.admin ? 1 : 0, input.bot ? 1 : 0, input.now.getTime());
		return this.getById(id);
	}

	findById(id: UserId): SlackUser | undefined {
		const row = this.#database
			.prepare("SELECT id, name, is_admin, is_bot, created_at_ms FROM users WHERE id = ?")
			.get(id) as UserRow | undefined;
		return row ? toUser(row) : undefined;
	}

	find(reference: string): SlackUser | undefined {
		const row = this.#database
			.prepare(
				`SELECT id, name, is_admin, is_bot, created_at_ms FROM users
				 WHERE id = ? OR name = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
			)
			.get(reference, reference, reference) as UserRow | undefined;
		return row ? toUser(row) : undefined;
	}

	findByToken(token: string): SlackUser | undefined {
		const row = this.#database
			.prepare(
				`SELECT users.id, users.name, users.is_admin, users.is_bot, users.created_at_ms
				 FROM tokens JOIN users ON users.id = tokens.user_id WHERE tokens.token = ?`,
			)
			.get(token) as UserRow | undefined;
		return row ? toUser(row) : undefined;
	}

	getById(id: UserId): SlackUser {
		const user = this.findById(id);
		if (!user) throw new Error(`Slack user ${id} is missing after persistence.`);
		return user;
	}

	listPage(input: Readonly<{ afterId?: string; limit: number }>): readonly SlackUser[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							`SELECT id, name, is_admin, is_bot, created_at_ms FROM users
						 WHERE id > ? ORDER BY id ASC LIMIT ?`,
						)
						.all(input.afterId, input.limit)
				: this.#database
						.prepare(
							"SELECT id, name, is_admin, is_bot, created_at_ms FROM users ORDER BY id ASC LIMIT ?",
						)
						.all(input.limit)
		) as UserRow[];
		return Object.freeze(rows.map(toUser));
	}

	putToken(input: Readonly<{ kind: "bot" | "user"; token: string; userId: UserId }>): void {
		this.#database
			.prepare(
				`INSERT INTO tokens(token, user_id, kind) VALUES (?, ?, ?)
				 ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind`,
			)
			.run(input.token, input.userId, input.kind);
	}

	replaceBotToken(token: string, userId: UserId): void {
		this.#database.prepare("DELETE FROM tokens WHERE kind = 'bot'").run();
		this.putToken({ kind: "bot", token, userId });
	}
}

function toUser(row: UserRow): SlackUser {
	return Object.freeze({
		admin: row.is_admin === 1,
		bot: row.is_bot === 1,
		createdAt: new Date(row.created_at_ms),
		id: row.id,
		name: row.name,
	});
}
