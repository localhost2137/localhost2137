import { useId, useState } from "react";
import "./landing-runtime.css";

const exampleInstances = {
	dev: {
		users: 3,
		channels: 2,
		customers: 2,
		subscriptions: 1,
		date: "2026-01-01",
	},
	"test-01": {
		users: 1,
		channels: 1,
		customers: 1,
		subscriptions: 0,
		date: "2026-01-31",
	},
} as const;

type ExampleInstance = keyof typeof exampleInstances;

export function LandingRuntimeDiagram() {
	const [selected, setSelected] = useState<ExampleInstance>("dev");
	const descriptionId = useId();
	const stateId = useId();
	const instance = exampleInstances[selected];

	return (
		<figure className="lr-diagram" aria-describedby={descriptionId}>
			<div className="lr-sources">
				<div className="lr-source">
					<span>Your app</span>
					<small>SDK / HTTP</small>
					<span className="lr-inlet" aria-hidden="true" />
				</div>
				<div className="lr-source">
					<span>Tests + agents</span>
					<small>CLI / TypeScript</small>
					<span className="lr-inlet" aria-hidden="true" />
				</div>
			</div>

			<div className="lr-boundary">
				<div className="lr-host">
					<span className="lr-host-address">
						<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<rect x="1.5" y="2.5" width="13" height="9" rx="1" />
							<path d="M5 14h6M8 11.5V14M4.5 5l2 2-2 2M8 9h3" />
						</svg>
						localhost:2137
					</span>
					<span className="lr-host-note">on your machine</span>
				</div>

				<div className="lr-entry-points">
					<span>Service APIs</span>
					<span>Control operations</span>
				</div>
				<svg className="lr-convergence" viewBox="0 0 440 32" fill="none" aria-hidden="true">
					<path d="M110 0v10h110M330 0v10H220v17" />
					<path d="m216 23 4 4 4-4" />
				</svg>

				<div className="lr-instance">
					<div className="lr-instance-header">
						<span className="lr-label">Instance</span>
						<fieldset className="lr-instance-selector" aria-label="Illustrative instance">
							{(Object.keys(exampleInstances) as ExampleInstance[]).map((id) => (
								<button
									key={id}
									type="button"
									aria-pressed={selected === id}
									aria-controls={stateId}
									onClick={() => setSelected(id)}
								>
									{id}
								</button>
							))}
						</fieldset>
					</div>

					<div id={stateId} className="lr-world-state" aria-live="polite" aria-atomic="true">
						<div className="lr-service">
							<div className="lr-service-name">
								<strong>Slack</strong>
								<code>/{selected}/slack/api/</code>
							</div>
							<div className="lr-records">
								<span>
									<b>{instance.users}</b> {instance.users === 1 ? "user" : "users"}
								</span>
								<span>
									<b>{instance.channels}</b> {instance.channels === 1 ? "channel" : "channels"}
								</span>
							</div>
						</div>
						<div className="lr-service">
							<div className="lr-service-name">
								<strong>Stripe</strong>
								<code>/{selected}/stripe/v1/</code>
							</div>
							<div className="lr-records">
								<span>
									<b>{instance.customers}</b> {instance.customers === 1 ? "customer" : "customers"}
								</span>
								<span>
									<b>{instance.subscriptions}</b>{" "}
									{instance.subscriptions === 1 ? "subscription" : "subscriptions"}
								</span>
							</div>
						</div>
						<div className="lr-clock">
							<span className="lr-clock-label">
								<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
									<circle cx="8" cy="8" r="5.5" />
									<path d="M8 4.5V8l2 1.5" />
								</svg>
								Pinned clock
							</span>
							<time dateTime={`${instance.date}T09:00:00Z`}>
								{instance.date}
								<span>09:00:00 UTC</span>
							</time>
						</div>
					</div>
				</div>
			</div>

			<figcaption id={descriptionId}>
				Illustrative instances. Separate state and clocks, shared runtime.
			</figcaption>
		</figure>
	);
}
