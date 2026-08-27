import { ControlApiError, type RuntimeClient } from "localhost2137/client";

type InstanceOwnerClient = Pick<RuntimeClient, "createInstance" | "destroyInstance">;

type Outcome<Value> =
	| Readonly<{ ok: true; value: Value }>
	| Readonly<{ cause: unknown; ok: false }>;

/** Own one known worker instance ID across uncertain control responses. */
export async function withOwnedInstance<Value>(
	runtime: InstanceOwnerClient,
	instanceId: string,
	use: () => Promise<Value>,
): Promise<Value> {
	let primary: Outcome<Value>;
	try {
		await runtime.createInstance({ id: instanceId, persistence: "ephemeral" });
		primary = { ok: true, value: await use() };
	} catch (cause) {
		primary = { cause, ok: false };
	}

	const cleanup = await destroyIfPresent(runtime, instanceId);
	if (!primary.ok) {
		if (!cleanup.ok) {
			throw new AggregateError(
				[primary.cause, cleanup.cause],
				`Worker instance ${JSON.stringify(instanceId)} failed and cleanup also failed.`,
				{ cause: primary.cause },
			);
		}
		throw primary.cause;
	}
	if (!cleanup.ok) throw cleanup.cause;
	return primary.value;
}

async function destroyIfPresent(
	runtime: InstanceOwnerClient,
	instanceId: string,
): Promise<Outcome<void>> {
	try {
		await runtime.destroyInstance(instanceId);
		return { ok: true, value: undefined };
	} catch (cause) {
		if (cause instanceof ControlApiError && cause.code === "INSTANCE_NOT_FOUND") {
			return { ok: true, value: undefined };
		}
		return { cause, ok: false };
	}
}
