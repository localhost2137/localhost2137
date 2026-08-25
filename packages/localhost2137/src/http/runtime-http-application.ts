import { type Env, Hono } from "hono";

export function createRuntimeHttpApplication<ControlEnv extends Env, PublicEnv extends Env>(
	input: Readonly<{
		control: Hono<ControlEnv>;
		publicGateway: Hono<PublicEnv>;
	}>,
): Hono {
	const app = new Hono();
	app.route("/_/v1", input.control);
	app.route("/", input.publicGateway);
	return app;
}
