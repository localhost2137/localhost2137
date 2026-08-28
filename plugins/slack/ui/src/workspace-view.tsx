import {
	type FormEvent,
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SlackUiChannel, SlackUiSnapshot, SlackUiUser } from "../../src/ui/contract.js";
import { ChevronDownIcon, CloseIcon, HashIcon, LockIcon, MenuIcon, PlusIcon } from "./icons.js";
import { avatarTone, initials, messagesInReadingOrder } from "./workspace-model.js";

export interface WorkspaceMutation {
	readonly error: string | null;
	readonly kind: "create-channel" | "join-channel" | "send-message" | null;
}

interface SlackWorkspaceViewProps {
	readonly actingUser: SlackUiUser | null;
	readonly actingUserId: string | null;
	readonly isNarrowViewport: boolean;
	readonly mutation: WorkspaceMutation;
	readonly onActingUserChange: (id: string) => void;
	readonly onClearMutationError: () => void;
	readonly onCreateChannel: (name: string) => Promise<boolean>;
	readonly onJoinChannel: () => Promise<boolean>;
	readonly onRetry: () => void;
	readonly onSelectChannel: (id: string) => void;
	readonly onSendMessage: (text: string) => Promise<boolean>;
	readonly phase: "error" | "loading" | "ready" | "stale";
	readonly refreshError: string | null;
	readonly selectedChannel: SlackUiChannel | null;
	readonly selectionPending: boolean;
	readonly snapshot: SlackUiSnapshot | null;
}

export function SlackWorkspaceView(props: SlackWorkspaceViewProps) {
	const [createChannelOpen, setCreateChannelOpen] = useState(false);
	const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
	const messageList = useRef<HTMLElement>(null);
	const mobileMenuButton = useRef<HTMLButtonElement>(null);
	const mobileNavigation = useRef<HTMLElement>(null);
	const mobileNavigationClose = useRef<HTMLButtonElement>(null);
	const shouldStickToLatest = useRef(true);
	const snapshot = props.snapshot;
	const selectedChannel = props.selectedChannel;
	const messages = useMemo(
		() =>
			messagesInReadingOrder(
				(snapshot?.messages ?? []).filter((message) => message.channelId === selectedChannel?.id),
			),
		[selectedChannel?.id, snapshot?.messages],
	);
	const actingUser = props.actingUser;
	const isMember = Boolean(
		selectedChannel && actingUser && selectedChannel.memberIds.includes(actingUser.id),
	);
	const lastMessageId = messages.at(-1)?.id;
	const scrollTarget = `${selectedChannel?.id ?? ""}:${lastMessageId ?? ""}`;
	const mutationBusy = props.mutation.kind !== null;
	const mobileDrawerOpen = props.isNarrowViewport && mobileNavigationOpen;
	const closeMobileNavigation = useCallback(() => {
		setMobileNavigationOpen(false);
		if (props.isNarrowViewport) {
			globalThis.queueMicrotask(() => mobileMenuButton.current?.focus());
		}
	}, [props.isNarrowViewport]);
	const openCreateChannel = () => {
		props.onClearMutationError();
		setCreateChannelOpen(true);
	};

	useEffect(() => {
		if (scrollTarget === ":") return;
		if (!shouldStickToLatest.current) return;
		const element = messageList.current;
		if (!element) return;
		element.scrollTo({
			behavior: globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
			top: element.scrollHeight,
		});
	}, [scrollTarget]);

	useEffect(() => {
		if (!createChannelOpen && !mobileNavigationOpen) return;
		const closeOnEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (createChannelOpen) setCreateChannelOpen(false);
			else closeMobileNavigation();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [closeMobileNavigation, createChannelOpen, mobileNavigationOpen]);

	useEffect(() => {
		if (mobileDrawerOpen) mobileNavigationClose.current?.focus();
	}, [mobileDrawerOpen]);

	useEffect(() => {
		if (!props.isNarrowViewport) setMobileNavigationOpen(false);
	}, [props.isNarrowViewport]);

	const chooseChannel = (id: string) => {
		props.onSelectChannel(id);
		shouldStickToLatest.current = true;
		closeMobileNavigation();
	};

	return (
		<div className="slack-shell">
			<header className="workspace-bar" inert={mobileDrawerOpen || undefined}>
				<button
					aria-controls="workspace-navigation"
					aria-expanded={mobileDrawerOpen}
					aria-label="Open workspace navigation"
					className="icon-button mobile-menu-button"
					onClick={() => setMobileNavigationOpen(true)}
					ref={mobileMenuButton}
					type="button"
				>
					<MenuIcon />
				</button>
				<span className="workspace-bar-name">{snapshot?.workspace.name ?? "Local Slack"}</span>
				<ConnectionStatus phase={props.phase} />
			</header>

			<div className="workspace-body">
				<button
					aria-label="Close workspace navigation"
					className={`navigation-scrim${mobileDrawerOpen ? " is-open" : ""}`}
					onClick={closeMobileNavigation}
					type="button"
				/>
				<aside
					aria-hidden={props.isNarrowViewport && !mobileDrawerOpen ? true : undefined}
					className={`workspace-sidebar${mobileDrawerOpen ? " is-open" : ""}`}
					id="workspace-navigation"
					inert={props.isNarrowViewport && !mobileDrawerOpen ? true : undefined}
					onKeyDown={(event) => {
						if (mobileDrawerOpen) keepFocusWithin(event, mobileNavigation.current);
					}}
					ref={mobileNavigation}
				>
					<SidebarHeader
						closeButtonRef={mobileNavigationClose}
						onClose={closeMobileNavigation}
						workspaceName={snapshot?.workspace.name ?? "Local Slack"}
					/>
					<ActingUserPicker
						disabled={mutationBusy}
						onChange={props.onActingUserChange}
						selected={props.actingUserId}
						users={snapshot?.users ?? []}
					/>
					<ChannelNavigation
						channels={snapshot?.channels ?? []}
						disabled={mutationBusy}
						onCreate={openCreateChannel}
						onSelect={chooseChannel}
						selectedChannelId={selectedChannel?.id ?? null}
					/>
					<p className="local-runtime-note">Local emulator · no sign-in required</p>
				</aside>

				<main className="conversation" id="main-content" inert={mobileDrawerOpen || undefined}>
					{props.phase === "loading" && !snapshot ? (
						<LoadingWorkspace />
					) : props.phase === "error" && !snapshot ? (
						<UnavailableWorkspace error={props.refreshError} onRetry={props.onRetry} />
					) : snapshot ? (
						<>
							{props.refreshError || (props.mutation.error && !createChannelOpen) ? (
								<div className="notice-stack">
									{props.refreshError ? (
										<RefreshNotice error={props.refreshError} onRetry={props.onRetry} />
									) : null}
									{props.mutation.error && !createChannelOpen ? (
										<div className="mutation-error" role="alert">
											{props.mutation.error}
										</div>
									) : null}
								</div>
							) : null}
							{props.selectionPending ? (
								<LoadingChannel />
							) : selectedChannel ? (
								<>
									<ConversationHeader channel={selectedChannel} />
									<section
										aria-label={`${selectedChannel.name} message history`}
										className="message-history"
										onScroll={(event) => {
											const element = event.currentTarget;
											shouldStickToLatest.current =
												element.scrollHeight - element.scrollTop - element.clientHeight < 72;
										}}
										ref={messageList}
									>
										<div className="message-history-inner">
											<ChannelIntroduction channel={selectedChannel} />
											{snapshot.selectedChannelId === selectedChannel.id &&
											snapshot.hasMoreMessages ? (
												<p className="history-limit-notice">
													Showing the latest 200 messages from this local channel.
												</p>
											) : null}
											{messages.map((message) => {
												const author = snapshot.users.find((user) => user.id === message.userId);
												return (
													<MessageRow author={author ?? null} key={message.id} message={message} />
												);
											})}
										</div>
									</section>
									{isMember ? (
										<MessageComposer
											busy={mutationBusy}
											channelName={selectedChannel.name}
											key={selectedChannel.id}
											onSent={() => {
												shouldStickToLatest.current = true;
											}}
											onSend={props.onSendMessage}
										/>
									) : (
										<JoinChannel
											busy={mutationBusy}
											channel={selectedChannel}
											disabled={!actingUser}
											onJoin={props.onJoinChannel}
										/>
									)}
								</>
							) : (
								<NoChannels disabled={mutationBusy} onCreate={openCreateChannel} />
							)}
						</>
					) : null}
				</main>
			</div>

			{createChannelOpen ? (
				<CreateChannelDialog
					busy={props.mutation.kind === "create-channel"}
					disabled={!actingUser}
					error={props.mutation.error}
					onClose={() => setCreateChannelOpen(false)}
					onCreate={async (name) => {
						if (await props.onCreateChannel(name)) {
							setCreateChannelOpen(false);
							closeMobileNavigation();
						}
					}}
				/>
			) : null}
		</div>
	);
}

function SidebarHeader({
	closeButtonRef,
	onClose,
	workspaceName,
}: {
	readonly closeButtonRef: Ref<HTMLButtonElement>;
	readonly onClose: () => void;
	readonly workspaceName: string;
}) {
	return (
		<div className="sidebar-header">
			<div>
				<p className="sidebar-eyebrow">localhost2137</p>
				<h1>{workspaceName}</h1>
			</div>
			<button
				aria-label="Close workspace navigation"
				className="icon-button sidebar-close"
				onClick={onClose}
				ref={closeButtonRef}
				type="button"
			>
				<CloseIcon />
			</button>
		</div>
	);
}

function ActingUserPicker({
	disabled,
	onChange,
	selected,
	users,
}: {
	readonly disabled: boolean;
	readonly onChange: (id: string) => void;
	readonly selected: string | null;
	readonly users: readonly SlackUiUser[];
}) {
	return (
		<label className="acting-user-picker">
			<span>Act as</span>
			<div className="select-wrap">
				<select
					disabled={disabled || users.length === 0}
					onChange={(event) => onChange(event.currentTarget.value)}
					value={selected ?? ""}
				>
					{users.length === 0 ? <option value="">No local users</option> : null}
					{users.map((user) => (
						<option key={user.id} value={user.id}>
							{user.name}
							{user.bot ? " (bot)" : ""}
						</option>
					))}
				</select>
				<ChevronDownIcon />
			</div>
		</label>
	);
}

function ChannelNavigation({
	channels,
	disabled,
	onCreate,
	onSelect,
	selectedChannelId,
}: {
	readonly channels: readonly SlackUiChannel[];
	readonly disabled: boolean;
	readonly onCreate: () => void;
	readonly onSelect: (id: string) => void;
	readonly selectedChannelId: string | null;
}) {
	return (
		<nav aria-label="Channels" className="channel-navigation">
			<div className="channel-navigation-heading">
				<span>Channels</span>
				<button
					aria-label="Create a channel"
					className="icon-button add-channel-button"
					disabled={disabled}
					onClick={onCreate}
					type="button"
				>
					<PlusIcon />
				</button>
			</div>
			{channels.length === 0 ? (
				<p className="no-channel-note">No channels yet</p>
			) : (
				<ul>
					{channels.map((channel) => (
						<li key={channel.id}>
							<button
								aria-current={channel.id === selectedChannelId ? "page" : undefined}
								className="channel-link"
								disabled={disabled}
								onClick={() => onSelect(channel.id)}
								type="button"
							>
								{channel.private ? <LockIcon /> : <HashIcon />}
								<span>{channel.name}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</nav>
	);
}

function ConversationHeader({ channel }: { readonly channel: SlackUiChannel }) {
	return (
		<header className="conversation-header">
			<div>
				<h2>
					{channel.private ? <LockIcon /> : <HashIcon />}
					{channel.name}
				</h2>
				<p>{channel.private ? "Private channel" : "Channel"}</p>
			</div>
			<div className="member-count">
				<span aria-hidden="true" className="member-stack">
					●●
				</span>
				{channel.memberIds.length}
				<span className="visually-hidden"> members</span>
			</div>
		</header>
	);
}

function ChannelIntroduction({ channel }: { readonly channel: SlackUiChannel }) {
	return (
		<section className="channel-introduction">
			<div className="channel-introduction-icon">
				{channel.private ? <LockIcon /> : <HashIcon />}
			</div>
			<h3>This is the beginning of #{channel.name}</h3>
			<p>Messages here use the same local state as your app, tests, and localhost2137 CLI.</p>
		</section>
	);
}

function MessageRow({
	author,
	message,
}: {
	readonly author: SlackUiUser | null;
	readonly message: SlackUiSnapshot["messages"][number];
}) {
	const authorName = author?.name ?? message.userId;
	const createdAt = new Date(message.createdAt);
	return (
		<article className="message-row">
			<Avatar id={author?.id ?? message.userId} name={authorName} />
			<div className="message-content">
				<div className="message-meta">
					<strong>{authorName}</strong>
					{author?.bot ? <span className="app-badge">APP</span> : null}
					{message.threadTs ? <span className="thread-badge">Thread reply</span> : null}
					<time dateTime={message.createdAt} title={formatFullDate(createdAt)}>
						{formatTime(createdAt)}
					</time>
				</div>
				<p>{message.text}</p>
			</div>
		</article>
	);
}

function Avatar({ id, name }: { readonly id: string; readonly name: string }) {
	return (
		<span aria-hidden="true" className={`avatar avatar-tone-${String(avatarTone(id))}`}>
			{initials(name)}
		</span>
	);
}

function MessageComposer({
	busy,
	channelName,
	onSend,
	onSent,
}: {
	readonly busy: boolean;
	readonly channelName: string;
	readonly onSend: (text: string) => Promise<boolean>;
	readonly onSent: () => void;
}) {
	const [draft, setDraft] = useState("");

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = draft.trim();
		if (!text || busy) return;
		if (await onSend(text)) {
			setDraft("");
			onSent();
		}
	}

	function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	return (
		<form className="message-composer-wrap" onSubmit={submit}>
			<div className="message-composer">
				<label className="visually-hidden" htmlFor="message-draft">
					Message #{channelName}
				</label>
				<textarea
					autoComplete="off"
					disabled={busy}
					id="message-draft"
					onChange={(event) => setDraft(event.currentTarget.value)}
					onKeyDown={submitOnEnter}
					placeholder={`Message #${channelName}`}
					rows={2}
					value={draft}
				/>
				<div className="composer-footer">
					<span>Shift + Enter for a new line</span>
					<button disabled={busy || draft.trim() === ""} type="submit">
						{busy ? "Sending…" : "Send"}
					</button>
				</div>
			</div>
		</form>
	);
}

function JoinChannel({
	busy,
	channel,
	disabled,
	onJoin,
}: {
	readonly busy: boolean;
	readonly channel: SlackUiChannel;
	readonly disabled: boolean;
	readonly onJoin: () => Promise<boolean>;
}) {
	return (
		<div className="join-channel">
			<div>
				<strong>You’re viewing #{channel.name}</strong>
				<span>Join as the selected local user to send messages.</span>
			</div>
			<button disabled={busy || disabled} onClick={() => void onJoin()} type="button">
				{busy ? "Joining…" : "Join channel"}
			</button>
		</div>
	);
}

function NoChannels({
	disabled,
	onCreate,
}: {
	readonly disabled: boolean;
	readonly onCreate: () => void;
}) {
	return (
		<section className="centered-state">
			<div className="empty-channel-mark">
				<HashIcon />
			</div>
			<p className="state-kicker">Local workspace ready</p>
			<h2>Create the first channel</h2>
			<p>It will be available immediately to your app, tests, and CLI.</p>
			<button className="primary-button" disabled={disabled} onClick={onCreate} type="button">
				Create a channel
			</button>
		</section>
	);
}

function LoadingChannel() {
	return (
		<div aria-live="polite" className="centered-state" role="status">
			<span className="loading-indicator" />
			<h2>Opening this channel</h2>
			<p>Loading its current membership and message history.</p>
		</div>
	);
}

function LoadingWorkspace() {
	return (
		<div aria-live="polite" className="centered-state" role="status">
			<span className="loading-indicator" />
			<h2>Opening your local workspace</h2>
			<p>Reading channels and messages from this instance.</p>
		</div>
	);
}

function UnavailableWorkspace({
	error,
	onRetry,
}: {
	readonly error: string | null;
	readonly onRetry: () => void;
}) {
	return (
		<div className="centered-state" role="alert">
			<p className="state-kicker">Connection interrupted</p>
			<h2>Couldn’t open this workspace</h2>
			<p>{error ?? "The local Slack runtime did not respond."}</p>
			<button className="primary-button" onClick={onRetry} type="button">
				Try again
			</button>
		</div>
	);
}

function RefreshNotice({
	error,
	onRetry,
}: {
	readonly error: string;
	readonly onRetry: () => void;
}) {
	return (
		<div className="refresh-notice" role="status">
			<span>Live updates paused. {error}</span>
			<button onClick={onRetry} type="button">
				Retry
			</button>
		</div>
	);
}

function ConnectionStatus({ phase }: { readonly phase: SlackWorkspaceViewProps["phase"] }) {
	const label =
		phase === "stale" || phase === "error"
			? "Reconnecting"
			: phase === "loading"
				? "Connecting"
				: "Live";
	return (
		<span aria-live="polite" className={`connection-status connection-${phase}`}>
			<span aria-hidden="true" />
			{label}
		</span>
	);
}

function CreateChannelDialog({
	busy,
	disabled,
	error,
	onClose,
	onCreate,
}: {
	readonly busy: boolean;
	readonly disabled: boolean;
	readonly error: string | null;
	readonly onClose: () => void;
	readonly onCreate: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const dialog = useRef<HTMLFormElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const previouslyFocused = document.activeElement;
		nameInput.current?.focus();
		return () => {
			if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
		};
	}, []);

	return (
		<div
			aria-labelledby="create-channel-title"
			aria-modal="true"
			className="dialog-backdrop"
			role="dialog"
		>
			<form
				className="channel-dialog"
				onKeyDown={(event) => keepFocusWithin(event, dialog.current)}
				onSubmit={(event) => {
					event.preventDefault();
					const normalized = name.trim();
					if (normalized) void onCreate(normalized);
				}}
				ref={dialog}
			>
				<div className="dialog-heading">
					<div>
						<p className="state-kicker">New conversation</p>
						<h2 id="create-channel-title">Create a channel</h2>
					</div>
					<button
						aria-label="Close create channel dialog"
						className="icon-button"
						onClick={onClose}
						type="button"
					>
						<CloseIcon />
					</button>
				</div>
				<p>Channels are shared with the emulated Slack API and localhost2137 operations.</p>
				<label htmlFor="channel-name">Name</label>
				<div className="channel-name-input">
					<HashIcon />
					<input
						aria-describedby={`channel-name-help${error ? " channel-name-error" : ""}`}
						id="channel-name"
						maxLength={80}
						onChange={(event) => setName(event.currentTarget.value.toLowerCase())}
						pattern="[a-z0-9][a-z0-9_-]{0,79}"
						placeholder="project-updates"
						ref={nameInput}
						required
						value={name}
					/>
				</div>
				<span className="field-help" id="channel-name-help">
					Lowercase letters, numbers, hyphens, and underscores.
				</span>
				{error ? (
					<p className="dialog-warning" id="channel-name-error" role="alert">
						{error}
					</p>
				) : null}
				{disabled ? (
					<p className="dialog-warning">Create a local user before creating a channel.</p>
				) : null}
				<div className="dialog-actions">
					<button className="secondary-button" onClick={onClose} type="button">
						Cancel
					</button>
					<button
						className="primary-button"
						disabled={busy || disabled || name.trim() === ""}
						type="submit"
					>
						{busy ? "Creating…" : "Create channel"}
					</button>
				</div>
			</form>
		</div>
	);
}

function keepFocusWithin(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null): void {
	if (event.key !== "Tab") return;
	const focusable = container?.querySelectorAll<HTMLElement>(
		'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
	);
	if (!focusable || focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last?.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first?.focus();
	}
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: "full",
	timeStyle: "short",
});

function formatTime(date: Date): string {
	return Number.isNaN(date.getTime()) ? "" : timeFormatter.format(date);
}

function formatFullDate(date: Date): string {
	return Number.isNaN(date.getTime()) ? "Unknown time" : fullDateFormatter.format(date);
}
