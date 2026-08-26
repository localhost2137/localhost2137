const MICROSECONDS_PER_SECOND = 1_000_000n;

export const MAX_SLACK_TIMESTAMP_MICROSECONDS = 9_223_372_036_854_775_807n;

export function parseSlackTimestamp(value: string): bigint | undefined {
	if (!/^\d+\.\d{1,6}$/.test(value)) return undefined;
	const [seconds, fraction] = value.split(".") as [string, string];
	const microseconds = BigInt(seconds) * MICROSECONDS_PER_SECOND + BigInt(fraction.padEnd(6, "0"));
	return microseconds <= MAX_SLACK_TIMESTAMP_MICROSECONDS ? microseconds : undefined;
}

export function formatSlackTimestamp(microseconds: bigint): string {
	if (microseconds < 0n || microseconds > MAX_SLACK_TIMESTAMP_MICROSECONDS) {
		throw new RangeError("Slack message timestamp sequence is exhausted.");
	}
	const seconds = microseconds / MICROSECONDS_PER_SECOND;
	const fraction = microseconds % MICROSECONDS_PER_SECOND;
	return `${seconds}.${String(fraction).padStart(6, "0")}`;
}

export function dateToSlackMicroseconds(value: Date): bigint {
	const milliseconds = value.getTime();
	if (!Number.isSafeInteger(milliseconds)) {
		throw new RangeError("Slack message timestamp requires a valid Date.");
	}
	return BigInt(milliseconds) * 1_000n;
}
