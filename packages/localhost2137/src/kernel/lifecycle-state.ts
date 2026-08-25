export type ServiceLifecycleStatus =
	| "absent"
	| "creating"
	| "running"
	| "seeding"
	| "starting"
	| "stopped"
	| "stopping"
	| "stop_failed"
	| "updating";

export type InstanceLifecycleStatus =
	| "destroying"
	| "failed"
	| "resetting"
	| "running"
	| "seed_failed"
	| "seeding"
	| "starting"
	| "stopped"
	| "stopping";

export class InvalidLifecycleTransitionError extends Error {
	readonly action: string;
	readonly owner: "instance" | "service";
	readonly status: string;

	constructor(owner: "instance" | "service", status: string, action: string) {
		super(`Cannot ${action} ${owner} while it is ${status}.`);
		this.name = "InvalidLifecycleTransitionError";
		this.action = action;
		this.owner = owner;
		this.status = status;
	}
}

type ServiceState<State> =
	| Readonly<{ status: Exclude<ServiceLifecycleStatus, "running" | "seeding" | "stopping"> }>
	| Readonly<{ state: State; status: "running" | "seeding" | "stopping" }>;

export class ServiceLifecycleStateOwner<State> {
	#current: ServiceState<State> = Object.freeze({ status: "absent" });

	status(): ServiceLifecycleStatus {
		return this.#current.status;
	}

	beginCreate(): void {
		this.#expect("absent", "create");
		this.#current = Object.freeze({ status: "creating" });
	}

	createSucceeded(): void {
		this.#expect("creating", "complete create");
		this.#current = Object.freeze({ status: "stopped" });
	}

	createFailed(): void {
		this.#expect("creating", "fail create");
		this.#current = Object.freeze({ status: "absent" });
	}

	restoreStopped(): void {
		this.#expect("absent", "restore persisted service");
		this.#current = Object.freeze({ status: "stopped" });
	}

	beginUpdate(): void {
		this.#expect("stopped", "update");
		this.#current = Object.freeze({ status: "updating" });
	}

	updateFinished(): void {
		this.#expect("updating", "finish update");
		this.#current = Object.freeze({ status: "stopped" });
	}

	beginStart(): void {
		this.#expect("stopped", "start");
		this.#current = Object.freeze({ status: "starting" });
	}

	startSucceeded(state: State): void {
		this.#expect("starting", "complete start");
		this.#current = Object.freeze({ state, status: "running" });
	}

	startFailed(): void {
		this.#expect("starting", "fail start");
		this.#current = Object.freeze({ status: "stopped" });
	}

	beginSeed(): State {
		const state = this.#runningState("seed");
		this.#current = Object.freeze({ state, status: "seeding" });
		return state;
	}

	seedFinished(): void {
		if (this.#current.status !== "seeding") this.#invalid("finish seed");
		this.#current = Object.freeze({ state: this.#current.state, status: "running" });
	}

	beginStop(): State {
		const state = this.#runningState("stop");
		this.#current = Object.freeze({ state, status: "stopping" });
		return state;
	}

	stopFinished(succeeded: boolean): void {
		this.#expect("stopping", "finish stop");
		this.#current = Object.freeze({ status: succeeded ? "stopped" : "stop_failed" });
	}

	runningState(): State {
		return this.#runningState("access running state");
	}

	#runningState(action: string): State {
		if (this.#current.status !== "running") this.#invalid(action);
		return this.#current.state;
	}

	#expect(status: ServiceLifecycleStatus, action: string): void {
		if (this.#current.status !== status) this.#invalid(action);
	}

	#invalid(action: string): never {
		throw new InvalidLifecycleTransitionError("service", this.#current.status, action);
	}
}

export class InstanceLifecycleStateOwner {
	#status: InstanceLifecycleStatus = "stopped";

	constructor(initialStatus: "running" | "seed_failed" | "stopped" = "stopped") {
		this.#status = initialStatus;
	}

	status(): InstanceLifecycleStatus {
		return this.#status;
	}

	beginStart(): void {
		this.#transition(["stopped"], "starting", "start");
	}

	startFinished(succeeded: boolean, cleanupSucceeded = true): void {
		this.#transition(
			["starting"],
			succeeded ? "running" : cleanupSucceeded ? "stopped" : "failed",
			"finish start",
		);
	}

	beginSeed(): void {
		this.#transition(["running"], "seeding", "seed");
	}

	seedFinished(succeeded: boolean): void {
		this.#transition(["seeding"], succeeded ? "running" : "seed_failed", "finish seed");
	}

	seedCancelled(): void {
		this.#transition(["seeding"], "running", "cancel seed");
	}

	beginStop(): void {
		this.#transition(["running", "seed_failed"], "stopping", "stop");
	}

	stopFinished(succeeded: boolean): void {
		this.#transition(["stopping"], succeeded ? "stopped" : "failed", "finish stop");
	}

	beginReset(): "running" | "seed_failed" | "stopped" {
		const previous = this.#status;
		if (previous !== "running" && previous !== "seed_failed" && previous !== "stopped") {
			this.#invalid("reset");
		}
		this.#status = "resetting";
		return previous;
	}

	restoreAfterResetFailure(previous: "running" | "seed_failed" | "stopped"): void {
		this.#transition(["resetting"], previous, "restore failed reset");
	}

	beginDestroy(): void {
		this.#transition(["stopped"], "destroying", "destroy");
	}

	#transition(
		allowed: readonly InstanceLifecycleStatus[],
		next: InstanceLifecycleStatus,
		action: string,
	): void {
		if (!allowed.includes(this.#status)) this.#invalid(action);
		this.#status = next;
	}

	#invalid(action: string): never {
		throw new InvalidLifecycleTransitionError("instance", this.#status, action);
	}
}
