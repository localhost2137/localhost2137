import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect, useRef, useState } from "react";
import { LandingFlight } from "@/components/landing-flight";
import { Icon } from "@/components/landing-icons";
import { LandingPlayground } from "@/components/landing-playground";
import { LandingRuntimeDiagram } from "@/components/landing-runtime";
import { setupPrompt } from "@/lib/landing-demo";
import type { Route } from "./+types/home";
import "../landing.css";

const repository = "https://github.com/localhost2137/localhost2137";
const installCommand = "pnpm add -g localhost2137";

export function meta(): Route.MetaDescriptors {
	return [
		{ title: "localhost2137 — Local service emulators for you and your agent" },
		{
			name: "description",
			content:
				"Run Slack and Stripe emulators locally. Give your app their APIs and your coding agent control over users, data, events, and virtual time. No provider accounts required.",
		},
		{ property: "og:title", content: "localhost2137 — Build and test locally." },
		{
			property: "og:description",
			content:
				"A local runtime for stateful service emulators. Build and test integrations without the provider account setup.",
		},
		{ property: "og:type", content: "website" },
	];
}

export default function LandingPage() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [installCopy, setInstallCopy] = useState<"ready" | "copied" | "failed">("ready");
	const dialog = useRef<HTMLDialogElement>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const installTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		setMounted(true);
		return () => {
			clearTimeout(copyTimer.current);
			clearTimeout(installTimer.current);
		};
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
	async function copyInstall() {
		clearTimeout(installTimer.current);
		try {
			await navigator.clipboard.writeText(installCommand);
			setInstallCopy("copied");
			installTimer.current = setTimeout(() => setInstallCopy("ready"), 2500);
		} catch {
			setInstallCopy("failed");
		}
	}
	function showPrompt() {
		setCopyFailed(false);
		dialog.current?.showModal();
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
						<a href="#demo">Demo</a>
						<a href="#emulators" className="lp-nav-emulators">
							Emulators
						</a>
						<a href="/docs">Docs</a>
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
							<p className="lp-hero-eyebrow">A local runtime for service emulators.</p>
							<h1 id="hero-title">
								Setting up API keys
								<br />
								<span>
									is worse than <em>9/11.</em>
								</span>
							</h1>
							<div className="lp-hero-detail">
								<p>
									Your own local versions of Slack and Stripe.
									<br />
									APIs for your app. Data and events your agent can control.
								</p>
								<div className="lp-hero-actions">
									<a href="/getting-started" className="lp-button">
										Start locally <Icon name="arrow-right" />
									</a>
									<a href="#demo" className="lp-text-link">
										Try the demo <Icon name="arrow-down" />
									</a>
								</div>
							</div>
							<p className="lp-hero-assurance">No provider accounts. No real API keys.</p>
						</div>
						<a className="lp-hero-scroll" href="#problem">
							Skip the setup <Icon name="arrow-right" />
						</a>
					</section>

					<section className="lp-pain lp-section" id="problem" aria-labelledby="problem-title">
						<div className="lp-pain-copy">
							<p className="lp-section-eyebrow">
								<span>01</span> The bottleneck
							</p>
							<h2 id="problem-title">
								Sir, a second API key <br />
								has hit the <code>.env.</code>
							</h2>
							<p>
								All this to find out whether <code>“ping”</code> produces <code>“pong.”</code>
							</p>
						</div>
						<div className="lp-permissions">
							<ol>
								<li>
									<span>01</span>Set up each service
									<Icon name="arrow-down" />
								</li>
								<li>
									<span>02</span>Connect keys and webhooks
									<Icon name="arrow-down" />
								</li>
								<li>
									<span>03</span>Create test users and data
									<Icon name="arrow-down" />
								</li>
								<li>
									<span>04</span>Reproduce the failure. Again.
								</li>
							</ol>
							<p>
								<strong>
									Your agent wrote the integration. You’re still setting up services and testing it
									by hand.
								</strong>
							</p>
						</div>
					</section>

					<section className="lp-demo-section lp-section" id="demo" aria-labelledby="demo-title">
						<span id="local-demo" className="lp-anchor-alias" aria-hidden="true" />
						<div className="lp-demo-heading">
							<div>
								<p className="lp-section-eyebrow">
									<span>02</span> Try it
								</p>
								<h2 id="demo-title">
									Your agent wrote the bot.
									<br />
									You’re still setting up Slack.
								</h2>
							</div>
							<p>
								Give it a local Slack workspace where it can create users, send messages, and test
								the bot.
							</p>
						</div>
						<LandingPlayground />
						<div className="lp-demo-caption">
							<p>Browser simulation. Run the example to try the emulator with the Slack SDK.</p>
							<a href="/first-party/slack" className="lp-text-link">
								Run the Slack example <Icon name="arrow-up-right" />
							</a>
						</div>
						<div className="lp-agent-handoff">
							<div className="lp-handoff-copy">
								<span className="lp-handoff-icon" aria-hidden="true">
									<Icon name="code" />
								</span>
								<div>
									<h3>Run it with your agent.</h3>
								</div>
							</div>
							<div className="lp-handoff-actions">
								<button type="button" className="lp-agent-button" onClick={showPrompt}>
									View prompt
								</button>
								<button
									type="button"
									className="lp-button lp-button-secondary"
									onClick={() => void copyPrompt()}
								>
									<Icon name={copied ? "check" : "copy"} />
									{copied ? "Copied" : "Copy setup prompt"}
								</button>
							</div>
							<span className="lp-sr-only" role="status">
								{copied ? "Setup prompt copied. Paste it into your coding agent." : ""}
							</span>
						</div>
					</section>

					<section
						className="lp-emulators lp-section"
						id="emulators"
						aria-labelledby="emulators-title"
					>
						<div className="lp-section-heading">
							<div>
								<p className="lp-section-eyebrow">
									<span>03</span> Available emulators
								</p>
								<h2 id="emulators-title">Two official emulators. For now.</h2>
							</div>
							<p>
								Slack and Stripe are available today.
								<br />
								Need another service? <a href="#plugins">Build a plugin.</a>
							</p>
						</div>
						<div className="lp-service-grid">
							<article className="lp-service lp-service-slack">
								<div className="lp-service-top">
									<span className="lp-service-symbol" aria-hidden="true">
										#
									</span>
									<h3>Slack</h3>
									<span className="lp-service-number">01 / MESSAGING</span>
								</div>
								<h4>Test your Slack bot.</h4>
								<p>
									Create users and public channels, send messages, and receive signed events. See
									the conversation in a local dashboard.
								</p>
								<div className="lp-service-bottom">
									<code>@localhost2137/slack</code>
									<a href="/first-party/slack" className="lp-text-link">
										Explore Slack <Icon name="arrow-up-right" />
									</a>
								</div>
							</article>
							<article className="lp-service lp-service-stripe">
								<div className="lp-service-top">
									<span className="lp-service-symbol" aria-hidden="true">
										s
									</span>
									<h3>Stripe</h3>
									<span className="lp-service-number">02 / BILLING</span>
								</div>
								<h4>Test the next billing cycle.</h4>
								<p>
									Create subscriptions, advance time, and test successful or failed renewals—with
									invoices and signed webhooks.
								</p>
								<div className="lp-service-bottom">
									<code>@localhost2137/stripe</code>
									<a href="/first-party/stripe" className="lp-text-link">
										Explore Stripe <Icon name="arrow-up-right" />
									</a>
								</div>
							</article>
						</div>
						<p className="lp-coverage-note">
							Supports documented workflows.{" "}
							<a href="/compatibility">
								Check coverage <Icon name="arrow-right" />
							</a>
						</p>
					</section>

					<section className="lp-runtime lp-section" id="runtime" aria-labelledby="runtime-title">
						<div className="lp-runtime-overview">
							<div className="lp-runtime-copy">
								<p className="lp-section-eyebrow">
									<span>04</span> The runtime
								</p>
								<h2 id="runtime-title">An inside job.</h2>
								<p className="lp-section-lead">All services run on your machine.</p>
								<p>
									Configure plugins in <code>localhost.config.ts</code>. Control them through the
									CLI or TypeScript.
								</p>
								<a href="/docs" className="lp-text-link">
									Explore the runtime <Icon name="arrow-right" />
								</a>
							</div>
							<LandingRuntimeDiagram />
						</div>
						<section className="lp-testing" id="testing" aria-labelledby="testing-title">
							<div className="lp-testing-heading">
								<h3 id="testing-title">Built for automated tests, too.</h3>
								<p>
									Create test data, trigger failures, and give each test its own state and clock.
								</p>
							</div>
							<div className="lp-capabilities">
								<article>
									<span className="lp-capability-index">01 / CONTROL</span>
									<h4>Set up the data.</h4>
									<p>Create users, send messages, and choose payment outcomes.</p>
									<code className="lp-capability-code">
										instance.slack.createUser(&#123; name: "Ada" &#125;)
									</code>
									<a href="/operations-and-apis" className="lp-text-link">
										Control operations <Icon name="arrow-right" />
									</a>
								</article>
								<article>
									<span className="lp-capability-index">02 / TIME</span>
									<h4>Skip the wait.</h4>
									<p>Advance the emulator clock to test a renewal. Your app stays on real time.</p>
									<code className="lp-capability-code">await instance.clock.advance("30d")</code>
									<a href="/virtual-time" className="lp-text-link">
										Virtual time <Icon name="arrow-right" />
									</a>
								</article>
								<article>
									<span className="lp-capability-index">03 / ISOLATION</span>
									<h4>Break it. Reset it.</h4>
									<p>Give each test separate state and a clock. Reset or destroy it when done.</p>
									<code className="lp-capability-code">await instance.destroy()</code>
									<a href="/testing" className="lp-text-link">
										Isolated tests <Icon name="arrow-right" />
									</a>
								</article>
							</div>
						</section>
						<aside className="lp-mock-comparison" id="mock-servers" aria-labelledby="mock-title">
							<div>
								<h3 id="mock-title">Why not just use a mock server?</h3>
							</div>
							<div className="lp-mock-example">
								<p>
									The plugins <strong>mimic real service behavior out of the box</strong>: APIs,
									data, events, and even Slack’s UI.
								</p>
								<p>
									Mock servers can do this too. Here, the supported workflows are already
									implemented.
								</p>
							</div>
						</aside>
					</section>

					<section className="lp-plugins lp-section" id="plugins" aria-labelledby="plugins-title">
						<div>
							<p className="lp-section-eyebrow">
								<span>05</span> Bring your own service
							</p>
							<h2 id="plugins-title">Need another service?</h2>
							<p>
								Build an emulator with TypeScript, Hono, and Zod. Publish it as an npm package, or
								keep it private.
							</p>
							<div className="lp-plugin-links">
								<a href="/plugins/first-plugin" className="lp-button lp-button-secondary">
									Build your first emulator <Icon name="arrow-right" />
								</a>
								<a href="/plugins/authoring" className="lp-text-link">
									Plugin guide <Icon name="arrow-up-right" />
								</a>
							</div>
						</div>
						<div className="lp-package">
							<div className="lp-package-header">
								<Icon name="package" />
								<span>YOUR NEXT EMULATOR</span>
								<span>.tgz</span>
							</div>
							<div className="lp-package-name">
								<span>@you/</span>your-service
							</div>
							<ul>
								<li>
									<span>01</span> Service API <small>Routes & responses</small>
								</li>
								<li>
									<span>02</span> Stateful behavior <small>Data & events</small>
								</li>
								<li>
									<span>03</span> Control operations <small>CLI & TypeScript</small>
								</li>
								<li>
									<span>04</span> Compatibility tests <small>Prove the workflow</small>
								</li>
							</ul>
							<div className="lp-package-footer">
								<span>Public npm. Private repository.</span>
								<strong>Same runtime.</strong>
							</div>
						</div>
					</section>

					<section className="lp-faq lp-section" id="faq" aria-labelledby="faq-title">
						<div>
							<p className="lp-section-eyebrow">
								<span>06</span> FAQ
							</p>
							<h2 id="faq-title">Common questions.</h2>
						</div>
						<div className="lp-faq-list">
							<details name="landing-faq">
								<summary>Can I use my existing SDK?</summary>
								<p>
									Yes, for supported workflows. The <a href="/first-party/slack">Slack</a> and{" "}
									<a href="/first-party/stripe">Stripe</a> guides show the local configuration and
									adapters for their official SDKs.
								</p>
							</details>
							<details name="landing-faq">
								<summary>Do I need real API keys?</summary>
								<p>
									No. Use local placeholder credentials such as <code>xoxb-local</code>. You don’t
									need a provider account.
								</p>
							</details>
							<details name="landing-faq">
								<summary>Does it reproduce the entire service?</summary>
								<p>
									No. Each plugin supports specific workflows. Check the{" "}
									<a href="/compatibility">coverage</a>; test unsupported behavior against the real
									provider.
								</p>
							</details>
							<details name="landing-faq">
								<summary>Is this only for coding agents?</summary>
								<p>
									No. Developers, scripts, and CI can use the same APIs, CLI, and TypeScript
									operations.
								</p>
							</details>
						</div>
					</section>

					<section className="lp-final-cta lp-section" aria-labelledby="start-title">
						<p className="lp-section-eyebrow">Get started</p>
						<h2 id="start-title">
							Run it. Test it.
							<br />
							<span>Reset it. Repeat.</span>
						</h2>
						<p>Give your agent local services it can set up, inspect, and reset.</p>
						<div className="lp-install-command">
							<span aria-hidden="true">$</span>
							<code>{installCommand}</code>
							<button
								type="button"
								onClick={() => void copyInstall()}
								aria-label={
									installCopy === "copied" ? "Install command copied" : "Copy install command"
								}
								title="Copy install command"
							>
								<Icon name={installCopy === "copied" ? "check" : "copy"} />
							</button>
						</div>
						<p className="lp-install-status" role="status">
							{installCopy === "failed"
								? "Select and copy the command above. Clipboard access is unavailable."
								: installCopy === "copied"
									? "Copied. See the getting-started guide for the next steps."
									: "Requires Node.js 24+ and pnpm."}
						</p>
						<div className="lp-hero-actions">
							<a href="/getting-started" className="lp-button">
								Start locally <Icon name="arrow-right" />
							</a>
							<a href="/agents" className="lp-text-link">
								Read the agent guide <Icon name="arrow-up-right" />
							</a>
						</div>
					</section>
				</main>
				<footer className="lp-footer">
					<div className="lp-footer-main">
						<a href="/" className="lp-brand">
							localhost<span>2137</span>
						</a>
						<nav aria-label="Footer navigation">
							<a href="/docs">Docs</a>
							<a href="/first-party/slack">Slack</a>
							<a href="/first-party/stripe">Stripe</a>
							<a href="/plugins/first-plugin">Build a plugin</a>
							<a href={repository}>
								GitHub <Icon name="arrow-up-right" />
							</a>
						</nav>
					</div>
					<div className="lp-footer-bottom">
						<span>Local service emulators for development and testing.</span>
					</div>
				</footer>
			</div>
			<dialog className="lp-prompt-dialog" ref={dialog} aria-labelledby="prompt-title">
				<div className="lp-dialog-header">
					<h2 id="prompt-title">Give your agent the setup.</h2>
					<button
						type="button"
						aria-label="Close setup prompt"
						onClick={() => dialog.current?.close()}
					>
						<Icon name="close" />
					</button>
				</div>
				<p className="lp-dialog-description">
					Copy this prompt into your coding agent to run and verify the Slack example locally.
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
