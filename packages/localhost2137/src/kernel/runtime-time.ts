import type { WallClock } from "./instance-clock.js";

export interface RuntimeTime extends WallClock {
	nowTimestamp(): string;
}
