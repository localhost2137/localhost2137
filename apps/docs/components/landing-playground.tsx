import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { botCode, configCode } from "@/lib/landing-demo";
import { Icon } from "./landing-icons";
import "./landing-playground.css";

type Phase = "ready" | "message" | "event" | "handler" | "reply" | "complete" | "unmatched";
type Message = Readonly<{ id: number; author: "Ada" | "Ping bot"; text: string }>;
type CodeTab = "config" | "bot";

const stages = ["Message", "Event", "Handler", "Reply"] as const;
const phaseStep: Record<Phase, number> = {
	ready: -1,
	message: 0,
	event: 1,
	handler: 2,
	reply: 3,
	complete: 4,
	unmatched: 2,
};
const phaseStatus: Record<Phase, string> = {
	ready: "Send ping to follow the round trip.",
	message: "Message sent from the browser.",
	event: "Slack event delivered to the bot.",
	handler: "The ping handler is running.",
	reply: "Sending pong back to the channel.",
	complete: "pong delivered. Round trip complete.",
	unmatched: "Event delivered. This handler only matches “ping”, so no reply was sent.",
};

export function LandingPlayground() {
	const [draft, setDraft] = useState("ping");
	const [phase, setPhase] = useState<Phase>("ready");
	const [codeTab, setCodeTab] = useState<CodeTab>("config");
	const [compact, setCompact] = useState(false);
	const [messages, setMessages] = useState<readonly Message[]>([
		{ id: 0, author: "Ada", text: "Send “ping” to see the bot reply." },
	]);
	const instanceId = useId();
	const configTab = useRef<HTMLButtonElement>(null);
	const botTab = useRef<HTMLButtonElement>(null);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const nextId = useRef(1);
	const busy = useRef(false);
	const history = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const running = ["message", "event", "handler", "reply"].includes(phase);

	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	useEffect(() => {
		const media = window.matchMedia("(max-width: 760px)");
		const update = () => setCompact(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (history.current && messages.length > 0) {
			history.current.scrollTop = history.current.scrollHeight;
		}
	}, [messages]);

	function later(work: () => void, delay: number) {
		timers.current.push(setTimeout(work, delay));
	}

	function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
		let next: CodeTab;
		if (event.key === "Home") next = "config";
		else if (event.key === "End") next = "bot";
		else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			next = codeTab === "config" ? "bot" : "config";
		} else return;
		event.preventDefault();
		setCodeTab(next);
		(next === "config" ? configTab : botTab).current?.focus();
	}

	function send(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = draft;
		if (!text.trim() || busy.current) return;
		busy.current = true;
		timers.current.forEach(clearTimeout);
		timers.current = [];
		setMessages((current) => [
			...current.slice(-15),
			{ id: nextId.current++, author: "Ada", text },
		]);
		setDraft("");
		setPhase("message");
		later(() => setPhase("event"), 200);
		if (text === "ping") {
			later(() => setPhase("handler"), 550);
			later(() => setPhase("reply"), 1000);
		}
		later(() => {
			if (text === "ping") {
				setMessages((current) => [
					...current.slice(-15),
					{ id: nextId.current++, author: "Ping bot", text: "pong" },
				]);
			}
			setPhase(text === "ping" ? "complete" : "unmatched");
			busy.current = false;
			if (input.current?.form?.contains(document.activeElement)) {
				input.current.focus({ preventScroll: true });
			}
		}, 1250);
	}

	return (
		<section className="lp-playground" id="playground" aria-label="Interactive Slack bot example">
			<div className="lp-playground-bar">
				<span className="lp-local-label">
					<Icon name="local" />
					Everything on localhost
				</span>
				<span className="lp-simulation-label">Browser simulation</span>
			</div>
			<div className="lp-windows">
				<div className="lp-window lp-slack-window">
					<div className="lp-window-bar lp-browser-bar">
						<Icon name="browser" />
						<span>
							localhost:2137<span className="lp-url-path">/dev/slack</span>
						</span>
					</div>
					<div className="lp-slack-workspace">
						<aside className="lp-slack-sidebar" aria-hidden="true">
							<span className="lp-workspace-initial">L</span>
							<span className="lp-sidebar-channel">#</span>
							<span className="lp-sidebar-avatar">A</span>
						</aside>
						<div className="lp-chat">
							<div className="lp-channel-title"># general</div>
							<div
								className="lp-message-history"
								ref={history}
								role="log"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable log needs keyboard access.
								tabIndex={0}
								aria-label="Local Slack messages"
								aria-live="polite"
								aria-relevant="additions"
							>
								{messages.map((message) => (
									<div className="lp-message" key={message.id}>
										<span
											className={`lp-avatar ${message.author === "Ada" ? "lp-human" : "lp-bot"}`}
											aria-hidden="true"
										>
											{message.author === "Ada" ? "A" : <Icon name="code" />}
										</span>
										<div>
											<div className="lp-message-author">
												{message.author}
												{message.author === "Ping bot" && <span className="lp-app-tag">APP</span>}
											</div>
											<p>{message.text}</p>
										</div>
									</div>
								))}
							</div>
							<form className="lp-composer" onSubmit={send}>
								<label className="lp-sr-only" htmlFor={`${instanceId}-slack-message`}>
									Message #general
								</label>
								<input
									ref={input}
									id={`${instanceId}-slack-message`}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									maxLength={300}
									placeholder="Message #general"
									autoComplete="off"
								/>
								<button type="submit" disabled={!draft.trim() || running} aria-label="Send message">
									<Icon name="send" />
								</button>
							</form>
						</div>
					</div>
				</div>
				<div className="lp-code-tabs" role="tablist" aria-label="Example source code">
					<button
						ref={configTab}
						type="button"
						role="tab"
						id={`${instanceId}-tab-config`}
						aria-controls={`${instanceId}-panel-config`}
						aria-selected={codeTab === "config"}
						tabIndex={codeTab === "config" ? 0 : -1}
						onClick={() => setCodeTab("config")}
						onKeyDown={navigateTabs}
					>
						<Icon name="code" />
						Config
					</button>
					<button
						ref={botTab}
						type="button"
						role="tab"
						id={`${instanceId}-tab-bot`}
						aria-controls={`${instanceId}-panel-bot`}
						aria-selected={codeTab === "bot"}
						tabIndex={codeTab === "bot" ? 0 : -1}
						onClick={() => setCodeTab("bot")}
						onKeyDown={navigateTabs}
					>
						<Icon name="code" />
						Bot
					</button>
				</div>
				<CodeWindow
					id={`${instanceId}-panel-config`}
					tabId={`${instanceId}-tab-config`}
					compact={compact}
					selected={codeTab === "config"}
					name="localhost.config.ts"
					code={configCode}
					activeLines={phase === "event" ? [11, 12] : []}
				/>
				<CodeWindow
					id={`${instanceId}-panel-bot`}
					tabId={`${instanceId}-tab-bot`}
					compact={compact}
					selected={codeTab === "bot"}
					name="index.ts"
					code={botCode}
					activeLines={phase === "handler" ? [13, 14, 15] : []}
				>
					<code className="lp-run-command" title="Starts the bot on localhost:3000">
						$ node index.ts
					</code>
				</CodeWindow>
			</div>
			<div className={`lp-phase-rail is-${phase}`}>
				<ol className="lp-phase-stages" aria-label="Message lifecycle">
					{stages.map((stage, index) => {
						const done = index < phaseStep[phase];
						const active = running && index === phaseStep[phase];
						const unmatched = phase === "unmatched" && index === 2;
						const skipped = phase === "unmatched" && index === 3;
						return (
							<li
								key={stage}
								className={`${done ? "is-done" : ""} ${active ? "is-active" : ""} ${unmatched ? "is-unmatched" : ""}`}
								aria-current={active ? "step" : undefined}
							>
								<span className="lp-phase-marker" aria-hidden="true">
									{done ? "✓" : unmatched ? "−" : index + 1}
								</span>
								<span>{stage}</span>
								<span className="lp-sr-only">
									{done
										? ", complete"
										: active
											? ", in progress"
											: unmatched
												? ", no match"
												: skipped
													? ", skipped"
													: ", waiting"}
								</span>
							</li>
						);
					})}
				</ol>
				<p className="lp-phase-status" role="status" aria-live="polite" aria-atomic="true">
					{phaseStatus[phase]}
				</p>
			</div>
		</section>
	);
}

function CodeWindow({
	id,
	tabId,
	compact,
	selected,
	name,
	code,
	activeLines,
	children,
}: Readonly<{
	id: string;
	tabId: string;
	compact: boolean;
	selected: boolean;
	name: string;
	code: string;
	activeLines: readonly number[];
	children?: ReactNode;
}>) {
	return (
		<section
			id={id}
			className={`lp-window lp-code-window ${selected ? "is-selected" : ""}`}
			role={compact ? "tabpanel" : "region"}
			aria-label={compact ? undefined : name}
			aria-labelledby={compact ? tabId : undefined}
			hidden={compact && !selected}
			tabIndex={compact ? 0 : undefined}
		>
			<div className="lp-window-bar">
				<Icon name="code" />
				<span>{name}</span>
			</div>
			<pre
				className="lp-code"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The source pane scrolls independently on small screens.
				tabIndex={0}
			>
				<code>
					{code.split("\n").map((line, index) => (
						<span
							// These are fixed source-code positions, not reorderable records.
							// biome-ignore lint/suspicious/noArrayIndexKey: line numbers identify fixed code positions.
							key={`${index}-${line}`}
							className={`lp-code-line ${activeLines.includes(index + 1) ? "is-active" : ""}`}
						>
							<span className="lp-line-number" aria-hidden="true">
								{index + 1}
							</span>
							<span>{highlight(line)}</span>
						</span>
					))}
				</code>
			</pre>
			{children}
		</section>
	);
}

function highlight(line: string): ReactNode[] {
	return line
		.split(
			/("(?:[^"\\]|\\.)*"|\/\^ping\$\/|\b(?:import|from|export|default|const|async|await)\b|\b(?:defineConfig|slack|App|say|start|message)\b|\b\d+\b)/g,
		)
		.map((part, index) => {
			const type =
				part.startsWith('"') || part.startsWith("/")
					? "string"
					: /^(import|from|export|default|const|async|await)$/.test(part)
						? "keyword"
						: /^(defineConfig|slack|App|say|start|message)$/.test(part)
							? "function"
							: /^\d+$/.test(part)
								? "number"
								: "plain";
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: tokens have no state and are identified by their source position.
				<span key={`${index}-${part}`} className={`lp-token-${type}`}>
					{part}
				</span>
			);
		});
}
