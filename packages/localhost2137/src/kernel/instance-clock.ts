import type { InstanceClockStatus } from "../authoring/config.js";
import type { PluginClock } from "../authoring/context.js";
import type { InstanceClockState } from "./manifests.js";

export interface WallClock {
	nowMilliseconds(): number;
}

export function initialClockState(
	config: Readonly<{ mode: "real" }> | Readonly<{ mode: "pinned"; startAt: string }>,
): InstanceClockState {
	if (config.mode === "real") return Object.freeze({ mode: "real", offsetMs: 0 });
	const instantMs = Date.parse(config.startAt);
	if (!Number.isFinite(instantMs)) {
		throw new TypeError(`Pinned clock startAt is not a valid instant: ${config.startAt}`);
	}
	return Object.freeze({ instantMs, mode: "pinned" });
}

export class ReadonlyInstanceClock implements PluginClock {
	readonly #state: InstanceClockState;
	readonly #wallClock: WallClock;

	constructor(state: InstanceClockState, wallClock: WallClock) {
		this.#state = Object.freeze({ ...state });
		this.#wallClock = wallClock;
	}

	now(): Date {
		const milliseconds =
			this.#state.mode === "pinned"
				? this.#state.instantMs
				: this.#wallClock.nowMilliseconds() + this.#state.offsetMs;
		return new Date(milliseconds);
	}

	async status(): Promise<InstanceClockStatus> {
		return Object.freeze({ mode: this.#state.mode, now: this.now().toISOString() });
	}
}
