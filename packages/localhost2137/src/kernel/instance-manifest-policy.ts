import type { InstanceId } from "./identifiers.js";
import { initialClockState } from "./instance-clock.js";
import type { InstanceTemplate } from "./instance-template.js";
import {
	type InstanceManifest,
	ownInstanceManifest,
	ownTransitionManifest,
	type StorageTransitionManifest,
} from "./manifests.js";
import type { RuntimeTime } from "./runtime-time.js";

export class InstanceManifestPolicy {
	readonly #template: InstanceTemplate;
	readonly #time: RuntimeTime;
	readonly #token: () => string;

	constructor(template: InstanceTemplate, time: RuntimeTime, token: () => string) {
		this.#template = template;
		this.#time = time;
		this.#token = token;
	}

	create(
		instanceId: InstanceId,
		persistence: "ephemeral" | "persistent",
		transitionId?: string,
	): InstanceManifest {
		return ownInstanceManifest({
			clock: initialClockState(this.#template.clock),
			configuredServices: this.#configuredServices(),
			configFingerprint: this.#template.fingerprint,
			createdAt: this.#time.nowTimestamp(),
			id: instanceId.value,
			persistence,
			schemaVersion: 1,
			seed: { attempt: 0, status: "unseeded" },
			status: "creating",
			...(transitionId ? { transition: { id: transitionId, kind: "reset" } } : {}),
		});
	}

	markReady(manifest: InstanceManifest): InstanceManifest {
		return ownInstanceManifest({ ...manifest, status: "ready" });
	}

	clearTransition(manifest: InstanceManifest): InstanceManifest {
		const { transition: _transition, ...ready } = manifest;
		return ownInstanceManifest(ready);
	}

	refreshConfiguration(manifest: InstanceManifest): InstanceManifest {
		return ownInstanceManifest({
			...manifest,
			configFingerprint: this.#template.fingerprint,
			configuredServices: this.#configuredServices(),
		});
	}

	repairInterruptedSeed(manifest: InstanceManifest): InstanceManifest {
		if (manifest.seed.status !== "seeding") return manifest;
		return ownInstanceManifest({
			...manifest,
			seed: {
				attempt: manifest.seed.attempt,
				failure: {
					at: this.#time.nowTimestamp(),
					message: "Runtime stopped while seeding; reset is required.",
				},
				status: "seed_failed",
			},
		});
	}

	transition(instanceId: InstanceId, kind: "destroy" | "reset"): StorageTransitionManifest {
		return ownTransitionManifest({
			createdAt: this.#time.nowTimestamp(),
			instanceId: instanceId.value,
			kind,
			phase: "old_staged",
			schemaVersion: 1,
			transitionId: `${kind}_${this.#token()}`,
		});
	}

	creationTrashId(instanceId: InstanceId): string {
		return `create_${instanceId.value}_${this.#token()}`;
	}

	#configuredServices(): readonly string[] {
		return Object.freeze(this.#template.services.map(({ serviceKey }) => serviceKey));
	}
}
