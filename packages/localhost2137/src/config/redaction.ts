const DEFAULT_SENSITIVE_KEY =
	/(?:authorization|cookie|credential|password|secret|signing|token|api[-_]?key)/i;
const REDACTED = "[REDACTED]";

export interface RedactionOptions {
	readonly sensitiveKey?: RegExp;
}

export function redact(value: unknown, options: RedactionOptions = {}): unknown {
	return redactValue(value, options.sensitiveKey ?? DEFAULT_SENSITIVE_KEY, new WeakSet());
}

function redactValue(value: unknown, sensitiveKey: RegExp, seen: WeakSet<object>): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return "[CIRCULAR]";
		}
		seen.add(value);
		return value.map((entry) => redactValue(entry, sensitiveKey, seen));
	}
	if (!isRecord(value)) {
		return value;
	}
	if (seen.has(value)) {
		return "[CIRCULAR]";
	}
	seen.add(value);

	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		redacted[key] = sensitiveKey.test(key) ? REDACTED : redactValue(entry, sensitiveKey, seen);
		sensitiveKey.lastIndex = 0;
	}
	return redacted;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
