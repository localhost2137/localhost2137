import { Hono } from "hono";

export function createRuntimeHttpApplication(
	input: Readonly<{
		control: Hono;
		publicGateway: Hono;
	}>,
): Hono {
	const app = new Hono();
	app.route("/_/v1", input.control);
	app.route("/", input.publicGateway);
	return app;
}
