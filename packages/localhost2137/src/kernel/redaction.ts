const DEFAULT_SENSITIVE_KEY =
	/(?:authorization|cookie|credential|password|secret|signing|token|api[-_]?key)/i;
const REDACTED = "[REDACTED]";

export interface RedactionOptions {
	readonly sensitiveKey?: RegExp;
}

export function redact(value: unknown, options: RedactionOptions = {}): unknown {
	return redactValue(value, options.sensitiveKey ?? DEFAULT_SENSITIVE_KEY, new WeakSet());
}

function redactValue(value: unknown, sensitiveKey: RegExp, ancestors: WeakSet<object>): unknown {
	if (Array.isArray(value)) {
		if (ancestors.has(value)) return "[CIRCULAR]";
		ancestors.add(value);
		const result = value.map((entry) => redactValue(entry, sensitiveKey, ancestors));
		ancestors.delete(value);
		return result;
	}
	if (!isRecord(value)) return value;
	if (ancestors.has(value)) return "[CIRCULAR]";
	ancestors.add(value);

	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		sensitiveKey.lastIndex = 0;
		const redactedValue = sensitiveKey.test(key)
			? REDACTED
			: redactValue(entry, sensitiveKey, ancestors);
		Object.defineProperty(redacted, key, {
			configurable: true,
			enumerable: true,
			value: redactedValue,
			writable: true,
		});
	}
	ancestors.delete(value);
	return redacted;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
