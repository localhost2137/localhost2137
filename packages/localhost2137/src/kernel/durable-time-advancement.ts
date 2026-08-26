import type { InstanceClock } from "./instance-clock.js";
import type { InstanceId } from "./identifiers.js";
import { StorageWriteCommittedError } from "./instance-storage.js";
import type { AnyServiceLifecycle } from "./service-lifecycle.js";
import type { InstanceManifest, PendingTimeAdvance } from "./manifests.js";
import { ownInstanceManifest } from "./manifests.js";

export type { InstanceClockAdvanceResult } from "../authoring/config.js";

export class PendingTimeAdvanceConflictError extends Error {
	readonly advanceId: string;

	constructor(advanceId: string) {
		super(`Time advance ${advanceId} is still pending with a different duration.`);
		this.name = "PendingTimeAdvanceConflictError";
		this.advanceId = advanceId;
	}
}

export class TimeAdvanceServiceMissingError extends Error {
	readonly advanceId: string;
	readonly serviceKey: string;

	constructor(advanceId: string, serviceKey: string) {
		super(
			`Time advance ${advanceId} cannot resume because unacknowledged service "${serviceKey}" is no longer configured; restore the prior config and restart.`,
		);
		this.name = "TimeAdvanceServiceMissingError";
		this.advanceId = advanceId;
		this.serviceKey = serviceKey;
	}
}

export class TimeAdvanceCommittedError extends AggregateError {
	declare readonly reconciliationPending: boolean;
	declare readonly result: InstanceClockAdvanceResult;

	constructor(
		result: InstanceClockAdvanceResult,
		causes: readonly unknown[],
		reconciliationPending: boolean,
	) {
		super(causes, `Clock advance ${result.advanceId} committed but did not finish cleanly.`);
		this.name = "TimeAdvanceCommittedError";
		const ownedResult = Object.freeze({ ...result });
		Object.defineProperties(this, {
			reconciliationPending: {
				configurable: false,
				enumerable: true,
				value: reconciliationPending,
				writable: false,
			},
			result: { configurable: false, enumerable: true, value: ownedResult, writable: false },
		});
	}
}

export interface TimeAdvanceManifestStore {
	writeInstance(instanceId: InstanceId, manifest: InstanceManifest): Promise<void>;
}

export class DurableTimeAdvancement {
	readonly #clock: InstanceClock;
	readonly #getManifest: () => InstanceManifest;
	readonly #instanceId: InstanceId;
	readonly #quiesce: (signal?: AbortSignal) => Promise<void>;
	readonly #services: readonly AnyServiceLifecycle[];
	readonly #setManifest: (manifest: InstanceManifest) => void;
	readonly #storage: TimeAdvanceManifestStore;
	readonly #token: () => string;

	constructor(input: {
		readonly clock: InstanceClock;
		readonly getManifest: () => InstanceManifest;
		readonly instanceId: InstanceId;
		readonly quiesce: (signal?: AbortSignal) => Promise<void>;
		readonly services: readonly AnyServiceLifecycle[];
		readonly setManifest: (manifest: InstanceManifest) => void;
		readonly storage: TimeAdvanceManifestStore;
		readonly token: () => string;
	}) {
		this.#clock = input.clock;
		this.#getManifest = input.getManifest;
		this.#instanceId = input.instanceId;
		this.#quiesce = input.quiesce;
		this.#services = input.services;
		this.#setManifest = input.setManifest;
		this.#storage = input.storage;
		this.#token = input.token;
	}

	async advance(durationMs: number, signal?: AbortSignal): Promise<InstanceClockAdvanceResult> {
		const pending = this.#getManifest().timeAdvance;
		if (pending) {
			if (pending.toMs - pending.fromMs !== durationMs) {
				throw new PendingTimeAdvanceConflictError(pending.id);
			}
			return this.#finishCommitted(pending, signal);
		}

		signal?.throwIfAborted();
		const preview = this.#clock.previewAdvance(durationMs);
		const created: PendingTimeAdvance = Object.freeze({
			acknowledgedServices: Object.freeze([]),
			fromMs: preview.fromMs,
			id: `advance_${this.#token()}`,
			services: Object.freeze(this.#services.map(({ serviceKey }) => serviceKey)),
			toMs: preview.toMs,
		});
		const next = ownInstanceManifest({
			...this.#getManifest(),
			clock: preview.state,
			timeAdvance: created,
		});
		const warnings: unknown[] = [];
		const initialWarning = await this.#write(next);
		if (initialWarning) warnings.push(initialWarning);
		this.#clock.replaceState(preview.state);
		return this.#finishCommitted(created, signal, warnings);
	}

	async recover(signal?: AbortSignal): Promise<void> {
		const pending = this.#getManifest().timeAdvance;
		if (pending) {
			const warnings = await this.#resume(pending, signal);
			if (warnings.length > 0) {
				throw this.#committedError(resultFor(pending, this.#getManifest().clock.mode), warnings);
			}
		}
	}

	async #finishCommitted(
		pending: PendingTimeAdvance,
		signal?: AbortSignal,
		initialWarnings: readonly unknown[] = [],
	): Promise<InstanceClockAdvanceResult> {
		const result = resultFor(pending, this.#getManifest().clock.mode);
		try {
			const warnings = [...initialWarnings, ...(await this.#resume(pending, signal))];
			if (warnings.length > 0) throw this.#committedError(result, warnings);
			return result;
		} catch (cause) {
			if (cause instanceof TimeAdvanceCommittedError) throw cause;
			throw this.#committedError(result, [cause]);
		}
	}

	async #resume(pending: PendingTimeAdvance, signal?: AbortSignal): Promise<readonly unknown[]> {
		const warnings: unknown[] = [];
		let acknowledged = pending.acknowledgedServices.length;
		while (acknowledged < pending.services.length) {
			signal?.throwIfAborted();
			const serviceKey = pending.services[acknowledged];
			if (!serviceKey) throw new TypeError("Pending time advance has an invalid service order.");
			const service = this.#services.find((candidate) => candidate.serviceKey === serviceKey);
			if (!service) throw new TimeAdvanceServiceMissingError(pending.id, serviceKey);
			await service.onTimeAdvanced(
				{
					advanceId: pending.id,
					from: new Date(pending.fromMs),
					to: new Date(pending.toMs),
				},
				signal,
			);
			await this.#quiesce(signal);
			acknowledged += 1;
			const current = this.#getManifest();
			const nextPending = current.timeAdvance;
			if (!nextPending || nextPending.id !== pending.id) {
				throw new TypeError("Pending time advance changed during reconciliation.");
			}
			const warning = await this.#write(
				ownInstanceManifest({
					...current,
					timeAdvance: {
						...nextPending,
						acknowledgedServices: nextPending.services.slice(0, acknowledged),
					},
				}),
			);
			if (warning) warnings.push(warning);
		}
		signal?.throwIfAborted();
		const current = this.#getManifest();
		if (current.timeAdvance?.id !== pending.id) return Object.freeze(warnings);
		const { timeAdvance: _completed, ...completed } = current;
		const warning = await this.#write(ownInstanceManifest(completed));
		if (warning) warnings.push(warning);
		return Object.freeze(warnings);
	}

	#committedError(
		result: InstanceClockAdvanceResult,
		causes: readonly unknown[],
	): TimeAdvanceCommittedError {
		return new TimeAdvanceCommittedError(
			result,
			causes,
			this.#getManifest().timeAdvance?.id === result.advanceId,
		);
	}

	async #write(manifest: InstanceManifest): Promise<StorageWriteCommittedError | undefined> {
		let warning: StorageWriteCommittedError | undefined;
		try {
			await this.#storage.writeInstance(this.#instanceId, manifest);
		} catch (cause) {
			if (!(cause instanceof StorageWriteCommittedError) || cause.operation !== "write_instance") {
				throw cause;
			}
			warning = cause;
		}
		this.#setManifest(manifest);
		return warning;
	}
}

function resultFor(
	advance: PendingTimeAdvance,
	mode: "pinned" | "real",
): InstanceClockAdvanceResult {
	return Object.freeze({
		advanceId: advance.id,
		from: new Date(advance.fromMs).toISOString(),
		mode,
		to: new Date(advance.toMs).toISOString(),
	});
}
import type { InstanceClockAdvanceResult } from "../authoring/config.js";
