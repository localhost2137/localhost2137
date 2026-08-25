import type { InstanceClockStatus } from "../authoring/config.js";
import type { PluginClock } from "../authoring/context.js";
import type { InstanceClockState } from "./manifests.js";

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export interface WallClock {
	nowMilliseconds(): number;
}

export function initialClockState(
	config: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>,
): InstanceClockState {
	if (config.mode === "real") return Object.freeze({ mode: "real", offsetMs: 0 });
	const instantMs = Date.parse(config.startAt);
	if (!isDateMilliseconds(instantMs)) {
		throw new TypeError(`Pinned clock startAt is not a valid instant: ${config.startAt}`);
	}
	return Object.freeze({ instantMs, mode: "pinned" });
}

export class ReadonlyInstanceClock implements PluginClock {
	readonly #state: InstanceClockState;
	readonly #wallClock: WallClock;

	constructor(state: InstanceClockState, wallClock: WallClock) {
		if (state.mode === "pinned") {
			assertDateMilliseconds(state.instantMs, "Pinned clock instantMs");
		} else {
			assertDateMilliseconds(state.offsetMs, "Real clock offsetMs");
		}
		this.#state = Object.freeze({ ...state });
		this.#wallClock = wallClock;
	}

	now(): Date {
		if (this.#state.mode === "pinned") return new Date(this.#state.instantMs);
		const wallMilliseconds = this.#wallClock.nowMilliseconds();
		assertDateMilliseconds(wallMilliseconds, "Wall clock milliseconds");
		const milliseconds = wallMilliseconds + this.#state.offsetMs;
		assertDateMilliseconds(milliseconds, "Real clock wall time plus offset");
		return new Date(milliseconds);
	}

	async status(): Promise<InstanceClockStatus> {
		return Object.freeze({ mode: this.#state.mode, now: this.now().toISOString() });
	}
}

function assertDateMilliseconds(value: number, label: string): void {
	if (!isDateMilliseconds(value)) {
		throw new RangeError(`${label} must be a safe integer within the JavaScript Date domain.`);
	}
}

function isDateMilliseconds(value: number): boolean {
	return (
		Number.isSafeInteger(value) && value >= -MAX_DATE_MILLISECONDS && value <= MAX_DATE_MILLISECONDS
	);
}
