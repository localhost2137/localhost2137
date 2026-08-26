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

export class InstanceClock implements PluginClock {
	#state: InstanceClockState;
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

	previewAdvance(durationMs: number): Readonly<{
		fromMs: number;
		state: InstanceClockState;
		toMs: number;
	}> {
		assertPositiveDuration(durationMs);
		if (this.#state.mode === "pinned") {
			const toMs = checkedDateAddition(this.#state.instantMs, durationMs, "Pinned clock advance");
			return Object.freeze({
				fromMs: this.#state.instantMs,
				state: Object.freeze({ instantMs: toMs, mode: "pinned" }),
				toMs,
			});
		}
		const wallMs = this.#wallClock.nowMilliseconds();
		assertDateMilliseconds(wallMs, "Wall clock milliseconds");
		const fromMs = checkedDateAddition(
			wallMs,
			this.#state.offsetMs,
			"Real clock wall time plus offset",
		);
		const toMs = checkedDateAddition(fromMs, durationMs, "Real clock advance");
		const offsetMs = checkedDateAddition(
			this.#state.offsetMs,
			durationMs,
			"Real clock offset advance",
		);
		return Object.freeze({
			fromMs,
			state: Object.freeze({ mode: "real", offsetMs }),
			toMs,
		});
	}

	replaceState(state: InstanceClockState): void {
		if (state.mode === "pinned") assertDateMilliseconds(state.instantMs, "Pinned clock instantMs");
		else assertDateMilliseconds(state.offsetMs, "Real clock offsetMs");
		this.#state = Object.freeze({ ...state });
	}
}

/** @deprecated Internal compatibility name; plugins receive only PluginClock. */
export { InstanceClock as ReadonlyInstanceClock };

function checkedDateAddition(left: number, right: number, label: string): number {
	const value = BigInt(left) + BigInt(right);
	if (value < BigInt(-MAX_DATE_MILLISECONDS) || value > BigInt(MAX_DATE_MILLISECONDS)) {
		throw new RangeError(`${label} must remain within the JavaScript Date domain.`);
	}
	const result = Number(value);
	assertDateMilliseconds(result, label);
	return result;
}

function assertPositiveDuration(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError("Clock advance duration must be a positive safe integer of milliseconds.");
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
