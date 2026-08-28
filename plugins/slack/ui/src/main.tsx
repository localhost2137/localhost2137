import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { useSlackWorkspace } from "./use-workspace.js";

function DashboardScaffold() {
	const workspace = useSlackWorkspace(null);
	return (
		<main className="grid min-h-screen place-items-center bg-[#3f0e40] p-8 text-white">
			<div className="max-w-md">
				<p className="text-sm font-bold uppercase tracking-[0.16em] text-white/60">localhost2137</p>
				<h1 className="mt-3 text-4xl font-bold tracking-tight">
					{workspace.snapshot?.workspace.name ?? "Opening your local workspace…"}
				</h1>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Slack dashboard root element is missing.");

createRoot(root).render(
	<StrictMode>
		<DashboardScaffold />
	</StrictMode>,
);
