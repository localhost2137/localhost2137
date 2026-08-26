import type Database from "better-sqlite3";
import type { SlackWorkspace, UserId } from "../domain/models.js";

interface WorkspaceRow {
	readonly bot_user_id: string;
	readonly id: string;
	readonly name: string;
}

export class WorkspaceRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	get(): SlackWorkspace {
		const row = this.#database
			.prepare("SELECT id, name, bot_user_id FROM workspace LIMIT 1")
			.get() as WorkspaceRow | undefined;
		if (!row) throw new Error("Slack workspace metadata is missing.");
		return toWorkspace(row);
	}

	upsert(input: Readonly<{ botUserId: UserId; id: string; name: string }>): void {
		this.#database
			.prepare(
				`INSERT INTO workspace(id, name, bot_user_id) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name, bot_user_id = excluded.bot_user_id`,
			)
			.run(input.id, input.name, input.botUserId);
	}
}

function toWorkspace(row: WorkspaceRow): SlackWorkspace {
	return Object.freeze({ botUserId: row.bot_user_id, id: row.id, name: row.name });
}
