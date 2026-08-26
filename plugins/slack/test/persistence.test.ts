import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SlackService } from "../src/domain/slack-service.js";
import { SlackDatabase } from "../src/persistence/database.js";
import {
	assertCurrentDatabaseVersion,
	CURRENT_DATABASE_VERSION,
	migrateDatabase,
} from "../src/persistence/migrations.js";

const roots: string[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Slack persistence", () => {
	it("migrates a version-0 fixture and preserves its user", async () => {
		const database = await fixtureDatabase();
		try {
			database
				.raw()
				.exec(await readFile(new URL("./fixtures/schema-v0.sql", import.meta.url), "utf8"));
			migrateDatabase(database.raw());
			assertCurrentDatabaseVersion(database.raw());
			expect(database.raw().pragma("user_version", { simple: true })).toBe(
				CURRENT_DATABASE_VERSION,
			);
			expect(database.users.findById("U_LEGACY")).toMatchObject({
				admin: true,
				id: "U_LEGACY",
				name: "Legacy Ada",
			});
		} finally {
			database.close();
		}
	});

	it("stores related world changes transactionally with deterministic IDs and timestamps", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const ada = service.createUser({ admin: true, name: "Ada", now });
			const channel = service.createChannel({ name: "General", now });
			service.addUserToChannel(channel.id, ada.id);

			const first = service.postMessage({
				channel: "general",
				emitEvent: true,
				now,
				text: "ping",
				user: ada.id,
			});
			const second = service.postMessage({
				channel: channel.id,
				emitEvent: false,
				now,
				text: "pong",
				user: "U000000",
			});

			expect(ada.id).toBe("U000001");
			expect(channel.id).toBe("C000001");
			expect(first.message).toMatchObject({ id: "M000001", ts: "1767225600.000000" });
			expect(first.deliveryEventId).toBe("Ev000001");
			expect(second.message).toMatchObject({ id: "M000002", ts: "1767225600.000001" });
			expect(service.listMessages(channel.id, { limit: 100 }).map(({ text }) => text)).toEqual([
				"pong",
				"ping",
			]);
		} finally {
			database.close();
		}
	});

	it("rolls back message and event allocation when a write fails", async () => {
		const database = await migratedDatabase();
		try {
			const service = new SlackService(database);
			service.initialize(config(), now);
			const channel = service.createChannel({ name: "general", now });
			expect(() =>
				service.postMessage({
					channel: channel.id,
					emitEvent: true,
					now,
					text: "from a missing user",
					user: "U404",
				}),
			).toThrow("not found");
			expect(service.listMessages(channel.id, { limit: 100 })).toEqual([]);
		} finally {
			database.close();
		}
	});
});

async function fixtureDatabase(): Promise<SlackDatabase> {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-"));
	roots.push(root);
	return new SlackDatabase(join(root, "slack.sqlite"));
}

async function migratedDatabase(): Promise<SlackDatabase> {
	const database = await fixtureDatabase();
	migrateDatabase(database.raw());
	return database;
}

function config() {
	return {
		botToken: "xoxb-local-test",
		eventsUrl: null,
		signingSecret: "test-signing-secret",
		workspaceName: "Local Test",
	} as const;
}
