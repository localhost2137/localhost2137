import { type JsonObject, type JsonValue, ownJsonValue } from "../authoring/json-value.js";

export type OperationJsonObject = JsonObject;
export type OperationJsonValue = JsonValue;

export function ownOperationJson(value: unknown): OperationJsonValue {
	return ownJsonValue(value);
}
