import { createHash } from "node:crypto";
import type {
	CompletionFinding,
	CompletionEvaluator,
	EvidenceKind,
	EvidenceOrigin,
	EvidenceRef,
	EvidenceSourceKind,
	EvidenceVerification,
	ExecutionDecision,
	ExecutionReassessmentTrigger,
	ResearchClaim,
	Topology,
} from "./state";
import type { ExecutionRoutingSignals } from "./execution-router-v2";

export type UpdateGoalActionName =
	| "record_evidence"
	| "upsert_claim"
	| "request_completion"
	| "record_review"
	| "change_execution"
	| "mark_unmet"
	| "pause"
	| "record_deviation"
	| "submit_completion_bundle";

export interface CompletionArtifactInput {
	id: string;
	uri: string;
	digest: string;
	sizeBytes: number;
	mediaType?: string;
}

export interface CompletionEvidenceInput {
	id: string;
	kind: "source" | "artifact" | "command" | "tool_result" | "observation" | "user_confirmation";
	summary: string;
	criterionIds: string[];
	claimIds: string[];
	artifactId?: string;
	digest?: string;
}

export interface CompletionCheckInput {
	id: string;
	status: "passed" | "failed";
	summary: string;
	evidenceIds: string[];
}

export interface RoleResultRefInput {
	resultId: string;
	agentId: string;
	role: string;
	status: "completed";
	digest: string;
}

export interface SubmitCompletionBundleAction {
	action: "submit_completion_bundle";
	idempotencyKey: string;
	summary: string;
	artifacts: CompletionArtifactInput[];
	evidence: CompletionEvidenceInput[];
	deterministicChecks: CompletionCheckInput[];
	reviewerResultRef: RoleResultRefInput;
}

export interface RecordEvidenceAction {
	action: "record_evidence";
	evidence: EvidenceRef | null;
	evidenceId: string;
	criterionIds: string[];
	claimIds: string[];
}

export interface UpsertClaimAction {
	action: "upsert_claim";
	claim: ResearchClaim;
}

export interface RequestCompletionAction {
	action: "request_completion";
	summary: string;
}

export interface RecordedReview {
	status: "passed" | "failed";
	reason: string;
	evaluator: CompletionEvaluator;
	findings: CompletionFinding[];
	advisories: string[];
	sessionFile: string;
}

export interface RecordReviewAction {
	action: "record_review";
	review: RecordedReview;
}

export interface ChangeExecutionAction {
	action: "change_execution";
	execution: ExecutionDecision | null;
	routing: {
		trigger: ExecutionReassessmentTrigger;
		signals: ExecutionRoutingSignals;
	} | null;
}

export interface MarkUnmetAction {
	action: "mark_unmet";
	blocker: string;
}

export interface PauseGoalAction {
	action: "pause";
	/** 暂停原因：卡在哪里、需要用户做什么决策。用户看到后会回复或 /goal resume。 */
	reason: string;
}

export interface RecordDeviationAction {
	action: "record_deviation";
	/** 可空；指向 criterion/claim id 或蓝图节点 id。 */
	subjectId?: string;
	description: string;
	reason: string;
	/** 对验收标准的影响（无/部分/风险…）。 */
	impact?: string;
}

export type NormalizedUpdateGoalAction =
	| RecordEvidenceAction
	| UpsertClaimAction
	| RequestCompletionAction
	| RecordReviewAction
	| ChangeExecutionAction
	| MarkUnmetAction
	| PauseGoalAction
	| RecordDeviationAction
	| SubmitCompletionBundleAction;

export type NormalizeUpdateGoalActionResult =
	| { ok: true; action: NormalizedUpdateGoalAction; legacy: boolean; warnings: string[] }
	| { ok: false; kind: "invalid" | "mixed_action"; reason: string };

export interface NormalizeUpdateGoalActionOptions {
	now: number;
}

const ACTIONS = new Set<UpdateGoalActionName>([
	"record_evidence",
	"upsert_claim",
	"request_completion",
	"record_review",
	"change_execution",
	"mark_unmet",
	"pause",
	"record_deviation",
	"submit_completion_bundle",
]);
const EVIDENCE_KINDS = new Set<EvidenceKind>([
	"source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text",
]);
const SOURCE_KINDS = new Set<EvidenceSourceKind>(["primary", "secondary", "workspace", "user"]);
const ORIGINS = new Set<EvidenceOrigin>(["tool", "agent", "user", "legacy"]);
const VERIFICATIONS = new Set<EvidenceVerification>(["unverified", "verified", "rejected"]);
const TOPOLOGIES = new Set<Topology>(["direct", "specialist", "team"]);
const REASSESSMENT_TRIGGERS = new Set<ExecutionReassessmentTrigger>([
	"scope_expanded", "new_workstream", "conflict", "stalled",
]);

class ActionValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new ActionValidationError(`${field} is required`);
	return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ActionValidationError(`${field} must be an array`);
	return [...new Set(value.map((item, index) => requiredString(item, `${field}[${index}]`)))];
}

function singularAndPlural(raw: Record<string, unknown>, singular: string, plural: string): string[] {
	const items = stringArray(raw[plural], plural);
	const one = optionalString(raw[singular], singular);
	if (one) items.push(one);
	return [...new Set(items)].sort();
}

function finiteNonNegative(value: unknown, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ActionValidationError(`${field} must be a finite non-negative number`);
	}
	return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, field: string, fallback?: T): T {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "string" || !allowed.has(value as T)) throw new ActionValidationError(`${field} is invalid`);
	return value as T;
}

function inferredActions(raw: Record<string, unknown>): Set<UpdateGoalActionName> {
	const result = new Set<UpdateGoalActionName>();
	const declared = raw.action;
	if (typeof declared === "string" && ACTIONS.has(declared as UpdateGoalActionName)) {
		result.add(declared as UpdateGoalActionName);
	}
	const recordEvidence = isRecord(raw.evidence)
		|| raw.evidenceId !== undefined
		|| raw.criterionId !== undefined
		|| raw.criterionIds !== undefined
		|| raw.claimIds !== undefined
		|| (typeof raw.evidence === "string" && raw.status !== "complete");
	if (recordEvidence) result.add("record_evidence");
	if (isRecord(raw.claim) || raw.claimText !== undefined || raw.materiality !== undefined) result.add("upsert_claim");
	if (raw.summary !== undefined || raw.status === "complete") result.add("request_completion");
	if (isRecord(raw.review) || raw.reviewerPassed !== undefined || raw.reviewerVerdict !== undefined
		|| raw.reviewerAgentId !== undefined || raw.reviewerSessionFile !== undefined
		|| raw.reviewerSessionId !== undefined || raw.decision !== undefined || raw.findings !== undefined
		|| raw.advisories !== undefined || raw.singleRationalePreApproved !== undefined
		|| raw.singleRationaleReviewer !== undefined) result.add("record_review");
	if (isRecord(raw.execution) || isRecord(raw.routing) || raw.reassessTrigger !== undefined
		|| raw.executionMode !== undefined || raw.preference !== undefined
		|| raw.selected !== undefined || raw.role !== undefined || raw.confidence !== undefined
		|| raw.reasons !== undefined) result.add("change_execution");
	if (raw.blocker !== undefined || raw.status === "unmet") result.add("mark_unmet");
	if (raw.action === "pause" || raw.pausedReason !== undefined) result.add("pause");
	// record_deviation 无 legacy 扁平形式：只接受显式 action（避免与旧字段误判）。
	if (raw.action === "record_deviation") result.add("record_deviation");
	if (raw.action === "submit_completion_bundle") result.add("submit_completion_bundle");
	return result;
}

function isSchemaDefaultNoise(value: unknown): boolean {
	if (value === undefined || value === null || value === false || value === "" || value === 0) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (isRecord(value)) return Object.values(value).every(isSchemaDefaultNoise);
	return false;
}

function withoutSchemaDefaultNoise(raw: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key === "action" || !isSchemaDefaultNoise(value)));
}

function legacyEvidenceId(raw: Record<string, unknown>, text: string): string {
	const context = [raw.criterionId, raw.claimId, text].map((item) => String(item ?? "")).join("\u0000");
	return `legacy-update:${createHash("sha256").update(context).digest("hex").slice(0, 20)}`;
}

function parseEvidence(raw: Record<string, unknown>, now: number): EvidenceRef {
	const nested = isRecord(raw.evidence) ? raw.evidence : raw;
	const legacyText = typeof raw.evidence === "string" ? raw.evidence.trim() : undefined;
	const id = optionalString(nested.id, "evidence.id")
		?? optionalString(raw.evidenceId, "evidenceId")
		?? (legacyText ? legacyEvidenceId(raw, legacyText) : undefined);
	if (!id) throw new ActionValidationError("record_evidence requires evidence.id or evidenceId");
	const kind = enumValue(
		nested.kind ?? raw.kind,
		EVIDENCE_KINDS,
		"evidence.kind",
		legacyText ? "legacy_text" : undefined,
	);
	const summary = requiredString(nested.summary ?? legacyText, "evidence.summary");
	const locator = optionalString(nested.locator ?? raw.locator, "evidence.locator");
	const sourceKind = nested.sourceKind === undefined && raw.sourceKind === undefined
		? undefined
		: enumValue(nested.sourceKind ?? raw.sourceKind, SOURCE_KINDS, "evidence.sourceKind");
	const independenceKey = optionalString(nested.independenceKey ?? raw.independenceKey, "evidence.independenceKey");
	const excerpt = optionalString(nested.excerpt ?? raw.excerpt ?? legacyText, "evidence.excerpt");
	const origin = enumValue(
		nested.origin ?? raw.origin,
		ORIGINS,
		"evidence.origin",
		legacyText ? "legacy" : "agent",
	);
	const verification = enumValue(
		nested.verification ?? raw.verification,
		VERIFICATIONS,
		"evidence.verification",
		"unverified",
	);
	return {
		id,
		kind,
		summary,
		...(locator === undefined ? {} : { locator }),
		...(sourceKind === undefined ? {} : { sourceKind }),
		...(independenceKey === undefined ? {} : { independenceKey }),
		...(excerpt === undefined ? {} : { excerpt }),
		recordedAt: finiteNonNegative(nested.recordedAt ?? raw.recordedAt, now, "evidence.recordedAt"),
		origin,
		verification,
	};
}

function parseRecordEvidence(raw: Record<string, unknown>, now: number): RecordEvidenceAction {
		const nestedEvidence = isRecord(raw.evidence) ? raw.evidence : undefined;
		// Top-level targets are canonical; nested targets are accepted for
		// compatibility with callers that group criterionIds/claimIds under
		// evidence. When both are present, the explicit top-level values win.
		const targetFields = nestedEvidence === undefined ? raw : { ...nestedEvidence, ...raw };
	const reuseOnly = raw.evidence === undefined
		&& raw.evidenceId !== undefined
		&& raw.kind === undefined
		&& raw.summary === undefined;
	const evidenceId = reuseOnly
		? requiredString(raw.evidenceId, "evidenceId")
		: "";
	const evidence = reuseOnly ? null : parseEvidence(raw, now);
	return {
		action: "record_evidence",
		evidence,
		evidenceId: evidence?.id ?? evidenceId,
		criterionIds: singularAndPlural(targetFields, "criterionId", "criterionIds"),
		claimIds: singularAndPlural(targetFields, "claimId", "claimIds"),
	};
}

function parseClaim(raw: Record<string, unknown>): UpsertClaimAction {
	const nested = isRecord(raw.claim) ? raw.claim : raw;
	const risk = nested.risk === undefined
		? undefined
		: enumValue(nested.risk, new Set(["ordinary", "high"] as const), "claim.risk");
	return {
		action: "upsert_claim",
		claim: {
			id: requiredString(nested.id ?? raw.claimId, "claim.id"),
			text: requiredString(nested.text ?? raw.claimText, "claim.text"),
			materiality: enumValue(nested.materiality, new Set(["material", "supporting"] as const), "claim.materiality"),
			...(risk === undefined ? {} : { risk }),
			evidenceRefs: stringArray(nested.evidenceRefs, "claim.evidenceRefs").sort(),
		},
	};
}

function parseRequestCompletion(raw: Record<string, unknown>): RequestCompletionAction {
	const legacySummary = raw.status === "complete" && typeof raw.evidence === "string" ? raw.evidence : undefined;
	return {
		action: "request_completion",
		summary: requiredString(raw.summary ?? legacySummary, "summary"),
	};
}

function parseEvaluator(value: unknown, fallback: Record<string, unknown>): CompletionEvaluator {
	const raw = isRecord(value) ? value : fallback;
	const kind = enumValue(
		raw.kind,
		new Set(["judge", "reviewer", "deterministic", "legacy_reviewer"] as const),
		"review.evaluator.kind",
		isRecord(value) ? undefined : "legacy_reviewer",
	);
	const fields = ["model", "agentId", "sessionId", "reportDigest", "legacySessionFile", "legacyReportPath"] as const;
	const result: CompletionEvaluator = { kind };
	for (const field of fields) {
		const parsed = optionalString(raw[field], `review.evaluator.${field}`);
		if (parsed !== undefined) result[field] = parsed;
	}
	return result;
}

function parseReview(raw: Record<string, unknown>): RecordReviewAction {
	const parseFindings = (value: unknown): CompletionFinding[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value)) throw new ActionValidationError("review.findings must be an array");
		return value.map((item, index) => {
			if (!isRecord(item)) throw new ActionValidationError(`review.findings[${index}] must be an object`);
			const missingEvidenceKind = item.missingEvidenceKind === undefined
				? undefined
					: enumValue(item.missingEvidenceKind, EVIDENCE_KINDS, `review.findings[${index}].missingEvidenceKind`);
			const scope = item.scope === undefined
				? undefined
				: enumValue(item.scope, new Set(["local", "section", "global"] as const), `review.findings[${index}].scope`);
			const rewriteRequired = item.rewriteRequired === undefined ? undefined : item.rewriteRequired;
			if (rewriteRequired !== undefined && typeof rewriteRequired !== "boolean") {
				throw new ActionValidationError(`review.findings[${index}].rewriteRequired must be a boolean`);
			}
			if (rewriteRequired === true && scope !== "global") {
				throw new ActionValidationError(`review.findings[${index}] may require a full rewrite only when scope=global`);
			}
			const rewriteReason = optionalString(item.rewriteReason, `review.findings[${index}].rewriteReason`);
			if (rewriteRequired === true && !rewriteReason) {
				throw new ActionValidationError(`review.findings[${index}].rewriteReason is required when rewriteRequired=true`);
			}
			return {
				code: requiredString(item.code, `review.findings[${index}].code`),
				subjectId: requiredString(item.subjectId, `review.findings[${index}].subjectId`),
				reason: requiredString(item.reason, `review.findings[${index}].reason`),
				...(item.evidenceRefs === undefined ? {} : { evidenceRefs: stringArray(item.evidenceRefs, `review.findings[${index}].evidenceRefs`) }),
				...(missingEvidenceKind ? { missingEvidenceKind } : {}),
				...(scope ? { scope } : {}),
				...(optionalString(item.targetPath, `review.findings[${index}].targetPath`) ? { targetPath: optionalString(item.targetPath, `review.findings[${index}].targetPath`)! } : {}),
				...(optionalString(item.sectionId, `review.findings[${index}].sectionId`) ? { sectionId: optionalString(item.sectionId, `review.findings[${index}].sectionId`)! } : {}),
				...(optionalString(item.anchor, `review.findings[${index}].anchor`) ? { anchor: optionalString(item.anchor, `review.findings[${index}].anchor`)! } : {}),
				...(optionalString(item.requiredFix, `review.findings[${index}].requiredFix`) ? { requiredFix: optionalString(item.requiredFix, `review.findings[${index}].requiredFix`)! } : {}),
				...(rewriteRequired === undefined ? {} : { rewriteRequired }),
				...(rewriteReason ? { rewriteReason } : {}),
			};
		});
	};
	if (isRecord(raw.review)) {
		const review = raw.review;
		const evaluator = parseEvaluator(review.evaluator, {});
		const sessionFile = requiredString(
			review.sessionFile ?? evaluator.legacySessionFile,
			"review.sessionFile",
		);
		return {
			action: "record_review",
			review: {
				status: enumValue(review.status, new Set(["passed", "failed"] as const), "review.status"),
				reason: requiredString(review.reason, "review.reason"),
				evaluator,
				findings: parseFindings(review.findings),
				advisories: stringArray(review.advisories, "review.advisories"),
				sessionFile,
			},
		};
	}
	const passed = typeof raw.reviewerPassed === "boolean"
		? raw.reviewerPassed
		: typeof raw.singleRationalePreApproved === "boolean" ? raw.singleRationalePreApproved : undefined;
	if (passed === undefined) {
		throw new ActionValidationError("legacy record_review requires reviewerPassed or singleRationalePreApproved boolean");
	}
	const verdict = isRecord(raw.reviewerVerdict)
		? raw.reviewerVerdict
		: isRecord(raw.singleRationaleReviewer) ? raw.singleRationaleReviewer : {};
	const evaluatorFallback: Record<string, unknown> = {
		kind: "legacy_reviewer",
		model: verdict.model,
		agentId: raw.reviewerAgentId,
		legacySessionFile: raw.reviewerSessionFile,
		legacyReportPath: verdict.reportPath,
	};
	return {
		action: "record_review",
		review: {
			status: passed ? "passed" : "failed",
			reason: optionalString(verdict.notes, "reviewerVerdict.notes")
				?? (passed ? "Legacy reviewer approved." : "Legacy reviewer rejected."),
			evaluator: parseEvaluator(undefined, evaluatorFallback),
			findings: parseFindings(raw.findings),
			advisories: stringArray(raw.advisories, "advisories"),
			sessionFile: requiredString(raw.reviewerSessionFile, "reviewerSessionFile"),
		},
	};
}

function parseExecutionDecision(value: unknown): ExecutionDecision {
	if (!isRecord(value)) throw new ActionValidationError("execution must be an object");
	const preference = enumValue(value.preference, new Set(["auto", "direct", "specialist", "team"] as const), "execution.preference");
	const selected = enumValue(value.selected, TOPOLOGIES, "execution.selected");
	const source = enumValue(value.source, new Set(["auto", "user", "legacy"] as const), "execution.source");
	if (value.confidence === undefined) throw new ActionValidationError("execution.confidence is required");
	const confidence = finiteNonNegative(value.confidence, 0, "execution.confidence");
	if (confidence > 1) throw new ActionValidationError("execution.confidence must be <= 1");
	const role = optionalString(value.role, "execution.role");
	const minimum = value.minimum === undefined
		? undefined
		: enumValue(value.minimum, new Set(["specialist"] as const), "execution.minimum");
	return {
		preference,
		selected,
		...(role === undefined ? {} : { role }),
		source,
		confidence,
		reasons: stringArray(value.reasons, "execution.reasons"),
		...(minimum === undefined ? {} : { minimum }),
		reassessOn: stringArray(value.reassessOn, "execution.reassessOn").map((trigger, index) =>
			enumValue(trigger, REASSESSMENT_TRIGGERS, `execution.reassessOn[${index}]`)
		),
	};
}

function legacyExecution(mode: unknown): ExecutionDecision {
	if (mode === "single") {
		return {
			preference: "direct",
			selected: "direct",
			source: "legacy",
			confidence: 1,
			reasons: ["Legacy executionMode=single."],
			reassessOn: ["scope_expanded", "stalled"],
		};
	}
	if (mode === "orchestrated") {
		return {
			preference: "auto",
			selected: "specialist",
			source: "legacy",
			confidence: 0.5,
			reasons: ["Legacy orchestrated mode did not distinguish specialist from team."],
			minimum: "specialist",
			reassessOn: ["scope_expanded", "new_workstream", "stalled"],
		};
	}
	throw new ActionValidationError("executionMode must be single or orchestrated");
}

function parseChangeExecution(raw: Record<string, unknown>): ChangeExecutionAction {
	if (isRecord(raw.routing)) {
		if (isRecord(raw.execution) || raw.executionMode !== undefined || raw.preference !== undefined || raw.selected !== undefined) {
			throw new ActionValidationError("change_execution accepts routing reassessment or an execution decision, not both");
		}
		const routing = raw.routing;
		const semanticLevels = new Set(["low", "medium", "high"] as const);
		const specialistNeeds = new Set(["none", "helpful", "required"] as const);
		const efforts = new Set(["small", "medium", "large"] as const);
		const finiteCount = (value: unknown, field: string): number => {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ActionValidationError(field + " must be a non-negative number");
			return Math.floor(value);
		};
		const signals: ExecutionRoutingSignals = {
			uncertainty: enumValue(routing.uncertainty, semanticLevels, "routing.uncertainty"),
			coupling: enumValue(routing.coupling, semanticLevels, "routing.coupling"),
			risk: enumValue(routing.risk, semanticLevels, "routing.risk"),
			specialistNeed: enumValue(routing.specialistNeed, specialistNeeds, "routing.specialistNeed"),
			independentWorkstreams: finiteCount(routing.independentWorkstreams, "routing.independentWorkstreams"),
			heterogeneousSkills: typeof routing.heterogeneousSkills === "boolean"
				? routing.heterogeneousSkills
				: (() => { throw new ActionValidationError("routing.heterogeneousSkills must be boolean"); })(),
			effort: enumValue(routing.effort, efforts, "routing.effort"),
			...(routing.confidence === undefined ? {} : {
				confidence: (() => {
					const value = finiteNonNegative(routing.confidence, 1, "routing.confidence");
					if (value > 1) throw new ActionValidationError("routing.confidence must be <= 1");
					return value;
				})(),
			}),
			...(routing.repeatedFailureCount === undefined ? {} : { repeatedFailureCount: finiteCount(routing.repeatedFailureCount, "routing.repeatedFailureCount") }),
			...(routing.remainingWorkstreams === undefined ? {} : { remainingWorkstreams: finiteCount(routing.remainingWorkstreams, "routing.remainingWorkstreams") }),
			...(routing.coordinationOverheadHigh === undefined ? {} : {
				coordinationOverheadHigh: typeof routing.coordinationOverheadHigh === "boolean"
					? routing.coordinationOverheadHigh
					: (() => { throw new ActionValidationError("routing.coordinationOverheadHigh must be boolean"); })(),
			}),
		};
		return {
			action: "change_execution",
			execution: null,
			routing: {
				trigger: enumValue(raw.reassessTrigger, REASSESSMENT_TRIGGERS, "reassessTrigger"),
				signals,
			},
		};
	}
	const execution = isRecord(raw.execution)
		? parseExecutionDecision(raw.execution)
		: raw.executionMode !== undefined
			? legacyExecution(raw.executionMode)
			: parseExecutionDecision({
				preference: raw.preference,
				selected: raw.selected,
				role: raw.role,
				source: "user",
				confidence: raw.confidence ?? 1,
				reasons: raw.reasons ?? ["User changed execution preference."],
				reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
			});
	return {
		action: "change_execution",
		execution,
		routing: null,
	};
}

function parseAction(raw: Record<string, unknown>, action: UpdateGoalActionName, now: number): NormalizedUpdateGoalAction {
	switch (action) {
		case "record_evidence": return parseRecordEvidence(raw, now);
		case "upsert_claim": return parseClaim(raw);
		case "request_completion": return parseRequestCompletion(raw);
		case "record_review": return parseReview(raw);
		case "change_execution": return parseChangeExecution(raw);
		case "mark_unmet": return { action: "mark_unmet", blocker: requiredString(raw.blocker, "blocker") };
		case "pause": return { action: "pause", reason: requiredString(raw.reason, "reason") };
		case "record_deviation": return parseRecordDeviation(raw);
		case "submit_completion_bundle": return parseSubmitCompletionBundle(raw);
	}
}

function parseSubmitCompletionBundle(raw: Record<string, unknown>): SubmitCompletionBundleAction {
	const bundle = isRecord(raw.bundle) ? raw.bundle : raw;
	const parseArray = <T>(value: unknown, field: string, parser: (item: Record<string, unknown>, index: number) => T): T[] => {
		if (!Array.isArray(value)) throw new ActionValidationError(`${field} must be an array`);
		return value.map((item, index) => {
			if (!isRecord(item)) throw new ActionValidationError(`${field}[${index}] must be an object`);
			return parser(item, index);
		});
	};
	const digest = (value: unknown, field: string): string => {
		const parsed = requiredString(value, field);
		if (!/^[0-9a-f]{64}$/.test(parsed)) throw new ActionValidationError(`${field} must be a lowercase sha256 digest`);
		return parsed;
	};
	const artifacts = parseArray(bundle.artifacts, "bundle.artifacts", (item, index) => {
		const sizeBytes = finiteNonNegative(item.sizeBytes, Number.NaN, `bundle.artifacts[${index}].sizeBytes`);
		if (!Number.isInteger(sizeBytes)) throw new ActionValidationError(`bundle.artifacts[${index}].sizeBytes must be an integer`);
		const mediaType = optionalString(item.mediaType, `bundle.artifacts[${index}].mediaType`);
		return {
			id: requiredString(item.id, `bundle.artifacts[${index}].id`),
			uri: requiredString(item.uri, `bundle.artifacts[${index}].uri`),
			digest: digest(item.digest, `bundle.artifacts[${index}].digest`),
			sizeBytes,
			...(mediaType === undefined ? {} : { mediaType }),
		};
	});
	const evidence = parseArray(bundle.evidence, "bundle.evidence", (item, index) => {
		const artifactId = optionalString(item.artifactId, `bundle.evidence[${index}].artifactId`);
		const evidenceDigest = item.digest === undefined ? undefined : digest(item.digest, `bundle.evidence[${index}].digest`);
		return {
			id: requiredString(item.id, `bundle.evidence[${index}].id`),
			kind: enumValue(item.kind, new Set(["source", "artifact", "command", "tool_result", "observation", "user_confirmation"] as const), `bundle.evidence[${index}].kind`),
			summary: requiredString(item.summary, `bundle.evidence[${index}].summary`),
			criterionIds: stringArray(item.criterionIds, `bundle.evidence[${index}].criterionIds`),
			claimIds: stringArray(item.claimIds, `bundle.evidence[${index}].claimIds`),
			...(artifactId === undefined ? {} : { artifactId }),
			...(evidenceDigest === undefined ? {} : { digest: evidenceDigest }),
		};
	});
	const deterministicChecks = parseArray(bundle.deterministicChecks ?? [], "bundle.deterministicChecks", (item, index) => ({
		id: requiredString(item.id, `bundle.deterministicChecks[${index}].id`),
		status: enumValue(item.status, new Set(["passed", "failed"] as const), `bundle.deterministicChecks[${index}].status`),
		summary: requiredString(item.summary, `bundle.deterministicChecks[${index}].summary`),
		evidenceIds: stringArray(item.evidenceIds, `bundle.deterministicChecks[${index}].evidenceIds`),
	}));
	const rawRef = bundle.reviewerResultRef;
	if (!isRecord(rawRef)) throw new ActionValidationError("bundle.reviewerResultRef must be an object");
	const reviewerResultRef: RoleResultRefInput = {
		resultId: requiredString(rawRef.resultId, "bundle.reviewerResultRef.resultId"),
		agentId: requiredString(rawRef.agentId, "bundle.reviewerResultRef.agentId"),
		role: requiredString(rawRef.role, "bundle.reviewerResultRef.role"),
		status: enumValue(rawRef.status, new Set(["completed"] as const), "bundle.reviewerResultRef.status"),
		digest: digest(rawRef.digest, "bundle.reviewerResultRef.digest"),
	};
	return {
		action: "submit_completion_bundle",
		idempotencyKey: requiredString(bundle.idempotencyKey, "bundle.idempotencyKey"),
		summary: requiredString(bundle.summary, "bundle.summary"),
		artifacts,
		evidence,
		deterministicChecks,
		reviewerResultRef,
	};
}

const DEVIATION_MAX = { description: 500, reason: 1000, impact: 500, subjectId: 100 } as const;

function boundedString(value: unknown, field: string, max: number): string {
	const parsed = requiredString(value, field);
	if (parsed.length > max) throw new ActionValidationError(`${field} must be at most ${max} characters`);
	return parsed;
}

function parseRecordDeviation(raw: Record<string, unknown>): RecordDeviationAction {
	const subjectId = raw.subjectId === undefined
		? undefined
		: boundedString(raw.subjectId, "subjectId", DEVIATION_MAX.subjectId);
	const impact = raw.impact === undefined
		? undefined
		: boundedString(raw.impact, "impact", DEVIATION_MAX.impact);
	return {
		action: "record_deviation",
		...(subjectId === undefined ? {} : { subjectId }),
		description: boundedString(raw.description, "description", DEVIATION_MAX.description),
		reason: boundedString(raw.reason, "reason", DEVIATION_MAX.reason),
		...(impact === undefined ? {} : { impact }),
	};
}

/** Normalize one atomic update_goal mutation. Multiple action families are rejected before parsing. */
export function normalizeUpdateGoalAction(
	value: unknown,
	options: NormalizeUpdateGoalActionOptions,
): NormalizeUpdateGoalActionResult {
	if (!isRecord(value)) return { ok: false, kind: "invalid", reason: "update_goal input must be an object" };
	if (!Number.isFinite(options.now) || options.now < 0) return { ok: false, kind: "invalid", reason: "options.now must be non-negative" };
	if (value.action !== undefined && (typeof value.action !== "string" || !ACTIONS.has(value.action as UpdateGoalActionName))) {
		return { ok: false, kind: "invalid", reason: `Unknown update_goal action: ${String(value.action)}` };
	}
	// A canonical discriminator is authoritative. Some model/tool-schema stacks
	// materialize unrelated optional properties with empty/default values; inferring
	// action families from those fields turns one valid mutation into a false
	// mixed-action error. Legacy inputs without `action` still use inference.
	const inferred = typeof value.action === "string"
		? inferredActions(withoutSchemaDefaultNoise(value))
		: inferredActions(value);
	if (inferred.size > 1) {
		return {
			ok: false,
			kind: "mixed_action",
			reason: `update_goal accepts exactly one action; received ${[...inferred].sort().join(", ")}`,
		};
	}
	const action = [...inferred][0];
	if (!action) return { ok: false, kind: "invalid", reason: "No update_goal action was provided" };
	try {
		const normalized = parseAction(value, action, options.now);
		const legacy = value.action === undefined;
		return {
			ok: true,
			action: normalized,
			legacy,
			warnings: legacy ? ["Legacy flat update_goal input was normalized to one V2 action."] : [],
		};
	} catch (error) {
		return { ok: false, kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}
