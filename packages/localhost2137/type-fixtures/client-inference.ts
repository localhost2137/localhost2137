import { type ControlJsonValue, connectRuntime, type RuntimeClient } from "localhost2137/client";

const client: RuntimeClient = connectRuntime({
	token: "local-control-token",
	url: "http://127.0.0.1:2137",
});

const result: Promise<ControlJsonValue> = client.executeOperation("dev", "slack", "createUser", {
	name: "Alice",
});
void result;

// @ts-expect-error the remote client is intentionally introspection-driven, not service-shaped
client.slack.createUser({ name: "Alice" });

// @ts-expect-error transport injection is an internal testing seam
connectRuntime({ fetch, token: "local-control-token", url: "http://127.0.0.1:2137" });
