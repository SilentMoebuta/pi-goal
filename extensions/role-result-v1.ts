import { createHash } from "node:crypto";

export const PI_ROLES_RESULT_TYPE = "pi-roles:role-result";

export interface RoleResultRefV1 {
	resultId: string;
	agentId: string;
	role: string;
	status: "completed";
	digest: string;
}

export interface RoleResultEnvelopeV1 {
	schemaVersion: 1;
	resultId: string;
	agentId: string;
	role: string;
	status: "completed" | "aborted" | "error";
	digest: string;
	payload: Record<string, unknown> | null;
	error: { code: string; message: string; retryable: boolean } | null;
	turnCount: number;
	recordedAt: number;
}

export type ResolveRoleResult =
	| { ok: true; result: RoleResultEnvelopeV1 }
	| { ok: false; reason: string };

export function resolveRoleResultFromBranch(branch: readonly unknown[], ref: RoleResultRefV1): ResolveRoleResult {
	let matched: RoleResultEnvelopeV1 | null = null;
	for (const entry of branch) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "custom" || record.customType !== PI_ROLES_RESULT_TYPE) continue;
		try {
			const parsed = parseRoleResultEnvelopeV1(record.data);
			if (parsed.resultId === ref.resultId) matched = parsed;
		} catch {
			// A corrupt unrelated entry must not hide a later valid result. A corrupt
			// entry with the requested ID cannot be trusted and therefore does not match.
		}
	}
	if (!matched) return { ok: false, reason: `No durable pi-roles result found for ${ref.resultId}.` };
	if (matched.agentId !== ref.agentId || matched.role !== ref.role || matched.status !== ref.status || matched.digest !== ref.digest) {
		return { ok: false, reason: "The submitted role-result reference does not match the durable result envelope." };
	}
	if (matched.status !== "completed" || !matched.payload) {
		return { ok: false, reason: "The referenced role did not complete with a structured payload." };
	}
	return { ok: true, result: matched };
}

export function parseRoleResultEnvelopeV1(value: unknown): RoleResultEnvelopeV1 {
	const object = asRecord(value, "role result");
	if (object.schemaVersion !== 1) throw new Error("role result schemaVersion must be 1");
	const status = enumValue(object.status, ["completed", "aborted", "error"] as const, "status");
	const payload = object.payload === null ? null : asRecord(object.payload, "payload");
	const error = object.error === null ? null : (() => {
		const raw = asRecord(object.error, "error");
		if (typeof raw.retryable !== "boolean") throw new Error("error.retryable must be boolean");
		return { code: requiredString(raw.code, "error.code"), message: requiredString(raw.message, "error.message"), retryable: raw.retryable };
	})();
	const result: RoleResultEnvelopeV1 = {
		schemaVersion: 1,
		resultId: requiredString(object.resultId, "resultId"),
		agentId: requiredString(object.agentId, "agentId"),
		role: requiredString(object.role, "role"),
		status,
		digest: sha256(object.digest, "digest"),
		payload,
		error,
		turnCount: integer(object.turnCount, "turnCount"),
		recordedAt: finiteNonNegative(object.recordedAt, "recordedAt"),
	};
	if (result.resultId !== `role-result:${result.agentId}`) throw new Error("resultId does not match agentId");
	if ((result.status === "completed") !== (result.error === null)) throw new Error("role result status/error mismatch");
	const expected = createHash("sha256").update(stableJson({
		agentId: result.agentId,
		role: result.role,
		status: result.status,
		payload: result.payload,
		error: result.error,
		turnCount: result.turnCount,
	})).digest("hex");
	if (expected !== result.digest) throw new Error("role result digest mismatch");
	return result;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function sha256(value: unknown, path: string): string {
	const result = requiredString(value, path);
	if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${path} must be a sha256 digest`);
	return result;
}

function integer(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
	return value;
}

function finiteNonNegative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be non-negative`);
	return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} is invalid`);
	return value as T[number];
}
