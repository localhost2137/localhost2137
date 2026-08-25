export class RuntimeAdmissionClosedError extends Error {
	constructor() {
		super("The instance runtime is closing or already closed.");
		this.name = "RuntimeAdmissionClosedError";
	}
}

export interface RuntimeAdmissionLease {
	release(): void;
	readonly signal: AbortSignal;
}

export class RuntimeAdmission {
	readonly #controller = new AbortController();
	readonly #waiters = new Set<() => void>();
	#active = 0;
	#closing = false;
	#closePromise: Promise<void> | undefined;

	admit(): RuntimeAdmissionLease {
		if (this.#closing) throw new RuntimeAdmissionClosedError();
		this.#active += 1;
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.#active -= 1;
				if (this.#active === 0) {
					for (const waiter of [...this.#waiters]) waiter();
				}
			},
			signal: this.#controller.signal,
		});
	}

	assertOpen(): void {
		if (this.#closing) throw new RuntimeAdmissionClosedError();
	}

	activeCount(): number {
		return this.#active;
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = this.#active === 0 ? Promise.resolve() : this.#waitForEmpty();
		return this.#closePromise;
	}

	abort(reason: unknown): void {
		this.#controller.abort(reason);
	}

	#waitForEmpty(): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				if (this.#active !== 0) return;
				this.#waiters.delete(done);
				resolve();
			};
			this.#waiters.add(done);
			done();
		});
	}
}
