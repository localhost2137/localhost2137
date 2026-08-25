import type { DevDaemon } from "../node/dev-daemon.js";

/** Renders only public endpoints and environment names; connection values stay private. */
export function renderDevReady(daemon: DevDaemon): string {
	const serviceLines = Object.keys(daemon.config.services).map(
		(serviceKey) => `  ${serviceKey}: ${daemon.address.url}/dev/${serviceKey}`,
	);
	const environmentNames = Object.keys(daemon.connections.env).sort(codeUnitOrder);
	return [
		"localhost2137 ready",
		`runtime: ${daemon.address.url}`,
		"instance: dev",
		...(serviceLines.length === 0 ? ["services: none"] : ["services:", ...serviceLines]),
		`environment: ${daemon.environmentPath}`,
		`variables: ${environmentNames.length === 0 ? "none" : environmentNames.join(", ")}`,
		"",
	].join("\n");
}

function codeUnitOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
