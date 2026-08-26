import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskTracker } from "localhost2137";
import { afterEach, describe, expect, it } from "vitest";
import type { SlackConfig } from "../src/config.js";
import { SlackService } from "../src/domain/slack-service.js";
import { SlackEventDispatcher } from "../src/events/event-dispatcher.js";
import { SlackDatabase } from "../src/persistence/database.js";
import { migrateDatabase } from "../src/persistence/migrations.js";

const roots: string[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Slack event response ownership", () => {
	it.each([
		{ expectedError: null, expectedStatus: "succeeded", statusCode: 200 },
		{ expectedError: "non_success_status", expectedStatus: "failed", statusCode: 503 },
	] as const)(
		"keeps tracked $statusCode streaming-response work open until cancellation completes",
		async ({ expectedError, expectedStatus, statusCode }) => {
			const fixture = await deliveryFixture();
			try {
				const cancellationStarted = deferred();
				const releaseCancellation = deferred();
				const response = new Response(
					new ReadableStream<Uint8Array>({
						async cancel() {
							cancellationStarted.resolve();
							await releaseCancellation.promise;
						},
						start(controller) {
							controller.enqueue(new TextEncoder().encode("partial response"));
						},
					}),
					{ status: statusCode },
				);
				const tracked = trackedTasks();
				fixture.dispatcher.schedule(
					{
						clock: { now: () => now },
						fetch: async () => response,
						signal: new AbortController().signal,
						tasks: tracked.tasks,
					},
					fixture.event,
				);

				await cancellationStarted.promise;
				const task = tracked.only();
				let settled = false;
				void task.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				await Promise.resolve();
				expect(settled).toBe(false);
				expect(fixture.database.deliveries.get(fixture.event.eventId)).toMatchObject({
					completedAt: null,
					status: "pending",
				});

				releaseCancellation.resolve();
				if (statusCode === 200) {
					await expect(task).resolves.toBeUndefined();
				} else {
					await expect(task).rejects.toThrow("HTTP 503");
				}
				expect(fixture.database.deliveries.get(fixture.event.eventId)).toMatchObject({
					error: expectedError,
					status: expectedStatus,
					statusCode,
				});
			} finally {
				fixture.database.close();
			}
		},
	);

	it("records response-body cancellation failure instead of reporting callback success", async () => {
		const fixture = await deliveryFixture();
		try {
			const response = new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						throw new Error("injected cancellation failure");
					},
					start(controller) {
						controller.enqueue(new TextEncoder().encode("partial response"));
					},
				}),
				{ status: 200 },
			);
			const tracked = trackedTasks();
			fixture.dispatcher.schedule(
				{
					clock: { now: () => now },
					fetch: async () => response,
					signal: new AbortController().signal,
					tasks: tracked.tasks,
				},
				fixture.event,
			);

			await expect(tracked.only()).rejects.toThrow(/response body could not be discarded/);
			expect(fixture.database.deliveries.get(fixture.event.eventId)).toMatchObject({
				error: "response_body_error",
				status: "failed",
				statusCode: 200,
			});
		} finally {
			fixture.database.close();
		}
	});
});

async function deliveryFixture() {
	const root = await mkdtemp(join(tmpdir(), "localhost2137-slack-event-"));
	roots.push(root);
	const database = new SlackDatabase(join(root, "slack.sqlite"));
	migrateDatabase(database.raw());
	const service = new SlackService(database);
	service.initialize(config, now);
	const channel = service.createChannel({ name: "general", now });
	const actor = service.requireUser("U000000");
	const created = service.postMessage({
		channel: channel.id,
		emitEvent: true,
		now,
		text: "ping",
		user: actor.id,
	});
	if (!created.deliveryEventId) throw new TypeError("Expected an event delivery fixture.");
	return {
		database,
		dispatcher: new SlackEventDispatcher(database, config),
		event: {
			actor,
			eventId: created.deliveryEventId,
			message: created.message,
		},
	};
}

function trackedTasks(): Readonly<{ only(): Promise<void>; tasks: TaskTracker }> {
	const tasks: Promise<void>[] = [];
	return {
		only() {
			const task = tasks[0];
			if (!task || tasks.length !== 1) throw new TypeError("Expected exactly one tracked task.");
			return task;
		},
		tasks: {
			track<Value>(_label: string, task: Promise<Value>): Promise<Value> {
				tasks.push(task as Promise<void>);
				return task;
			},
		},
	};
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return Object.freeze({
		promise,
		resolve: resolvePromise,
	});
}

const config: SlackConfig = Object.freeze({
	botToken: "xoxb-local-test",
	eventsUrl: "https://callbacks.example.test/slack/events",
	signingSecret: "local-signing-secret",
	workspaceName: "Local Test",
});
