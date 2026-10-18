import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect, useRef, useState } from "react";
import { LandingFlight } from "@/components/landing-flight";
import { Icon } from "@/components/landing-icons";
import { LandingPlayground } from "@/components/landing-playground";
import { setupPrompt } from "@/lib/landing-demo";
import type { Route } from "./+types/home";
import "../landing.css";

const repository = "https://github.com/localhost2137/localhost2137";

export function meta(): Route.MetaDescriptors {
	return [
		{ title: "localhost2137 — Test integrations without the account setup" },
		{
			name: "description",
			content:
				"Test integrations without the account setup. localhost2137 emulates external services on your machine. Your app calls their APIs; you or your agent control their data and events.",
		},
		{
			property: "og:title",
			content: "localhost2137 — Test integrations without the account setup",
		},
		{
			property: "og:description",
			content:
				"Your app uses the service APIs. You or your coding agent control the data and events behind them.",
		},
		{ property: "og:type", content: "website" },
	];
}

export default function LandingPage() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		setMounted(true);
		return () => clearTimeout(copyTimer.current);
	}, []);
	const themeLabel = mounted
		? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`
		: "Toggle color theme";

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(setupPrompt);
			setCopied(true);
			setCopyFailed(false);
			clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(false), 2500);
		} catch {
			setCopied(false);
			setCopyFailed(true);
			if (!dialog.current?.open) dialog.current?.showModal();
		}
	}

	return (
		<div className="lp-page">
			<a className="lp-skip-link" href="#main">
				Skip to content
			</a>
			<div className="lp-shell">
				<header className="lp-header">
					<a href="/" className="lp-brand" aria-label="localhost2137 home">
						localhost<span>2137</span>
					</a>
					<nav aria-label="Main navigation">
						<a href="/docs">Docs</a>
						<a href="https://www.npmjs.com/package/localhost2137">npm</a>
						<a href={repository} className="lp-github-link" aria-label="GitHub">
							<Icon name="github" />
							<span className="lp-github-label">GitHub</span>
						</a>
						<button
							type="button"
							className="lp-theme-toggle"
							aria-label={themeLabel}
							title={themeLabel}
							onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
						>
							<Icon name="sun" className="lp-theme-sun" />
							<Icon name="moon" className="lp-theme-moon" />
						</button>
					</nav>
				</header>
				<main id="main">
					<section className="lp-hero" aria-labelledby="hero-title">
						<LandingFlight theme={resolvedTheme} />
						<div className="lp-hero-content">
							<p className="lp-hero-eyebrow">External services. Running locally.</p>
							<h1 id="hero-title">
								Test integrations.
								<br />
								<span>Skip the account setup.</span>
							</h1>
							<div className="lp-hero-detail">
								<p>
									localhost2137 emulates external services on your machine. Your app calls their
									APIs; you or your agent control their data and events.
								</p>
								<div className="lp-hero-actions">
									<a href="/getting-started" className="lp-button">
										Read the docs <Icon name="arrow-right" />
									</a>
									<button
										type="button"
										className="lp-agent-button"
										onClick={() => void copyPrompt()}
										title="Copy instructions for your coding agent to run the Slack example locally"
									>
										<Icon name={copied ? "check" : "copy"} />
										{copied ? "Copied" : "Copy setup prompt"}
									</button>
									<span className="lp-sr-only" role="status">
										{copied ? "Setup prompt copied. Paste it into your coding agent." : ""}
									</span>
								</div>
							</div>
						</div>
						<a className="lp-hero-scroll" href="#local-demo">
							See it in action <Icon name="arrow-right" />
						</a>
					</section>
					<section className="lp-demo-section" id="local-demo" aria-labelledby="demo-title">
						<div className="lp-demo-heading">
							<div>
								<p className="lp-section-eyebrow">A real workflow, on localhost</p>
								<h2 id="demo-title">See the whole loop.</h2>
							</div>
							<p>Send a ping. Follow it through the code.</p>
						</div>
						<LandingPlayground />
					</section>
				</main>
				<footer className="lp-footer">
					<a href={`${repository}/tree/master/examples/slack-ping-bot`}>
						Example source <Icon name="arrow-up-right" />
					</a>
					<div>
						<span>Plugins:</span>
						<a href="/first-party/slack">Slack</a>
						<a href="/first-party/stripe">Stripe</a>
						<a href="/plugins/first-plugin">
							Build a plugin <Icon name="arrow-right" />
						</a>
					</div>
				</footer>
			</div>

			<dialog className="lp-prompt-dialog" ref={dialog} aria-labelledby="prompt-title">
				<div className="lp-dialog-header">
					<h2 id="prompt-title">Setup prompt</h2>
					<button
						type="button"
						aria-label="Close setup prompt"
						onClick={() => dialog.current?.close()}
					>
						<Icon name="close" />
					</button>
				</div>
				<p className="lp-dialog-description">
					Copy this prompt into your coding agent to run the Slack example locally.
				</p>
				<label className="lp-sr-only" htmlFor="setup-prompt">
					Setup prompt
				</label>
				<textarea
					id="setup-prompt"
					readOnly
					value={setupPrompt}
					spellCheck={false}
					onFocus={(event) => event.target.select()}
				/>
				<div className="lp-dialog-footer">
					<p role="status">
						{copyFailed
							? "Select the prompt and copy it manually."
							: copied
								? "Copied."
								: "Paste into your coding agent."}
					</p>
					<button type="button" className="lp-button" onClick={() => void copyPrompt()}>
						<Icon name={copied ? "check" : "copy"} />
						{copied ? "Copied" : "Copy prompt"}
					</button>
				</div>
			</dialog>
		</div>
	);
}
