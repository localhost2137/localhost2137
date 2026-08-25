import { z } from "zod";

const INSTANCE_MANIFEST_SCHEMA_VERSION = 1;
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

export interface InstanceManifest {
	readonly clock: InstanceClockState;
	readonly configuredServices: readonly string[];
	readonly configFingerprint: string;
	readonly createdAt: string;
	readonly id: string;
	readonly persistence: "ephemeral" | "persistent";
	readonly schemaVersion: 1;
	readonly seed: InstanceSeedState;
	readonly status: "creating" | "ready";
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

const instanceManifestSchema: z.ZodType<InstanceManifest> = z.strictObject({
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
	return freezeInstanceManifest(parseManifest("instance", instanceManifestSchema, value, filePath));
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
