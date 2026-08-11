import {
	PI_ROLES_RESULT_TYPE,
	parseRoleResultEnvelope,
	type RoleResultEnvelopeV1 as CanonicalRoleResultEnvelopeV1,
	type RoleResultRef as CanonicalRoleResultRefV1,
} from "@silentmoebuta/pi-roles-protocol/role-result";

export { PI_ROLES_RESULT_TYPE };
export type RoleResultEnvelopeV1 = CanonicalRoleResultEnvelopeV1;
export type RoleResultRefV1 = Omit<CanonicalRoleResultRefV1, "status"> & { status: "completed" };
export const parseRoleResultEnvelopeV1 = parseRoleResultEnvelope;

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
