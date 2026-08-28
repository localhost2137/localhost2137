import { useEffect, useState } from "react";
import { slackDashboardClient } from "./client.js";
import { useSlackWorkspace } from "./use-workspace.js";
import { findChannel, findUser, resolvedChannelId, resolvedUserId } from "./workspace-model.js";
import { SlackWorkspaceView, type WorkspaceMutation } from "./workspace-view.js";

export function SlackDashboard() {
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
	const [actingUserId, setActingUserId] = useState<string | null>(null);
	const [mutation, setMutation] = useState<WorkspaceMutation>(idleMutation);
	const workspace = useSlackWorkspace(selectedChannelId);
	const snapshot = workspace.snapshot;

	useEffect(() => {
		if (!snapshot) return;
		setSelectedChannelId((current) => resolvedChannelId(current, snapshot));
		setActingUserId((current) => resolvedUserId(current, snapshot.users));
	}, [snapshot]);

	const selectedChannel = findChannel(snapshot?.channels ?? [], selectedChannelId);
	const actingUser = findUser(snapshot?.users ?? [], actingUserId);

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
		setMutation({ error: null, kind });
		try {
			await work();
			setMutation(idleMutation);
			workspace.refresh();
			return true;
		} catch (cause) {
			setMutation({ error: mutationError(cause), kind: null });
			return false;
		}
	}

	return (
		<SlackWorkspaceView
			actingUser={actingUser}
			actingUserId={actingUserId}
			mutation={mutation}
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
			selectedChannel={selectedChannel}
			snapshot={snapshot}
		/>
	);
}

const idleMutation: WorkspaceMutation = Object.freeze({ error: null, kind: null });

function mutationError(cause: unknown): string {
	return cause instanceof Error && cause.message.trim() !== ""
		? cause.message
		: "The local Slack workspace could not apply that change.";
}
