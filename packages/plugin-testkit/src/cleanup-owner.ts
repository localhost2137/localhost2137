export type Captured<Value> =
	| Readonly<{ status: "fulfilled"; value: Value }>
	| Readonly<{ reason: unknown; status: "rejected" }>;

export async function capture<Value>(work: () => Promise<Value>): Promise<Captured<Value>> {
	try {
		return Object.freeze({ status: "fulfilled", value: await work() });
	} catch (reason) {
		return Object.freeze({ reason, status: "rejected" });
	}
}

export function finishCaptured<Value>(
	outcome: Captured<Value>,
	cleanupFailures: readonly unknown[],
	label: string,
): Value {
	if (outcome.status === "rejected" && cleanupFailures.length > 0) {
		throw new AggregateError([outcome.reason, ...cleanupFailures], `${label} and cleanup failed.`);
	}
	if (outcome.status === "rejected") throw outcome.reason;
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, `${label} cleanup failed.`);
	}
	return outcome.value;
}
