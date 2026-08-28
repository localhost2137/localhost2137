import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SlackDashboard } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Slack dashboard root element is missing.");

createRoot(root).render(
	<StrictMode>
		<SlackDashboard />
	</StrictMode>,
);
