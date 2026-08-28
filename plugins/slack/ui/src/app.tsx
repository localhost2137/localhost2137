import { useEffect, useRef, useState } from "react";
import { slackDashboardClient } from "./client.js";
import { useSlackWorkspace } from "./use-workspace.js";
import { findChannel, findUser, resolvedChannelId, resolvedUserId } from "./workspace-model.js";
import { SlackWorkspaceView, type WorkspaceMutation } from "./workspace-view.js";

export function SlackDashboard() {
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
	const [actingUserId, setActingUserId] = useState<string | null>(null);
	const [mutation, setMutation] = useState<WorkspaceMutation>(idleMutation);
	const mutationInFlight = useRef(false);
	const narrowViewport = useNarrowViewport();
	const workspace = useSlackWorkspace(selectedChannelId);
	const snapshot = workspace.snapshot;

	useEffect(() => {
		if (!snapshot) return;
		setSelectedChannelId((current) => resolvedChannelId(current, snapshot));
		setActingUserId((current) => resolvedUserId(current, snapshot.users));
	}, [snapshot]);

	const visibleChannelId = selectedChannelId
		? (findChannel(snapshot?.channels ?? [], selectedChannelId)?.id ?? null)
		: snapshot
			? resolvedChannelId(null, snapshot)
			: null;
	const visibleUserId = snapshot ? resolvedUserId(actingUserId, snapshot.users) : null;
	const selectedChannel = findChannel(snapshot?.channels ?? [], visibleChannelId);
	const actingUser = findUser(snapshot?.users ?? [], visibleUserId);
	const targetChannelId = selectedChannelId ?? visibleChannelId;

	async function createChannel(name: string): Promise<boolean> {
		if (!actingUser) return false;
		return runMutation("create-channel", async () => {
			const created = await slackDashboardClient.createChannel({ creator: actingUser.id, name });
			setSelectedChannelId(created.channel.id);
		});
	}

	async function joinChannel(): Promise<boolean> {
		if (!actingUser || !selectedChannel) return false;
		return runMutation("join-channel", () =>
			slackDashboardClient.joinChannel({
				channel: selectedChannel.id,
				user: actingUser.id,
			}),
		);
	}

	async function sendMessage(text: string): Promise<boolean> {
		if (!actingUser || !selectedChannel) return false;
		return runMutation("send-message", () =>
			slackDashboardClient.sendMessage({
				channel: selectedChannel.id,
				text,
				user: actingUser.id,
			}),
		);
	}

	async function runMutation(
		kind: Exclude<WorkspaceMutation["kind"], null>,
		work: () => Promise<unknown>,
	): Promise<boolean> {
		if (mutationInFlight.current) return false;
		mutationInFlight.current = true;
		setMutation({ error: null, kind });
		try {
			await work();
			setMutation(idleMutation);
			workspace.refresh();
			return true;
		} catch (cause) {
			setMutation({ error: mutationError(cause), kind: null });
			return false;
		} finally {
			mutationInFlight.current = false;
		}
	}

	return (
		<SlackWorkspaceView
			actingUser={actingUser}
			actingUserId={visibleUserId}
			isNarrowViewport={narrowViewport}
			mutation={mutation}
			onClearMutationError={() => setMutation(idleMutation)}
			onActingUserChange={(id) => {
				setActingUserId(id);
				setMutation(idleMutation);
			}}
			onCreateChannel={createChannel}
			onJoinChannel={joinChannel}
			onRetry={workspace.refresh}
			onSelectChannel={(id) => {
				setSelectedChannelId(id);
				setMutation(idleMutation);
			}}
			onSendMessage={sendMessage}
			phase={workspace.phase}
			refreshError={workspace.error}
			selectionPending={Boolean(targetChannelId && snapshot?.selectedChannelId !== targetChannelId)}
			selectedChannel={selectedChannel}
			snapshot={snapshot}
		/>
	);
}

function useNarrowViewport(): boolean {
	const [narrow, setNarrow] = useState(() =>
		typeof globalThis.matchMedia === "function"
			? globalThis.matchMedia("(max-width: 720px)").matches
			: false,
	);

	useEffect(() => {
		const media = globalThis.matchMedia("(max-width: 720px)");
		const changed = () => setNarrow(media.matches);
		media.addEventListener("change", changed);
		return () => media.removeEventListener("change", changed);
	}, []);

	return narrow;
}

const idleMutation: WorkspaceMutation = Object.freeze({ error: null, kind: null });

function mutationError(cause: unknown): string {
	return cause instanceof Error && cause.message.trim() !== ""
		? cause.message
		: "The local Slack workspace could not apply that change.";
}
