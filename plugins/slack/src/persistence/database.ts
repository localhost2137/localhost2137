import Database from "better-sqlite3";
import { ChannelRepository } from "./channel-repository.js";
import { DeliveryRepository } from "./delivery-repository.js";
import { MessageRepository } from "./message-repository.js";
import { UserRepository } from "./user-repository.js";
import { WorkspaceRepository } from "./workspace-repository.js";

export class SlackDatabase {
	readonly channels: ChannelRepository;
	readonly deliveries: DeliveryRepository;
	readonly messages: MessageRepository;
	readonly users: UserRepository;
	readonly workspace: WorkspaceRepository;
	readonly #database: Database.Database;
	#closed = false;

	constructor(path: string) {
		this.#database = new Database(path);
		this.#database.pragma("foreign_keys = ON");
		this.#database.pragma("journal_mode = WAL");
		this.#database.pragma("busy_timeout = 5000");
		this.channels = new ChannelRepository(this.#database);
		this.deliveries = new DeliveryRepository(this.#database);
		this.messages = new MessageRepository(this.#database);
		this.users = new UserRepository(this.#database);
		this.workspace = new WorkspaceRepository(this.#database);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}

	raw(): Database.Database {
		this.#assertOpen();
		return this.#database;
	}

	transaction<Result>(work: () => Result): Result {
		this.#assertOpen();
		return this.#database.transaction(work)();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Slack database is closed.");
	}
}
