import { z } from "zod";

const INSTANCE_MANIFEST_SCHEMA_VERSION = 2;
const QUARANTINE_MANIFEST_SCHEMA_VERSION = 1;
const SERVICE_MANIFEST_SCHEMA_VERSION = 1;
const TRANSITION_MANIFEST_SCHEMA_VERSION = 1;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export type InstanceClockState =
	| Readonly<{ mode: "real"; offsetMs: number }>
	| Readonly<{ instantMs: number; mode: "pinned" }>;

export type InstanceSeedState =
	| Readonly<{ attempt: number; status: "unseeded" }>
	| Readonly<{ attempt: number; status: "seeding" | "seeded" }>
	| Readonly<{
			attempt: number;
			failure: Readonly<{ at: string; correlationId?: string | undefined; message: string }>;
			status: "seed_failed";
	  }>;

export interface PendingTimeAdvance {
	readonly acknowledgedServices: readonly string[];
	readonly fromMs: number;
	readonly id: string;
	readonly services: readonly string[];
	readonly toMs: number;
}

export interface InstanceManifest {
	readonly clock: InstanceClockState;
	readonly configuredServices: readonly string[];
	readonly configFingerprint: string;
	readonly createdAt: string;
	readonly id: string;
	readonly persistence: "ephemeral" | "persistent";
	readonly schemaVersion: 2;
	readonly seed: InstanceSeedState;
	readonly status: "creating" | "ready";
	readonly timeAdvance?: PendingTimeAdvance | undefined;
	readonly transition?: Readonly<{ id: string; kind: "reset" }> | undefined;
}

export interface ServiceManifest {
	readonly createdAt: string;
	readonly pluginId: string;
	readonly schemaVersion: 1;
	readonly serviceKey: string;
	readonly stateVersion: number;
	readonly updatedAt: string;
}

export interface StorageTransitionManifest {
	readonly createdAt: string;
	readonly instanceId: string;
	readonly kind: "destroy" | "reset";
	readonly phase: "committed" | "old_staged";
	readonly schemaVersion: 1;
	readonly transitionId: string;
}

export type InstanceQuarantineReason =
	| "ephemeral_recovery"
	| "failed_creation"
	| "incomplete_recovery";

export interface InstanceQuarantineManifest {
	readonly createdAt: string;
	readonly instanceId: string;
	readonly reason: InstanceQuarantineReason;
	readonly schemaVersion: 1;
	readonly trashId: string;
}

const identifierSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const timestampSchema = z.iso
	.datetime({ offset: true })
	.refine((value) => Number.isFinite(Date.parse(value)), "Timestamp is outside the Date domain.");
const transitionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/);
const dateMillisecondsSchema = z.int().min(-MAX_DATE_MILLISECONDS).max(MAX_DATE_MILLISECONDS);

const clockStateSchema: z.ZodType<InstanceClockState> = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("real"), offsetMs: dateMillisecondsSchema }),
	z.strictObject({ mode: z.literal("pinned"), instantMs: dateMillisecondsSchema }),
]);

const seedFailureSchema = z.strictObject({
	at: timestampSchema,
	correlationId: z.string().min(1).optional(),
	message: z.string().min(1),
});

const seedStateSchema: z.ZodType<InstanceSeedState> = z.discriminatedUnion("status", [
	z.strictObject({ attempt: z.int().nonnegative(), status: z.literal("unseeded") }),
	z.strictObject({ attempt: z.int().positive(), status: z.literal("seeding") }),
	z.strictObject({ attempt: z.int().positive(), status: z.literal("seeded") }),
	z.strictObject({
		attempt: z.int().positive(),
		failure: seedFailureSchema,
		status: z.literal("seed_failed"),
	}),
]);

const instanceTransitionSchema = z.strictObject({
	id: transitionIdSchema,
	kind: z.literal("reset"),
});

const pendingTimeAdvanceSchema: z.ZodType<PendingTimeAdvance> = z
	.strictObject({
		acknowledgedServices: z.array(identifierSchema),
		fromMs: dateMillisecondsSchema,
		id: transitionIdSchema,
		services: z.array(identifierSchema),
		toMs: dateMillisecondsSchema,
	})
	.superRefine((advance, context) => {
		if (advance.toMs <= advance.fromMs) {
			context.addIssue({
				code: "custom",
				message: "A pending time advance must move time forward.",
				path: ["toMs"],
			});
		}
		const uniqueServices = new Set(advance.services);
		if (uniqueServices.size !== advance.services.length) {
			context.addIssue({
				code: "custom",
				message: "A pending time advance cannot contain duplicate services.",
				path: ["services"],
			});
		}
		if (advance.acknowledgedServices.length > advance.services.length) {
			context.addIssue({
				code: "custom",
				message: "Time-advance acknowledgements cannot exceed the service order.",
				path: ["acknowledgedServices"],
			});
		}
		if (
			advance.acknowledgedServices.some((service, index) => advance.services[index] !== service)
		) {
			context.addIssue({
				code: "custom",
				message: "Time-advance acknowledgements must be a prefix of the service order.",
				path: ["acknowledgedServices"],
			});
		}
	});

const currentInstanceManifestSchema: z.ZodType<InstanceManifest> = z
	.strictObject({
		clock: clockStateSchema,
		configuredServices: z.array(identifierSchema).superRefine((services, context) => {
			const seen = new Set<string>();
			for (const [index, service] of services.entries()) {
				if (seen.has(service)) {
					context.addIssue({
						code: "custom",
						message: `Configured service "${service}" appears more than once.`,
						path: [index],
					});
				}
				seen.add(service);
			}
		}),
		configFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		createdAt: timestampSchema,
		id: identifierSchema,
		persistence: z.enum(["persistent", "ephemeral"]),
		schemaVersion: z.literal(INSTANCE_MANIFEST_SCHEMA_VERSION),
		seed: seedStateSchema,
		status: z.enum(["creating", "ready"]),
		timeAdvance: pendingTimeAdvanceSchema.optional(),
		transition: instanceTransitionSchema.optional(),
	})
	.superRefine((manifest, context) => {
		const advance = manifest.timeAdvance;
		if (!advance) return;
		const delta = advance.toMs - advance.fromMs;
		if (!Number.isSafeInteger(delta) || delta <= 0) {
			context.addIssue({
				code: "custom",
				message: "A pending time advance delta must be a positive safe integer.",
				path: ["timeAdvance", "toMs"],
			});
		}
		if (
			advance.services.length !== manifest.configuredServices.length ||
			advance.services.some((service, index) => manifest.configuredServices[index] !== service)
		) {
			context.addIssue({
				code: "custom",
				message: "A pending time advance must retain the configured service order.",
				path: ["timeAdvance", "services"],
			});
		}
		if (manifest.clock.mode === "pinned" && manifest.clock.instantMs !== advance.toMs) {
			context.addIssue({
				code: "custom",
				message: "A pinned clock must equal the pending time advance destination.",
				path: ["clock", "instantMs"],
			});
		}
	});

type InstanceManifestV1 = Omit<InstanceManifest, "schemaVersion" | "timeAdvance"> & {
	readonly schemaVersion: 1;
};

const instanceManifestV1Schema: z.ZodType<InstanceManifestV1> = z.strictObject({
	clock: clockStateSchema,
	configuredServices: z.array(identifierSchema).superRefine((services, context) => {
		const seen = new Set<string>();
		for (const [index, service] of services.entries()) {
			if (seen.has(service)) {
				context.addIssue({
					code: "custom",
					message: `Configured service "${service}" appears more than once.`,
					path: [index],
				});
			}
			seen.add(service);
		}
	}),
	configFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	createdAt: timestampSchema,
	id: identifierSchema,
	persistence: z.enum(["persistent", "ephemeral"]),
	schemaVersion: z.literal(1),
	seed: seedStateSchema,
	status: z.enum(["creating", "ready"]),
	transition: instanceTransitionSchema.optional(),
});

const serviceManifestSchema: z.ZodType<ServiceManifest> = z.strictObject({
	createdAt: timestampSchema,
	pluginId: identifierSchema,
	schemaVersion: z.literal(SERVICE_MANIFEST_SCHEMA_VERSION),
	serviceKey: identifierSchema,
	stateVersion: z.int().positive(),
	updatedAt: timestampSchema,
});

const transitionManifestSchema: z.ZodType<StorageTransitionManifest> = z.strictObject({
	createdAt: timestampSchema,
	instanceId: identifierSchema,
	kind: z.enum(["destroy", "reset"]),
	phase: z.enum(["old_staged", "committed"]),
	schemaVersion: z.literal(TRANSITION_MANIFEST_SCHEMA_VERSION),
	transitionId: transitionIdSchema,
});

const quarantineManifestSchema: z.ZodType<InstanceQuarantineManifest> = z.strictObject({
	createdAt: timestampSchema,
	instanceId: identifierSchema,
	reason: z.enum(["ephemeral_recovery", "failed_creation", "incomplete_recovery"]),
	schemaVersion: z.literal(QUARANTINE_MANIFEST_SCHEMA_VERSION),
	trashId: transitionIdSchema,
});

export type ManifestKind = "instance" | "quarantine" | "service" | "transition";

export class ManifestValidationError extends Error {
	readonly filePath: string;
	readonly kind: ManifestKind;
	readonly issues: readonly z.core.$ZodIssue[];

	constructor(kind: ManifestKind, filePath: string, issues: readonly z.core.$ZodIssue[]) {
		super(`Invalid ${kind} manifest at ${filePath}.`);
		this.name = "ManifestValidationError";
		this.filePath = filePath;
		this.kind = kind;
		this.issues = Object.freeze([...issues]);
	}
}

export function parseInstanceManifest(value: unknown, filePath: string): InstanceManifest {
	if (isRecord(value) && value.schemaVersion === 1) {
		const previous = parseManifest("instance", instanceManifestV1Schema, value, filePath);
		return freezeInstanceManifest({ ...previous, schemaVersion: 2 });
	}
	return validateAndOwnInstanceManifest(value, filePath);
}

export function parseServiceManifest(value: unknown, filePath: string): ServiceManifest {
	return validateAndOwnServiceManifest(value, filePath);
}

export function parseTransitionManifest(
	value: unknown,
	filePath: string,
): StorageTransitionManifest {
	return validateAndOwnTransitionManifest(value, filePath);
}

export function parseInstanceQuarantineManifest(
	value: unknown,
	filePath: string,
): InstanceQuarantineManifest {
	return Object.freeze(parseManifest("quarantine", quarantineManifestSchema, value, filePath));
}

export function ownInstanceManifest(manifest: InstanceManifest): InstanceManifest {
	return validateAndOwnInstanceManifest(manifest, "<runtime instance manifest>");
}

function freezeInstanceManifest(manifest: InstanceManifest): InstanceManifest {
	const seed =
		manifest.seed.status === "seed_failed"
			? Object.freeze({ ...manifest.seed, failure: Object.freeze({ ...manifest.seed.failure }) })
			: Object.freeze({ ...manifest.seed });
	return Object.freeze({
		...manifest,
		clock: Object.freeze({ ...manifest.clock }),
		configuredServices: Object.freeze([...manifest.configuredServices]),
		seed,
		...(manifest.timeAdvance
			? {
					timeAdvance: Object.freeze({
						...manifest.timeAdvance,
						acknowledgedServices: Object.freeze([...manifest.timeAdvance.acknowledgedServices]),
						services: Object.freeze([...manifest.timeAdvance.services]),
					}),
				}
			: {}),
		...(manifest.transition ? { transition: Object.freeze({ ...manifest.transition }) } : {}),
	});
}

export function ownServiceManifest(manifest: ServiceManifest): ServiceManifest {
	return validateAndOwnServiceManifest(manifest, "<runtime service manifest>");
}

export function ownTransitionManifest(
	manifest: StorageTransitionManifest,
): StorageTransitionManifest {
	return validateAndOwnTransitionManifest(manifest, "<runtime transition manifest>");
}

function validateAndOwnInstanceManifest(value: unknown, filePath: string): InstanceManifest {
	return freezeInstanceManifest(
		parseManifest("instance", currentInstanceManifestSchema, value, filePath),
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAndOwnServiceManifest(value: unknown, filePath: string): ServiceManifest {
	return Object.freeze(parseManifest("service", serviceManifestSchema, value, filePath));
}

function validateAndOwnTransitionManifest(
	value: unknown,
	filePath: string,
): StorageTransitionManifest {
	return Object.freeze(parseManifest("transition", transitionManifestSchema, value, filePath));
}

function parseManifest<Schema extends z.ZodType>(
	kind: ManifestKind,
	schema: Schema,
	value: unknown,
	filePath: string,
): z.output<Schema> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new ManifestValidationError(kind, filePath, parsed.error.issues);
	return parsed.data;
}
