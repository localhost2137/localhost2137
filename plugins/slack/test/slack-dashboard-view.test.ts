import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlackUiSnapshot } from "../src/ui/contract.js";
import {
	avatarTone,
	initials,
	messagesInReadingOrder,
	resolvedChannelId,
	resolvedUserId,
} from "../ui/src/workspace-model.js";
import { SlackWorkspaceView } from "../ui/src/workspace-view.js";

describe("Slack dashboard workspace model", () => {
	it("keeps valid selections and falls back to a human and the first channel", () => {
		const snapshot = snapshotFixture();
		expect(resolvedChannelId("C_RANDOM", snapshot)).toBe("C_RANDOM");
		expect(resolvedChannelId("C_MISSING", snapshot)).toBe("C_GENERAL");
		expect(resolvedUserId("U_BOT", snapshot.users)).toBe("U_BOT");
		expect(resolvedUserId("U_MISSING", snapshot.users)).toBe("U_ADA");
	});

	it("turns the newest-first transport page into reading order without mutation", () => {
		const messages = snapshotFixture().messages;
		const ordered = messagesInReadingOrder(messages);
		expect(ordered.map((message) => message.id)).toEqual(["M_OLDER", "M_NEWER"]);
		expect(messages.map((message) => message.id)).toEqual(["M_NEWER", "M_OLDER"]);
		expect(initials("Ada Lovelace")).toBe("AL");
		expect(avatarTone("U_ADA")).toBe(avatarTone("U_ADA"));
	});
});

describe("Slack dashboard work surface", () => {
	it("renders real channel, identity, history, and composer controls", () => {
		const snapshot = snapshotFixture();
		const html = renderWorkspace({
			actingUser: snapshot.users[1] ?? null,
			actingUserId: "U_ADA",
			selectedChannel: snapshot.channels[0] ?? null,
			snapshot,
		});

		expect(html).toContain("localhost2137");
		expect(html).toContain('aria-current="page"');
		expect(html).toContain("Ada Lovelace");
		expect(html).toContain('placeholder="Message #general"');
		expect(html).toContain("Thread reply");
		expect(html.indexOf("first local message")).toBeLessThan(html.indexOf("latest local message"));
		expect(html).not.toContain("Join channel");
	});

	it("renders an honest join boundary instead of a usable composer for a non-member", () => {
		const snapshot = snapshotFixture();
		const html = renderWorkspace({
			actingUser: snapshot.users[2] ?? null,
			actingUserId: "U_GRACE",
			selectedChannel: snapshot.channels[0] ?? null,
			snapshot,
		});

		expect(html).toContain("Join channel");
		expect(html).toContain("Join as the selected local user to send messages.");
		expect(html).not.toContain('placeholder="Message #general"');
	});

	it("keeps useful state visible while live refresh is interrupted", () => {
		const snapshot = snapshotFixture();
		const html = renderWorkspace({
			actingUser: snapshot.users[1] ?? null,
			actingUserId: "U_ADA",
			phase: "stale",
			refreshError: "Runtime unavailable.",
			selectedChannel: snapshot.channels[0] ?? null,
			snapshot,
		});

		expect(html).toContain("Reconnecting");
		expect(html).toContain("Live updates paused. Runtime unavailable.");
		expect(html).toContain("latest local message");
	});

	it("never places a stale message page beneath a newly selected channel", () => {
		const snapshot = { ...snapshotFixture(), hasMoreMessages: true };
		const html = renderWorkspace({
			actingUser: snapshot.users[0] ?? null,
			actingUserId: "U_BOT",
			phase: "stale",
			selectedChannel: snapshot.channels[1] ?? null,
			snapshot,
		});

		expect(html).toContain("This is the beginning of #random");
		expect(html).not.toContain("latest local message");
		expect(html).not.toContain("Showing the latest 200 messages");
	});

	it("keeps closed narrow navigation out of the accessibility tree", () => {
		const snapshot = snapshotFixture();
		const html = renderWorkspace({
			actingUser: snapshot.users[1] ?? null,
			actingUserId: "U_ADA",
			isNarrowViewport: true,
			selectedChannel: snapshot.channels[0] ?? null,
			snapshot,
		});

		expect(html).toContain('<aside aria-hidden="true"');
		expect(html).toContain('inert=""');
	});

	it("shows an honest channel transition instead of the empty-workspace call to action", () => {
		const html = renderWorkspace({
			selectionPending: true,
			snapshot: { ...snapshotFixture(), channels: [], messages: [], selectedChannelId: null },
		});

		expect(html).toContain("Opening this channel");
		expect(html).not.toContain("Create the first channel");
	});
});

function renderWorkspace(overrides: Partial<Parameters<typeof SlackWorkspaceView>[0]>): string {
	const props: Parameters<typeof SlackWorkspaceView>[0] = {
		actingUser: null,
		actingUserId: null,
		isNarrowViewport: false,
		mutation: { error: null, kind: null },
		onActingUserChange: () => undefined,
		onClearMutationError: () => undefined,
		onCreateChannel: async () => true,
		onJoinChannel: async () => true,
		onRetry: () => undefined,
		onSelectChannel: () => undefined,
		onSendMessage: async () => true,
		phase: "ready",
		refreshError: null,
		selectedChannel: null,
		selectionPending: false,
		snapshot: null,
		...overrides,
	};
	return renderToStaticMarkup(createElement(SlackWorkspaceView, props));
}

function snapshotFixture(): SlackUiSnapshot {
	return {
		channels: [
			{
				createdAt: "2026-08-28T08:00:00.000Z",
				id: "C_GENERAL",
				memberIds: ["U_BOT", "U_ADA"],
				name: "general",
				private: false,
			},
			{
				createdAt: "2026-08-28T08:01:00.000Z",
				id: "C_RANDOM",
				memberIds: ["U_BOT"],
				name: "random",
				private: false,
			},
		],
		hasMoreMessages: false,
		messages: [
			{
				channelId: "C_GENERAL",
				createdAt: "2026-08-28T08:03:00.000Z",
				id: "M_NEWER",
				text: "latest local message",
				threadTs: "1787904120.000000",
				ts: "1787904180.000000",
				userId: "U_ADA",
			},
			{
				channelId: "C_GENERAL",
				createdAt: "2026-08-28T08:02:00.000Z",
				id: "M_OLDER",
				text: "first local message",
				threadTs: null,
				ts: "1787904120.000000",
				userId: "U_BOT",
			},
		],
		selectedChannelId: "C_GENERAL",
		users: [
			{
				admin: false,
				bot: true,
				createdAt: "2026-08-28T08:00:00.000Z",
				id: "U_BOT",
				name: "localhost2137-bot",
			},
			{
				admin: true,
				bot: false,
				createdAt: "2026-08-28T08:00:00.000Z",
				id: "U_ADA",
				name: "Ada Lovelace",
			},
			{
				admin: false,
				bot: false,
				createdAt: "2026-08-28T08:00:00.000Z",
				id: "U_GRACE",
				name: "Grace Hopper",
			},
		],
		version: 1,
		workspace: { id: "T_LOCAL", name: "Acme Local" },
	};
}
