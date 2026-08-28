import type {
	SlackUiChannel,
	SlackUiMessage,
	SlackUiSnapshot,
	SlackUiUser,
} from "../../src/ui/contract.js";

export function resolvedChannelId(
	current: string | null,
	snapshot: SlackUiSnapshot,
): string | null {
	if (current && snapshot.channels.some((channel) => channel.id === current)) return current;
	return snapshot.selectedChannelId ?? snapshot.channels[0]?.id ?? null;
}

export function resolvedUserId(
	current: string | null,
	users: readonly SlackUiUser[],
): string | null {
	if (current && users.some((user) => user.id === current)) return current;
	return users.find((user) => !user.bot)?.id ?? users[0]?.id ?? null;
}

export function messagesInReadingOrder(
	messages: readonly SlackUiMessage[],
): readonly SlackUiMessage[] {
	return [...messages].reverse();
}

export function findChannel(
	channels: readonly SlackUiChannel[],
	id: string | null,
): SlackUiChannel | null {
	return id ? (channels.find((channel) => channel.id === id) ?? null) : null;
}

export function findUser(users: readonly SlackUiUser[], id: string | null): SlackUiUser | null {
	return id ? (users.find((user) => user.id === id) ?? null) : null;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (
		parts
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

export function avatarTone(id: string): number {
	let hash = 0;
	for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	return hash % 6;
}
