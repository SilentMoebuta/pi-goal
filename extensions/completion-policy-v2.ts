import { createHash } from "node:crypto";
import type {
	CompletionFinding,
	EvidenceKind,
	EvidenceRecordV2,
	EvidenceRef,
	GateLevel,
	GoalCriterionV2,
	ResearchClaim,
} from "./state";

export type { EvidenceKind, EvidenceRef, GateLevel, ResearchClaim } from "./state";

export const COMPLETION_POLICY_VERSION = "goal_completion_policy_v2" as const;

/** Additive shape: legacy criteria can retain evidence:string[] alongside these fields. */
export interface PolicyCriterion {
	id: string;
	description: string;
	level?: GateLevel;
	evidenceRefs?: readonly string[];
}

export type JudgeOutcome = "accept" | "continue" | "blocked";
export type RequirementStatus = "satisfied" | "unsatisfied" | "blocked";
export type ClaimSupport = "sufficient" | "insufficient" | "conflicted";

export interface JudgeRequirementAssessment {
	id: string;
	status: RequirementStatus;
	evidenceRefs: string[];
	reason: string;
}

export interface JudgeClaimAssessment {
	id: string;
	support: ClaimSupport;
	evidenceRefs: string[];
	reason: string;
}

export type CompletionFailureCode =
	| "judge_contract_invalid"
	| "blocking_requirement_unsatisfied"
	| "material_claim_unsupported"
	| "high_risk_claim_needs_corroboration"
	| "invalid_evidence_ref"
	| "evidence_conflicted"
	| "external_blocker";

export interface CompletionFailure extends Omit<CompletionFinding, "code"> {
	code: CompletionFailureCode;
}

export interface NormalizedJudgeVerdict {
	schemaVersion: typeof COMPLETION_POLICY_VERSION;
	outcome: JudgeOutcome;
	requirements: JudgeRequirementAssessment[];
	claims: JudgeClaimAssessment[];
	blockingFailures: CompletionFailure[];
	advisories: string[];
}

export interface JudgeNormalizationResult {
	ok: boolean;
	verdict: NormalizedJudgeVerdict;
	errors: string[];
}

export interface CompletionValidationInput {
	criteria: readonly PolicyCriterion[];
	claims?: readonly ResearchClaim[];
	evidenceLedger: readonly EvidenceRef[];
	judgeVerdict: unknown;
	assurance?: {
		reviewRequirement: "none" | "advisory" | "required";
		reviewStatus: "not_required" | "pending" | "passed" | "failed";
	};
	deterministicVerification?: {
		ok: boolean;
		exitCode: number | null;
	} | null;
}

export interface CompletionDecision {
	canComplete: boolean;
	status: JudgeOutcome;
	blockingFailures: CompletionFailure[];
	advisories: string[];
	judge: NormalizedJudgeVerdict;
	judgeContractErrors: string[];
}

const OUTCOMES = new Set<JudgeOutcome>(["accept", "continue", "blocked"]);
const REQUIREMENT_STATUSES = new Set<RequirementStatus>(["satisfied", "unsatisfied", "blocked"]);
const CLAIM_SUPPORT = new Set<ClaimSupport>(["sufficient", "insufficient", "conflicted"]);
const FAILURE_CODES = new Set<CompletionFailureCode>([
	"judge_contract_invalid",
	"blocking_requirement_unsatisfied",
	"material_claim_unsupported",
	"high_risk_claim_needs_corroboration",
	"invalid_evidence_ref",
	"evidence_conflicted",
	"external_blocker",
]);
const EVIDENCE_KINDS = new Set<EvidenceKind>([
	"source",
	"artifact",
	"command",
	"tool_result",
	"observation",
	"user_confirmation",
	"legacy_text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringArray(value: unknown, field: string, errors: string[]): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array`);
		return [];
	}
	const result: string[] = [];
	for (const item of value) {
		const cleaned = cleanString(item);
		if (!cleaned) errors.push(`${field} contains an empty or non-string value`);
		else result.push(cleaned);
	}
	return [...new Set(result)].sort();
}

/** Advisories are diagnostic free text: blank or non-string entries carry no
 *  information and must never invalidate the verdict — an advisory can never
 *  block completion (UX finding: judge emitted "" entries, the strict array
 *  path turned them into judge_contract_invalid, and the goal REVISE-loop). */
function cleanAdvisoryArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		const cleaned = cleanString(item);
		if (cleaned) result.push(cleaned);
	}
	return [...new Set(result)].sort();
}

function normalizeReason(value: unknown, fallback: string): string {
	return cleanString(value) ?? fallback;
}

function normalizeRequirementAssessments(value: unknown, errors: string[]): JudgeRequirementAssessment[] {
	if (!Array.isArray(value)) {
		errors.push("requirements must be an array");
		return [];
	}
	const result: JudgeRequirementAssessment[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) {
			errors.push(`requirements[${index}] must be an object`);
			continue;
		}
		const id = cleanString(item.id);
		const status = cleanString(item.status) as RequirementStatus | null;
		if (!id) errors.push(`requirements[${index}].id is required`);
		if (!status || !REQUIREMENT_STATUSES.has(status)) errors.push(`requirements[${index}].status is invalid`);
		if (!id || !status || !REQUIREMENT_STATUSES.has(status)) continue;
		if (seen.has(id)) {
			errors.push(`duplicate requirement assessment: ${id}`);
			continue;
		}
		seen.add(id);
		result.push({
			id,
			status,
			evidenceRefs: cleanStringArray(item.evidenceRefs, `requirements[${index}].evidenceRefs`, errors),
			reason: normalizeReason(item.reason, "No reason provided"),
		});
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeClaimAssessments(value: unknown, errors: string[]): JudgeClaimAssessment[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push("claims must be an array");
		return [];
	}
	const result: JudgeClaimAssessment[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) {
			errors.push(`claims[${index}] must be an object`);
			continue;
		}
		const id = cleanString(item.id);
		const support = cleanString(item.support) as ClaimSupport | null;
		if (!id) errors.push(`claims[${index}].id is required`);
		if (!support || !CLAIM_SUPPORT.has(support)) errors.push(`claims[${index}].support is invalid`);
		if (!id || !support || !CLAIM_SUPPORT.has(support)) continue;
		if (seen.has(id)) {
			errors.push(`duplicate claim assessment: ${id}`);
			continue;
		}
		seen.add(id);
		result.push({
			id,
			support,
			evidenceRefs: cleanStringArray(item.evidenceRefs, `claims[${index}].evidenceRefs`, errors),
			reason: normalizeReason(item.reason, "No reason provided"),
		});
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeFailures(value: unknown, errors: string[]): CompletionFailure[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push("blockingFailures must be an array");
		return [];
	}
	const result: CompletionFailure[] = [];
	for (const [index, item] of value.entries()) {
		if (!isRecord(item)) {
			errors.push(`blockingFailures[${index}] must be an object`);
			continue;
		}
		const code = cleanString(item.code) as CompletionFailureCode | null;
		const subjectId = cleanString(item.subjectId);
		const missingEvidenceKind = cleanString(item.missingEvidenceKind) as EvidenceKind | null;
		if (!code || !FAILURE_CODES.has(code)) errors.push(`blockingFailures[${index}].code is invalid`);
		if (!subjectId) errors.push(`blockingFailures[${index}].subjectId is required`);
		if (missingEvidenceKind && !EVIDENCE_KINDS.has(missingEvidenceKind)) {
			errors.push(`blockingFailures[${index}].missingEvidenceKind is invalid`);
		}
		if (!code || !FAILURE_CODES.has(code) || !subjectId) continue;
		result.push({
			code,
			subjectId,
			...(missingEvidenceKind && EVIDENCE_KINDS.has(missingEvidenceKind) ? { missingEvidenceKind } : {}),
			reason: normalizeReason(item.reason, "No reason provided"),
		});
	}
	return dedupeFailures(result);
}

/** Parse untrusted judge JSON into a stable, sorted contract. */
export function normalizeJudgeVerdict(raw: unknown): JudgeNormalizationResult {
	const errors: string[] = [];
	const input = isRecord(raw) ? raw : {};
	if (!isRecord(raw)) errors.push("judge verdict must be an object");
	if (input.schemaVersion !== COMPLETION_POLICY_VERSION) {
		errors.push(`unsupported schemaVersion: ${String(input.schemaVersion)}`);
	}
	const rawOutcome = cleanString(input.outcome) as JudgeOutcome | null;
	const outcome = rawOutcome && OUTCOMES.has(rawOutcome) ? rawOutcome : "continue";
	if (!rawOutcome || !OUTCOMES.has(rawOutcome)) errors.push("outcome is invalid");

	const advisories = input.advisories === undefined
		? []
		: cleanAdvisoryArray(input.advisories);
	const verdict: NormalizedJudgeVerdict = {
		schemaVersion: COMPLETION_POLICY_VERSION,
		outcome,
		requirements: normalizeRequirementAssessments(input.requirements, errors),
		claims: normalizeClaimAssessments(input.claims, errors),
		blockingFailures: normalizeFailures(input.blockingFailures, errors),
		advisories,
	};
	return { ok: errors.length === 0, verdict, errors };
}

function normalizedRefs(refs: readonly string[] | undefined): string[] {
	return [...new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean))].sort();
}

function failureKey(failure: CompletionFailure): string {
	return `${failure.code}\u0000${failure.subjectId}\u0000${failure.missingEvidenceKind ?? ""}`;
}

function dedupeFailures(failures: readonly CompletionFailure[]): CompletionFailure[] {
	const byKey = new Map<string, CompletionFailure>();
	for (const failure of failures) {
		const key = failureKey(failure);
		if (!byKey.has(key)) byKey.set(key, failure);
	}
	return [...byKey.values()].sort((a, b) => failureKey(a).localeCompare(failureKey(b)));
}

function evidenceIndex(ledger: readonly EvidenceRef[]): {
	valid: Map<string, EvidenceRef>;
	invalidIds: Set<string>;
	advisories: string[];
} {
	const valid = new Map<string, EvidenceRef>();
	const invalidIds = new Set<string>();
	const advisories: string[] = [];
	for (const item of ledger) {
		const id = item.id.trim();
		const summary = item.summary.trim();
		const explicitLocator = typeof item.locator === "string" ? item.locator.trim() : "";
		const locator = explicitLocator || `evidence:${id}`;
		const structurallyValid = Boolean(
			id && summary && locator && EVIDENCE_KINDS.has(item.kind) && item.verification !== "rejected",
		);
		if (!structurallyValid) {
			if (id) invalidIds.add(id);
			advisories.push(`Ignored malformed evidence entry${id ? ` ${id}` : " with no id"}.`);
			continue;
		}
		if (valid.has(id) || invalidIds.has(id)) {
			valid.delete(id);
			invalidIds.add(id);
			advisories.push(`Evidence id ${id} is duplicated and cannot be trusted.`);
			continue;
		}
		valid.set(id, { ...item, id, summary, locator });
	}
	return { valid, invalidIds, advisories };
}

function invalidRefs(refs: readonly string[], valid: ReadonlyMap<string, EvidenceRef>): string[] {
	return refs.filter((ref) => !valid.has(ref));
}

function citedAttachedEvidence(
	attachedRefs: readonly string[],
	judgeRefs: readonly string[],
	valid: ReadonlyMap<string, EvidenceRef>,
): EvidenceRef[] {
	const attached = new Set(attachedRefs);
	return judgeRefs
		.filter((ref) => attached.has(ref))
		.map((ref) => valid.get(ref))
		.filter((item): item is EvidenceRef => item !== undefined);
}

function independenceCount(evidence: readonly EvidenceRef[]): number {
	return new Set(
		evidence
			.map((item) => item.independenceKey?.trim())
			.filter((key): key is string => Boolean(key)),
	).size;
}

function addInvalidRefFailures(
	failures: CompletionFailure[],
	advisories: string[],
	subjectId: string,
	refs: readonly string[],
	level: GateLevel,
): void {
	for (const ref of refs) {
		const message = `${subjectId} references unknown or malformed evidence ${ref}.`;
		if (level === "blocking") failures.push({ code: "invalid_evidence_ref", subjectId, reason: message });
		else advisories.push(message);
	}
}

/** Deterministic policy evaluation. The judge assesses meaning; this function enforces evidence linkage and gate levels. */
export function validateCompletionPolicy(input: CompletionValidationInput): CompletionDecision {
	const normalized = normalizeJudgeVerdict(input.judgeVerdict);
	const judge = normalized.verdict;
	const failures: CompletionFailure[] = [];
	const advisories = [...judge.advisories];
	const evidence = evidenceIndex(input.evidenceLedger);
	advisories.push(...evidence.advisories);

	if (!normalized.ok) {
		failures.push({
			code: "judge_contract_invalid",
			subjectId: "$judge",
			reason: normalized.errors.join("; "),
		});
	}
	if (input.assurance?.reviewRequirement === "required" && input.assurance.reviewStatus !== "passed") {
		failures.push({
			code: "external_blocker",
			subjectId: "$goal",
			reason: "The risk-based assurance decision requires a completed independent review.",
		});
	}
	if (input.deterministicVerification && !input.deterministicVerification.ok) {
		failures.push({
			code: "external_blocker",
			subjectId: "$goal",
			missingEvidenceKind: "command",
			reason: "The configured deterministic verification command failed.",
		});
	}

	const criteriaById = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
	const claims = input.claims ?? [];
	const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
	const requirementAssessments = new Map(judge.requirements.map((item) => [item.id, item]));
	const claimAssessments = new Map(judge.claims.map((item) => [item.id, item]));
	const knownRequirementAssessments = judge.requirements.filter((item) => criteriaById.has(item.id));
	const knownClaimAssessments = judge.claims.filter((item) => claimsById.has(item.id));
	const unknownCriterionAssessments = judge.requirements.filter((item) => !criteriaById.has(item.id)).map((item) => item.id);
	const unknownClaimAssessments = judge.claims.filter((item) => !claimsById.has(item.id)).map((item) => item.id);
	if (unknownCriterionAssessments.length > 0 || unknownClaimAssessments.length > 0) {
		const parts = [
			...(unknownCriterionAssessments.length > 0 ? [`unknown criteria: ${unknownCriterionAssessments.join(", ")}`] : []),
			...(unknownClaimAssessments.length > 0 ? [`unknown claims: ${unknownClaimAssessments.join(", ")}`] : []),
		];
		failures.push({
			code: "judge_contract_invalid",
			subjectId: "$judge",
			reason: `Judge coverage references ${parts.join("; ")}.`,
		});
	}

	for (const criterion of input.criteria) {
		const level = criterion.level ?? "blocking";
		const attachedRefs = normalizedRefs(criterion.evidenceRefs);
		const assessment = requirementAssessments.get(criterion.id);
		const judgeRefs = normalizedRefs(assessment?.evidenceRefs);
		const badRefs = [...new Set([
			...invalidRefs(attachedRefs, evidence.valid),
			...invalidRefs(judgeRefs, evidence.valid),
		])];
		addInvalidRefFailures(failures, advisories, criterion.id, badRefs, level);
		const cited = citedAttachedEvidence(attachedRefs, judgeRefs, evidence.valid);
		const satisfied = badRefs.length === 0 && assessment?.status === "satisfied" && cited.length > 0;
		if (!satisfied) {
			const reason = assessment?.reason ?? `No judge assessment exists for ${criterion.id}.`;
			if (level === "blocking") {
				failures.push({ code: "blocking_requirement_unsatisfied", subjectId: criterion.id, reason });
			} else {
				advisories.push(`Advisory criterion ${criterion.id} is not satisfied: ${reason}`);
			}
		}
	}

	for (const claim of claims) {
		const level: GateLevel = claim.materiality === "material" ? "blocking" : "advisory";
		const attachedRefs = normalizedRefs(claim.evidenceRefs);
		const assessment = claimAssessments.get(claim.id);
		const judgeRefs = normalizedRefs(assessment?.evidenceRefs);
		const badRefs = [...new Set([
			...invalidRefs(attachedRefs, evidence.valid),
			...invalidRefs(judgeRefs, evidence.valid),
		])];
		addInvalidRefFailures(failures, advisories, claim.id, badRefs, level);
		const cited = citedAttachedEvidence(attachedRefs, judgeRefs, evidence.valid);
		const authoritativePrimary = cited.filter((item) => item.kind === "source" && item.sourceKind === "primary");
		let failure: CompletionFailure | null = null;
		if (assessment?.support === "conflicted") {
			failure = { code: "evidence_conflicted", subjectId: claim.id, reason: assessment.reason };
		} else if (badRefs.length > 0 || assessment?.support !== "sufficient" || cited.length === 0) {
			failure = {
				code: "material_claim_unsupported",
				subjectId: claim.id,
				reason: assessment?.reason ?? `No judge assessment exists for ${claim.id}.`,
			};
		} else if (authoritativePrimary.length === 0) {
			failure = {
				code: "material_claim_unsupported",
				subjectId: claim.id,
				missingEvidenceKind: "source",
				reason: `Material claim ${claim.id} needs an authoritative primary source.`,
			};
		} else if (claim.risk === "high" && independenceCount(authoritativePrimary) < 2) {
			failure = {
				code: "high_risk_claim_needs_corroboration",
				subjectId: claim.id,
				missingEvidenceKind: "source",
				reason: `High-risk claim ${claim.id} needs two independent evidence origins.`,
			};
		}
		if (failure) {
			if (level === "blocking") failures.push(failure);
			else advisories.push(`Supporting claim ${claim.id}: ${failure.reason}`);
		}
	}

	for (const declared of judge.blockingFailures) {
		const criterion = criteriaById.get(declared.subjectId);
		const claim = claimsById.get(declared.subjectId);
		if (criterion) {
			if ((criterion.level ?? "blocking") === "blocking") failures.push(declared);
			else advisories.push(`Judge advisory for ${declared.subjectId}: ${declared.reason}`);
		} else if (claim) {
			if (claim.materiality === "material") failures.push(declared);
			else advisories.push(`Judge advisory for ${declared.subjectId}: ${declared.reason}`);
		} else if (declared.subjectId === "$goal" || declared.subjectId === "$judge") {
			failures.push(declared);
		} else {
			failures.push({
				code: "judge_contract_invalid",
				subjectId: "$judge",
				reason: `Judge failure references unknown subject ${declared.subjectId}.`,
			});
		}
	}
	if (judge.outcome !== "accept" && failures.length === 0) {
		failures.push({
			code: "external_blocker",
			subjectId: "$goal",
			reason: judge.outcome === "blocked"
				? "The evaluator reported an external blocker."
				: "The evaluator did not accept the requested outcome.",
		});
	}

	const blockingFailures = dedupeFailures(failures);
	const uniqueAdvisories = [...new Set(advisories.map((item) => item.trim()).filter(Boolean))].sort();
	const status: JudgeOutcome = blockingFailures.length > 0
		? (judge.outcome === "blocked" ? "blocked" : "continue")
		: judge.outcome;
	return {
		canComplete: status === "accept" && blockingFailures.length === 0,
		status,
		blockingFailures,
		advisories: uniqueAdvisories,
		judge: {
			...judge,
			requirements: knownRequirementAssessments,
			claims: knownClaimAssessments,
		},
		judgeContractErrors: normalized.errors,
	};
}

/** Stable across failure ordering and free-form judge wording. */
export function rejectionFingerprint(failures: readonly CompletionFailure[]): string {
	const canonical = dedupeFailures(failures).map((failure) => ({
		code: failure.code,
		subjectId: failure.subjectId,
		missingEvidenceKind: failure.missingEvidenceKind ?? null,
	}));
	return createHash("sha256")
		.update(JSON.stringify({ policy: COMPLETION_POLICY_VERSION, failures: canonical }))
		.digest("hex");
}

export type RejectionAction = "feedback" | "replan" | "pause";

export interface RejectionEscalation {
	fingerprint: string;
	consecutiveCount: number;
	action: RejectionAction;
}

/** First occurrence gives focused feedback, second changes strategy, third pauses. */
export function rejectionEscalation(
	fingerprint: string,
	priorFingerprints: readonly string[],
): RejectionEscalation {
	let consecutiveCount = 1;
	for (let i = priorFingerprints.length - 1; i >= 0 && priorFingerprints[i] === fingerprint; i--) {
		consecutiveCount += 1;
	}
	const action: RejectionAction = consecutiveCount >= 3
		? "pause"
		: consecutiveCount === 2 ? "replan" : "feedback";
	return { fingerprint, consecutiveCount, action };
}

export type ReviewRisk = "low" | "medium" | "high";
export type ReviewerMode = "none" | "advisory" | "required";

export interface ReviewerPolicyInput {
	taskType?: string;
	risk: ReviewRisk;
	deterministicVerificationAvailable?: boolean;
	hasHighRiskClaims?: boolean;
	hasEvidenceConflict?: boolean;
	irreversibleExternalAction?: boolean;
	userRequiresReviewer?: boolean;
}

export interface ReviewerPolicyDecision {
	mode: ReviewerMode;
	independent: boolean;
	depth: "light" | "standard" | "deep";
	reasons: string[];
}

/** Reviewer cost follows risk and evidence conditions, never task type or source count alone. */
export function selectReviewerPolicy(input: ReviewerPolicyInput): ReviewerPolicyDecision {
	const requiredReasons: string[] = [];
	if (input.userRequiresReviewer) requiredReasons.push("The user explicitly requested independent review.");
	if (input.risk === "high") requiredReasons.push("The goal has high semantic or operational risk.");
	if (input.hasHighRiskClaims) requiredReasons.push("The result contains high-risk material claims.");
	if (input.hasEvidenceConflict) requiredReasons.push("Material evidence is in conflict.");
	if (input.irreversibleExternalAction) requiredReasons.push("The goal includes an irreversible external action.");
	if (requiredReasons.length > 0) {
		return { mode: "required", independent: true, depth: "deep", reasons: requiredReasons };
	}
	if (input.risk === "medium") {
		return {
			mode: "advisory",
			independent: true,
			depth: "standard",
			reasons: ["Medium-risk work benefits from review, but review is not a completion gate."],
		};
	}
	if (!input.deterministicVerificationAvailable) {
		return {
			mode: "advisory",
			independent: true,
			depth: "light",
			reasons: ["No deterministic verifier is available for this low-risk result."],
		};
	}
	return {
		mode: "none",
		independent: false,
		depth: "light",
		reasons: ["Low-risk work has deterministic verification."],
	};
}

/** Bridge the snapshot V2 criterion shape into the policy's flat evidence ledger. */
export function adaptStateCriteriaForPolicy(
	stateCriteria: readonly GoalCriterionV2[],
	canonicalEvidenceLedger: readonly EvidenceRef[] = [],
): {
	criteria: PolicyCriterion[];
	evidenceLedger: EvidenceRef[];
} {
	const criteria: PolicyCriterion[] = [];
	const evidenceLedger: EvidenceRef[] = canonicalEvidenceLedger.map((item) => ({
		...item,
		locator: item.locator?.trim() || `evidence:${item.id}`,
	}));
	const canonicalIds = new Set(evidenceLedger.map((item) => item.id));
	const fingerprintsById = new Map(evidenceLedger.map((item) => [item.id, JSON.stringify(item)]));
	for (const criterion of stateCriteria) {
		const evidenceRefs: string[] = [...(criterion.evidenceRefs ?? [])];
		for (const record of criterion.evidence) {
			const adapted = adaptStateEvidenceRecord(record);
			if (canonicalIds.has(adapted.id)) {
				if (record.verification !== "rejected") evidenceRefs.push(record.id);
				continue;
			}
			const fingerprint = JSON.stringify(adapted);
			const previous = fingerprintsById.get(adapted.id);
			if (previous === undefined) {
				fingerprintsById.set(adapted.id, fingerprint);
				evidenceLedger.push(adapted);
			} else if (previous !== fingerprint) {
				// Preserve conflicting duplicates so deterministic validation rejects the id.
				evidenceLedger.push(adapted);
			}
			if (record.verification !== "rejected") evidenceRefs.push(record.id);
		}
		criteria.push({
			id: criterion.id,
			description: criterion.description,
			level: criterion.level ?? "blocking",
			evidenceRefs: normalizedRefs(evidenceRefs),
		});
	}
	return { criteria, evidenceLedger };
}

export function adaptStateEvidenceRecord(record: EvidenceRecordV2): EvidenceRef {
	return {
		id: record.id,
		kind: record.kind,
		summary: record.summary,
		locator: record.locator?.trim() || `state-evidence:${record.id}`,
		...(record.sourceKind === undefined ? {} : { sourceKind: record.sourceKind }),
		...(record.independenceKey === undefined ? {} : { independenceKey: record.independenceKey }),
		excerpt: record.summary,
		recordedAt: record.recordedAt,
		origin: record.origin,
		verification: record.verification,
	};
}
