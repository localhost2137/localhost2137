import { useCallback, useEffect, useRef, useState } from "react";
import type { SlackUiSnapshot } from "../../src/ui/contract.js";
import { slackDashboardClient } from "./client.js";
import { createSlackWorkspacePoller, type SlackWorkspacePoller } from "./poller.js";

export type SlackWorkspacePhase = "error" | "loading" | "ready" | "stale";

export interface SlackWorkspaceResource {
	readonly error: string | null;
	readonly phase: SlackWorkspacePhase;
	readonly refresh: () => void;
	readonly snapshot: SlackUiSnapshot | null;
}

export function useSlackWorkspace(selectedChannelId: string | null): SlackWorkspaceResource {
	const [snapshot, setSnapshot] = useState<SlackUiSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [phase, setPhase] = useState<SlackWorkspacePhase>("loading");
	const pollerRef = useRef<SlackWorkspacePoller | null>(null);
	const snapshotRef = useRef<SlackUiSnapshot | null>(null);

	const refresh = useCallback(() => pollerRef.current?.refresh(), []);

	useEffect(() => {
		setPhase(snapshotRef.current ? "stale" : "loading");
		const poller = createSlackWorkspacePoller({
			isVisible: () => document.visibilityState !== "hidden",
			load: (signal) => slackDashboardClient.snapshot(selectedChannelId, signal),
			onError: (cause) => {
				setError(errorMessage(cause));
				setPhase(snapshotRef.current ? "stale" : "error");
			},
			onValue: (next) => {
				snapshotRef.current = next;
				setSnapshot(next);
				setError(null);
				setPhase("ready");
			},
		});
		pollerRef.current = poller;
		const visibilityChanged = () => poller.visibilityChanged();
		document.addEventListener("visibilitychange", visibilityChanged);
		poller.start();
		return () => {
			document.removeEventListener("visibilitychange", visibilityChanged);
			poller.stop();
			if (pollerRef.current === poller) pollerRef.current = null;
		};
	}, [selectedChannelId]);

	return { error, phase, refresh, snapshot };
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error && cause.message.trim() !== ""
		? cause.message
		: "The local Slack workspace could not be refreshed.";
}
