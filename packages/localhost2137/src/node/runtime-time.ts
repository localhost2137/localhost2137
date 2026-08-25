import type { RuntimeTime } from "../kernel/runtime-time.js";

export class NodeRuntimeTime implements RuntimeTime {
	nowMilliseconds(): number {
		return Date.now();
	}

	nowTimestamp(): string {
		return new Date(this.nowMilliseconds()).toISOString();
	}
}
