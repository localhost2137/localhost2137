import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { botCode, configCode } from "@/lib/landing-demo";
import { Icon } from "./landing-icons";

type Phase = "ready" | "event" | "handler";
type Message = Readonly<{ id: number; author: "Ada" | "Ping bot"; text: string }>;

export function LandingPlayground() {
	const [draft, setDraft] = useState("ping");
	const [phase, setPhase] = useState<Phase>("ready");
	const [messages, setMessages] = useState<readonly Message[]>([
		{ id: 0, author: "Ada", text: "All running locally! Try sending “ping” 😁" },
	]);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const nextId = useRef(1);
	const busy = useRef(false);
	const history = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const running = phase === "event" || phase === "handler";

	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	useEffect(() => {
		if (history.current && messages.length > 0) {
			history.current.scrollTop = history.current.scrollHeight;
		}
	}, [messages]);

	function later(work: () => void, delay: number) {
		timers.current.push(setTimeout(work, delay));
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
		setPhase("event");
		if (text === "ping") later(() => setPhase("handler"), 550);
		later(() => {
			if (text === "ping") {
				setMessages((current) => [
					...current.slice(-15),
					{ id: nextId.current++, author: "Ping bot", text: "pong" },
				]);
			}
			setPhase("ready");
			busy.current = false;
			input.current?.focus({ preventScroll: true });
		}, 1250);
	}

	return (
		<section className="lp-playground" id="playground" aria-label="Interactive Slack bot example">
			<div className="lp-playground-bar">
				<span className="lp-local-label">
					<Icon name="local" />
					Everything on localhost
				</span>
				<span className="lp-simulation-label">Simulated example</span>
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
								<label className="lp-sr-only" htmlFor="slack-message">
									Message #general
								</label>
								<input
									ref={input}
									id="slack-message"
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
				<CodeWindow
					name="localhost.config.ts"
					code={configCode}
					activeLines={phase === "event" ? [11, 12] : []}
				/>
				<CodeWindow
					name="index.ts"
					code={botCode}
					activeLines={phase === "handler" ? [13, 14, 15] : []}
				>
					<code className="lp-run-command" title="Starts the bot on localhost:3000">
						$ node index.ts
					</code>
				</CodeWindow>
			</div>
		</section>
	);
}

function CodeWindow({
	name,
	code,
	activeLines,
	children,
}: Readonly<{
	name: string;
	code: string;
	activeLines: readonly number[];
	children?: ReactNode;
}>) {
	return (
		<div className="lp-window lp-code-window">
			<div className="lp-window-bar">
				<Icon name="code" />
				<span>{name}</span>
			</div>
			<pre className="lp-code">
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
		</div>
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
