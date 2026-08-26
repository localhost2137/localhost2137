const MILLISECONDS_BY_UNIT = Object.freeze({
	d: 86_400_000n,
	h: 3_600_000n,
	m: 60_000n,
	ms: 1n,
	s: 1_000n,
	w: 604_800_000n,
});

export class InvalidClockDurationError extends TypeError {
	readonly duration: unknown;

	constructor(duration: unknown, message: string) {
		super(message);
		this.name = "InvalidClockDurationError";
		this.duration = duration;
	}
}

export function parseClockDuration(duration: unknown): number {
	if (typeof duration !== "string") {
		throw new InvalidClockDurationError(
			duration,
			"Clock duration must be a string such as 500ms, 30s, 2h, or 30d.",
		);
	}
	const match = /^(0|[1-9]\d*)(ms|s|m|h|d|w)$/.exec(duration);
	if (!match) {
		throw new InvalidClockDurationError(
			duration,
			"Clock duration must be a whole number followed by ms, s, m, h, d, or w.",
		);
	}
	const quantity = BigInt(match[1] ?? "0");
	if (quantity === 0n) {
		throw new InvalidClockDurationError(duration, "Clock duration must move time forward.");
	}
	const unit = match[2] as keyof typeof MILLISECONDS_BY_UNIT;
	const milliseconds = quantity * MILLISECONDS_BY_UNIT[unit];
	if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new InvalidClockDurationError(duration, "Clock duration is too large.");
	}
	return Number(milliseconds);
}
