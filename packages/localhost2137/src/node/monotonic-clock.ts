import type { MonotonicClock } from "../kernel/instance-leases.js";

export const nodeMonotonicClock: MonotonicClock = Object.freeze({
	nowMilliseconds: () => Number(process.hrtime.bigint()) / 1_000_000,
});
