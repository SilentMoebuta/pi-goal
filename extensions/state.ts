import { createHash } from "node:crypto";
import { parseBlueprint, type HeadlessBlueprint } from "./spec-doc";
import {
	parseGoalCompletionCommitV3,
	parseGoalRuntimeMetadataV3,
	type GoalCompletionCommitV3,
	type GoalRuntimeMetadataV3,
} from "./goal-contract-v3";

export const GOAL_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const SHADOW_COMPLETION_ADVISORY = "completionPolicy=shadow: this evaluation is durable audit data but was not authoritative for completion.";

// Central task vocabulary shared by interactive, headless, compiler, and eval adapters.
export const TASK_KINDS = ["general", "coding", "research", "document", "business", "pm", "review"] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type Topology = "direct" | "specialist" | "team";
export type ExecutionPreference = "auto" | Topology;
export type GateLevel = "blocking" | "advisory";
export type ExecutionReassessmentTrigger = "scope_expanded" | "new_workstream" | "conflict" | "stalled";

// Compatibility aliases for modules written against the initial V2 prototype.
export type GoalTaskTypeV2 = TaskKind;
export type ExecutionModeV2 = Topology;
export type ExecutionPreferenceV2 = ExecutionPreference;

export type GoalStatusV2 =
	| "active"
	| "paused"
	| "budget_limited"
	| "usage_limited"
	| "blocked"
	| "complete"
	| "unmet";

export interface ExecutionDecision {
	preference: ExecutionPreference;
	selected: Topology;
	role?: string;
	source: "auto" | "user" | "legacy";
	/** Confidence is normalized to the inclusive [0, 1] range. */
	confidence: number;
	reasons: string[];
	minimum?: "specialist";
	/** Semantic events which should trigger a fresh routing decision. */
	reassessOn: ExecutionReassessmentTrigger[];
}

export type GoalExecutionV2 = ExecutionDecision;

export type EvidenceKind =
	| "source"
	| "artifact"
	| "command"
	| "tool_result"
	| "observation"
	| "user_confirmation"
	| "legacy_text";
export type EvidenceSourceKind = "primary" | "secondary" | "workspace" | "user";
export type EvidenceOrigin = "tool" | "agent" | "user" | "legacy";
export type EvidenceVerification = "unverified" | "verified" | "rejected";

/** Canonical goal-wide evidence ledger entry. */
export interface EvidenceRef {
	id: string;
	kind: EvidenceKind;
	summary: string;
	locator?: string;
	sourceKind?: EvidenceSourceKind;
	/** Mirrors or derivatives of one origin share an independence key. */
	independenceKey?: string;
	excerpt?: string;
	recordedAt: number;
	origin: EvidenceOrigin;
	verification: EvidenceVerification;
	/** 机械验证失败的原因（Proof-or-Stop：artifact 证据由文件系统校验）。 */
	verificationNote?: string;
}

/** Compatibility view for the initial embedded-evidence prototype. */
export type EvidenceKindV2 = Exclude<EvidenceKind, "command">;
export interface EvidenceRecordV2 {
	id: string;
	kind: EvidenceKindV2;
	summary: string;
	locator?: string;
	sourceKind?: EvidenceSourceKind;
	independenceKey?: string;
	origin: EvidenceOrigin;
	recordedAt: number;
	verification: EvidenceVerification;
}

export interface EvidencePolicyV2 {
	mode: "adaptive";
	requiredKinds: EvidenceKindV2[];
	corroboration: "none" | "high_risk_only" | "required";
}

/**
 * level/evidenceRefs are canonical. evidence/evidencePolicy remain as a bounded
 * compatibility view until index.ts no longer consumes embedded evidence.
 */
export interface GoalCriterionV2 {
	id: string;
	description: string;
	level?: GateLevel;
	evidenceRefs?: string[];
	evidence: EvidenceRecordV2[];
	evidencePolicy?: EvidencePolicyV2;
}

export interface StoredGoalCriterionV2 extends GoalCriterionV2 {
	level: GateLevel;
	evidenceRefs: string[];
	evidence: EvidenceRecordV2[];
}

export interface ResearchClaim {
	id: string;
	text: string;
	materiality: "material" | "supporting";
	risk?: "ordinary" | "high";
	evidenceRefs: string[];
}

export type ReviewRequirement = "none" | "advisory" | "required";
export type ReviewStatus = "not_required" | "pending" | "passed" | "failed";

export interface AssuranceDecision {
	reviewRequirement: ReviewRequirement;
	reviewStatus: ReviewStatus;
	independent: boolean;
	depth: "light" | "standard" | "deep";
	source: "auto" | "user" | "legacy";
	reasons: string[];
	decidedAt: number;
}

export interface CriterionCoverage {
	criterionId: string;
	status: "satisfied" | "unsatisfied" | "blocked";
	evidenceRefs: string[];
	reason: string;
}

export interface ClaimCoverage {
	claimId: string;
	status: "sufficient" | "insufficient" | "conflicted";
	evidenceRefs: string[];
	reason: string;
}

export interface CompletionFinding {
	code: string;
	subjectId: string;
	reason: string;
	evidenceRefs?: string[];
	missingEvidenceKind?: EvidenceKind;
	/** Patch-first remediation metadata for document/report artifacts. */
	scope?: "local" | "section" | "global";
	targetPath?: string;
	sectionId?: string;
	anchor?: string;
	requiredFix?: string;
	rewriteRequired?: boolean;
	rewriteReason?: string;
}

export interface CompletionEvaluator {
	kind: "judge" | "reviewer" | "deterministic" | "legacy_reviewer";
	model?: string;
	agentId?: string;
	sessionId?: string;
	reportDigest?: string;
	// Retained only for V1 audit migration. Public views should omit paths.
	legacySessionFile?: string;
	legacyReportPath?: string;
}

export interface CompletionEvaluation {
	decision: "accept" | "revise" | "blocked";
	evaluatedAt: number;
	criterionCoverage: CriterionCoverage[];
	claimCoverage: ClaimCoverage[];
	findings: CompletionFinding[];
	advisories: string[];
	evaluator: CompletionEvaluator;
	fingerprint: string | null;
}

export type CompletionEvaluationV2 = CompletionEvaluation;

export interface GoalCompletionV2 {
	summary: string | null;
	requestedAt: number | null;
	lastEvaluation: CompletionEvaluation | null;
	/** Ordered fingerprints of rejected completion attempts. */
	rejectionHistory: string[];
	/** Consecutive repetitions of the current rejection fingerprint. */
	rejectionCount: number;
}

/** Durable semantic progress marker. Runtime activity such as tools, queues,
 * and ticker redraws deliberately lives outside the snapshot. */
export interface GoalOutcomeProgressV2 {
	outcomeRevision: number;
	lastOutcomeDeltaAt: number;
	/** Revision against which lastEvaluation was produced. A lower value means
	 * later evidence/claim/assurance changes require a fresh evaluation. */
	lastEvaluatedOutcomeRevision: number | null;
}

export interface GoalMigrationV2 {
	fromSchemaVersion: 1;
	warnings: string[];
}

/** 蓝图偏离记录（guided 模式信任机制：偏离不可怕，不报告的偏离才可怕）。 */
export interface DeviationRecord {
	id: string;
	/** 可空；指向 criterion/claim id 或蓝图节点 id。 */
	subjectId?: string;
	description: string;
	reason: string;
	/** 对验收标准的影响（无/部分/风险…）。 */
	impact?: string;
	recordedAt: number;
	origin: "agent" | "user";
}

/** headless 运行元数据（结果/日志写入路径）。 */
export interface GoalHeadlessMeta {
	specPath: string;
	outputPath: string;
	logPath: string;
	startedAt: number;
}

export interface GoalStateV2 {
	id: string;
	objective: string;
	status: GoalStatusV2;
	criteria: StoredGoalCriterionV2[];
	constraints: string[];
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedMs: number;
	createdAt: number;
	updatedAt: number;
	/** Terminal timestamp used to freeze wall-clock duration. */
	endedAt: number | null;
	noProgressCount: number;
	autoTurnCount: number;
	pausedReason: string | null;
	blocker: string | null;
	taskKind: TaskKind;
	execution: ExecutionDecision;
	evidenceLedger: EvidenceRef[];
	claims: ResearchClaim[];
	assurance: AssuranceDecision;
	completion: GoalCompletionV2;
	progress: GoalOutcomeProgressV2;
	/** 蓝图偏离账本（不入证据账本，避免污染 criterion 证据语义）。 */
	deviations: DeviationRecord[];
	/** Headless 蓝图（guided 模式：强指令 + 诊断期望）。 */
	blueprint?: HeadlessBlueprint;
	/** headless 运行元数据；仅 --goal-run 启动的 goal 携带。 */
	headless?: GoalHeadlessMeta;
	/** Optional Contract V3 lineage. Older V2 snapshots legitimately omit it. */
	runtime?: GoalRuntimeMetadataV3;
	/** Atomic V3 completion receipt. Its absence is valid for V1/V2 completions. */
	completionTransaction?: GoalCompletionCommitV3;
	migration: GoalMigrationV2 | null;
}

export type GoalSnapshotActionV2 = "set" | "update" | "clear" | "status" | "budget_limited" | "usage";

export interface GoalSnapshotV2 {
	schemaVersion: typeof GOAL_SNAPSHOT_SCHEMA_VERSION;
	revision: number;
	savedAt: number;
	action: GoalSnapshotActionV2;
	goal: GoalStateV2 | null;
}

export interface DecodeGoalSnapshotOptions {
	entryTimestamp?: number;
	legacyRevision?: number;
}

export type DecodeGoalSnapshotResult =
	| { ok: true; snapshot: GoalSnapshotV2; migratedFrom: 1 | null; warnings: string[] }
	| { ok: false; kind: "corrupt"; message: string; version?: number }
	| { ok: false; kind: "future_version"; message: string; version: number };

const GOAL_STATUSES = ["active", "paused", "budget_limited", "usage_limited", "blocked", "complete", "unmet"] as const;
const TOPOLOGIES = ["direct", "specialist", "team"] as const;
const EXECUTION_PREFERENCES = ["auto", ...TOPOLOGIES] as const;
const EXECUTION_REASSESSMENT_TRIGGERS = ["scope_expanded", "new_workstream", "conflict", "stalled"] as const;
const GATE_LEVELS = ["blocking", "advisory"] as const;
const EVIDENCE_KINDS = ["source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text"] as const;
const EMBEDDED_EVIDENCE_KINDS = ["source", "artifact", "tool_result", "observation", "user_confirmation", "legacy_text"] as const;
const SOURCE_KINDS = ["primary", "secondary", "workspace", "user"] as const;
const SNAPSHOT_ACTIONS = ["set", "update", "clear", "status", "budget_limited", "usage"] as const;

class SnapshotValidationError extends Error {}

function asObject(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SnapshotValidationError(path + " must be an object");
	return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
	if (typeof value !== "string") throw new SnapshotValidationError(path + " must be a string");
	return value;
}

function optionalString(value: unknown, path: string): string | undefined {
	return value === undefined ? undefined : asString(value, path);
}

function nullableString(value: unknown, path: string): string | null {
	return value === null ? null : asString(value, path);
}

function nullableNonNegative(value: unknown, path: string): number | null {
	return value === null ? null : finiteNonNegative(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new SnapshotValidationError(path + " must be a boolean");
	return value;
}

function finiteNonNegative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new SnapshotValidationError(path + " must be a finite non-negative number");
	}
	return value;
}

function integer(value: unknown, path: string): number {
	const result = finiteNonNegative(value, path);
	if (!Number.isInteger(result)) throw new SnapshotValidationError(path + " must be an integer");
	return result;
}

function confidence(value: unknown, path: string): number {
	const result = finiteNonNegative(value, path);
	if (result > 1) throw new SnapshotValidationError(path + " must be <= 1");
	return result;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new SnapshotValidationError(path + " has an unsupported value");
	return value as T;
}

function stringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new SnapshotValidationError(path + " must be an array");
	return value.map((item, index) => asString(item, `${path}[${index}]`));
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
	return value === undefined ? undefined : asEnum(value, allowed, path);
}

function parseEvidenceRef(value: unknown, path: string): EvidenceRef {
	const object = asObject(value, path);
	const locator = optionalString(object.locator, path + ".locator");
	const sourceKind = optionalEnum(object.sourceKind, SOURCE_KINDS, path + ".sourceKind");
	const independenceKey = optionalString(object.independenceKey, path + ".independenceKey");
	const excerpt = optionalString(object.excerpt, path + ".excerpt");
	return {
		id: asString(object.id, path + ".id"),
		kind: asEnum(object.kind, EVIDENCE_KINDS, path + ".kind"),
		summary: asString(object.summary, path + ".summary"),
		...(locator === undefined ? {} : { locator }),
		...(sourceKind === undefined ? {} : { sourceKind }),
		...(independenceKey === undefined ? {} : { independenceKey }),
		...(excerpt === undefined ? {} : { excerpt }),
		recordedAt: finiteNonNegative(object.recordedAt, path + ".recordedAt"),
		origin: asEnum(object.origin, ["tool", "agent", "user", "legacy"] as const, path + ".origin"),
		verification: asEnum(object.verification, ["unverified", "verified", "rejected"] as const, path + ".verification"),
	};
}

function parseEmbeddedEvidence(value: unknown, path: string): EvidenceRecordV2 {
	const object = asObject(value, path);
	const locator = optionalString(object.locator, path + ".locator");
	const sourceKind = optionalEnum(object.sourceKind, SOURCE_KINDS, path + ".sourceKind");
	const independenceKey = optionalString(object.independenceKey, path + ".independenceKey");
	return {
		id: asString(object.id, path + ".id"),
		kind: asEnum(object.kind, EMBEDDED_EVIDENCE_KINDS, path + ".kind"),
		summary: asString(object.summary, path + ".summary"),
		...(locator === undefined ? {} : { locator }),
		...(sourceKind === undefined ? {} : { sourceKind }),
		...(independenceKey === undefined ? {} : { independenceKey }),
		origin: asEnum(object.origin, ["tool", "agent", "user", "legacy"] as const, path + ".origin"),
		recordedAt: finiteNonNegative(object.recordedAt, path + ".recordedAt"),
		verification: asEnum(object.verification, ["unverified", "verified", "rejected"] as const, path + ".verification"),
	};
}

function parseEvidencePolicy(value: unknown, path: string): EvidencePolicyV2 | undefined {
	if (value === undefined) return undefined;
	const object = asObject(value, path);
	if (object.mode !== "adaptive") throw new SnapshotValidationError(path + ".mode must be adaptive");
	if (!Array.isArray(object.requiredKinds)) throw new SnapshotValidationError(path + ".requiredKinds must be an array");
	return {
		mode: "adaptive",
		requiredKinds: object.requiredKinds.map((item, index) => asEnum(item, EMBEDDED_EVIDENCE_KINDS, `${path}.requiredKinds[${index}]`)),
		corroboration: asEnum(object.corroboration, ["none", "high_risk_only", "required"] as const, path + ".corroboration"),
	};
}

function parseCriterion(value: unknown, path: string): StoredGoalCriterionV2 {
	const object = asObject(value, path);
	if (!Array.isArray(object.evidence)) throw new SnapshotValidationError(path + ".evidence must be an array");
	const evidencePolicy = parseEvidencePolicy(object.evidencePolicy, path + ".evidencePolicy");
	return {
		id: asString(object.id, path + ".id"),
		description: asString(object.description, path + ".description"),
		level: asEnum(object.level, GATE_LEVELS, path + ".level"),
		evidenceRefs: stringArray(object.evidenceRefs, path + ".evidenceRefs"),
		evidence: object.evidence.map((item, index) => parseEmbeddedEvidence(item, `${path}.evidence[${index}]`)),
		...(evidencePolicy === undefined ? {} : { evidencePolicy }),
	};
}

function parseClaim(value: unknown, path: string): ResearchClaim {
	const object = asObject(value, path);
	const risk = optionalEnum(object.risk, ["ordinary", "high"] as const, path + ".risk");
	return {
		id: asString(object.id, path + ".id"),
		text: asString(object.text, path + ".text"),
		materiality: asEnum(object.materiality, ["material", "supporting"] as const, path + ".materiality"),
		...(risk === undefined ? {} : { risk }),
		evidenceRefs: stringArray(object.evidenceRefs, path + ".evidenceRefs"),
	};
}

function parseExecution(value: unknown, path: string): ExecutionDecision {
	const object = asObject(value, path);
	if (!Array.isArray(object.reassessOn)) throw new SnapshotValidationError(path + ".reassessOn must be an array");
	const role = optionalString(object.role, path + ".role");
	const minimum = optionalEnum(object.minimum, ["specialist"] as const, path + ".minimum");
	return {
		preference: asEnum(object.preference, EXECUTION_PREFERENCES, path + ".preference"),
		selected: asEnum(object.selected, TOPOLOGIES, path + ".selected"),
		...(role === undefined ? {} : { role }),
		source: asEnum(object.source, ["auto", "user", "legacy"] as const, path + ".source"),
		confidence: confidence(object.confidence, path + ".confidence"),
		reasons: stringArray(object.reasons, path + ".reasons"),
		...(minimum === undefined ? {} : { minimum }),
		reassessOn: object.reassessOn.map((item, index) => asEnum(
			item,
			EXECUTION_REASSESSMENT_TRIGGERS,
			`${path}.reassessOn[${index}]`,
		)),
	};
}

function parseAssurance(value: unknown, path: string): AssuranceDecision {
	const object = asObject(value, path);
	return {
		reviewRequirement: asEnum(object.reviewRequirement, ["none", "advisory", "required"] as const, path + ".reviewRequirement"),
		reviewStatus: asEnum(object.reviewStatus, ["not_required", "pending", "passed", "failed"] as const, path + ".reviewStatus"),
		independent: asBoolean(object.independent, path + ".independent"),
		depth: asEnum(object.depth, ["light", "standard", "deep"] as const, path + ".depth"),
		source: asEnum(object.source, ["auto", "user", "legacy"] as const, path + ".source"),
		reasons: stringArray(object.reasons, path + ".reasons"),
		decidedAt: finiteNonNegative(object.decidedAt, path + ".decidedAt"),
	};
}

function parseCriterionCoverage(value: unknown, path: string): CriterionCoverage {
	const object = asObject(value, path);
	return {
		criterionId: asString(object.criterionId, path + ".criterionId"),
		status: asEnum(object.status, ["satisfied", "unsatisfied", "blocked"] as const, path + ".status"),
		evidenceRefs: stringArray(object.evidenceRefs, path + ".evidenceRefs"),
		reason: asString(object.reason, path + ".reason"),
	};
}

function parseClaimCoverage(value: unknown, path: string): ClaimCoverage {
	const object = asObject(value, path);
	return {
		claimId: asString(object.claimId, path + ".claimId"),
		status: asEnum(object.status, ["sufficient", "insufficient", "conflicted"] as const, path + ".status"),
		evidenceRefs: stringArray(object.evidenceRefs, path + ".evidenceRefs"),
		reason: asString(object.reason, path + ".reason"),
	};
}

function parseFinding(value: unknown, path: string): CompletionFinding {
	const object = asObject(value, path);
	const missingEvidenceKind = optionalEnum(object.missingEvidenceKind, EVIDENCE_KINDS, path + ".missingEvidenceKind");
	const evidenceRefs = object.evidenceRefs === undefined ? undefined : stringArray(object.evidenceRefs, path + ".evidenceRefs");
	const scope = optionalEnum(object.scope, ["local", "section", "global"] as const, path + ".scope");
	const targetPath = optionalString(object.targetPath, path + ".targetPath");
	const sectionId = optionalString(object.sectionId, path + ".sectionId");
	const anchor = optionalString(object.anchor, path + ".anchor");
	const requiredFix = optionalString(object.requiredFix, path + ".requiredFix");
	const rewriteRequired = object.rewriteRequired === undefined ? undefined : asBoolean(object.rewriteRequired, path + ".rewriteRequired");
	const rewriteReason = optionalString(object.rewriteReason, path + ".rewriteReason");
	return {
		code: asString(object.code, path + ".code"),
		subjectId: asString(object.subjectId, path + ".subjectId"),
		reason: asString(object.reason, path + ".reason"),
		...(evidenceRefs === undefined ? {} : { evidenceRefs }),
		...(missingEvidenceKind === undefined ? {} : { missingEvidenceKind }),
		...(scope === undefined ? {} : { scope }),
		...(targetPath === undefined ? {} : { targetPath }),
		...(sectionId === undefined ? {} : { sectionId }),
		...(anchor === undefined ? {} : { anchor }),
		...(requiredFix === undefined ? {} : { requiredFix }),
		...(rewriteRequired === undefined ? {} : { rewriteRequired }),
		...(rewriteReason === undefined ? {} : { rewriteReason }),
	};
}

function parseEvaluator(value: unknown, path: string): CompletionEvaluator {
	const object = asObject(value, path);
	const optional = (key: keyof CompletionEvaluator): string | undefined => optionalString(object[key], path + "." + key);
	const model = optional("model");
	const agentId = optional("agentId");
	const sessionId = optional("sessionId");
	const reportDigest = optional("reportDigest");
	const legacySessionFile = optional("legacySessionFile");
	const legacyReportPath = optional("legacyReportPath");
	return {
		kind: asEnum(object.kind, ["judge", "reviewer", "deterministic", "legacy_reviewer"] as const, path + ".kind"),
		...(model === undefined ? {} : { model }),
		...(agentId === undefined ? {} : { agentId }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(reportDigest === undefined ? {} : { reportDigest }),
		...(legacySessionFile === undefined ? {} : { legacySessionFile }),
		...(legacyReportPath === undefined ? {} : { legacyReportPath }),
	};
}

function parseEvaluation(value: unknown, path: string): CompletionEvaluation {
	const object = asObject(value, path);
	if (!Array.isArray(object.criterionCoverage)) throw new SnapshotValidationError(path + ".criterionCoverage must be an array");
	if (!Array.isArray(object.claimCoverage)) throw new SnapshotValidationError(path + ".claimCoverage must be an array");
	if (!Array.isArray(object.findings)) throw new SnapshotValidationError(path + ".findings must be an array");
	return {
		decision: asEnum(object.decision, ["accept", "revise", "blocked"] as const, path + ".decision"),
		evaluatedAt: finiteNonNegative(object.evaluatedAt, path + ".evaluatedAt"),
		criterionCoverage: object.criterionCoverage.map((item, index) => parseCriterionCoverage(item, `${path}.criterionCoverage[${index}]`)),
		claimCoverage: object.claimCoverage.map((item, index) => parseClaimCoverage(item, `${path}.claimCoverage[${index}]`)),
		findings: object.findings.map((item, index) => parseFinding(item, `${path}.findings[${index}]`)),
		advisories: stringArray(object.advisories, path + ".advisories"),
		evaluator: parseEvaluator(object.evaluator, path + ".evaluator"),
		fingerprint: nullableString(object.fingerprint, path + ".fingerprint"),
	};
}

function parseCompletion(value: unknown, path: string): GoalCompletionV2 {
	const object = asObject(value, path);
	return {
		summary: nullableString(object.summary, path + ".summary"),
		requestedAt: nullableNonNegative(object.requestedAt, path + ".requestedAt"),
		lastEvaluation: object.lastEvaluation === null ? null : parseEvaluation(object.lastEvaluation, path + ".lastEvaluation"),
		rejectionHistory: stringArray(object.rejectionHistory, path + ".rejectionHistory"),
		rejectionCount: integer(object.rejectionCount, path + ".rejectionCount"),
	};
}

function parseOutcomeProgress(
	value: unknown,
	path: string,
	fallback: {
		createdAt: number;
		endedAt: number | null;
		evidenceLedger: EvidenceRef[];
		assurance: AssuranceDecision;
		completion: GoalCompletionV2;
	},
): GoalOutcomeProgressV2 {
	if (value === undefined) {
		return {
			outcomeRevision: 0,
			lastOutcomeDeltaAt: Math.max(
				fallback.createdAt,
				fallback.endedAt ?? 0,
				fallback.assurance.decidedAt,
				fallback.completion.requestedAt ?? 0,
				fallback.completion.lastEvaluation?.evaluatedAt ?? 0,
				...fallback.evidenceLedger.map((item) => item.recordedAt),
			),
			// Older V2 snapshots did not persist an evaluation revision. Claims have
			// no mutation timestamp, so freshness cannot be reconstructed safely.
			lastEvaluatedOutcomeRevision: null,
		};
	}
	const object = asObject(value, path);
	const outcomeRevision = integer(object.outcomeRevision, path + ".outcomeRevision");
	const lastEvaluatedOutcomeRevision = object.lastEvaluatedOutcomeRevision === undefined
		? null
		: nullableNonNegative(object.lastEvaluatedOutcomeRevision, path + ".lastEvaluatedOutcomeRevision");
	if (lastEvaluatedOutcomeRevision !== null && (!Number.isInteger(lastEvaluatedOutcomeRevision) || lastEvaluatedOutcomeRevision > outcomeRevision)) {
		throw new SnapshotValidationError(path + ".lastEvaluatedOutcomeRevision must be a null integer no greater than outcomeRevision");
	}
	return {
		outcomeRevision,
		lastOutcomeDeltaAt: finiteNonNegative(object.lastOutcomeDeltaAt, path + ".lastOutcomeDeltaAt"),
		lastEvaluatedOutcomeRevision,
	};
}

function parseMigration(value: unknown, path: string): GoalMigrationV2 | null {
	if (value === null) return null;
	const object = asObject(value, path);
	if (object.fromSchemaVersion !== 1) throw new SnapshotValidationError(path + ".fromSchemaVersion must be 1");
	return { fromSchemaVersion: 1, warnings: stringArray(object.warnings, path + ".warnings") };
}

function parseDeviation(value: unknown, path: string): DeviationRecord {
	const object = asObject(value, path);
	const subjectId = optionalString(object.subjectId, path + ".subjectId");
	const impact = optionalString(object.impact, path + ".impact");
	return {
		id: asString(object.id, path + ".id"),
		...(subjectId === undefined ? {} : { subjectId }),
		description: asString(object.description, path + ".description"),
		reason: asString(object.reason, path + ".reason"),
		...(impact === undefined ? {} : { impact }),
		recordedAt: finiteNonNegative(object.recordedAt, path + ".recordedAt"),
		origin: asEnum(object.origin, ["agent", "user"] as const, path + ".origin"),
	};
}

function parseStoredBlueprint(value: unknown, path: string): HeadlessBlueprint {
	const parsed = parseBlueprint(value);
	if (!parsed.ok) {
		throw new SnapshotValidationError(path + " " + parsed.errors.join("; "));
	}
	return parsed.blueprint;
}

function parseHeadlessMeta(value: unknown, path: string): GoalHeadlessMeta {
	const object = asObject(value, path);
	return {
		specPath: asString(object.specPath, path + ".specPath"),
		outputPath: asString(object.outputPath, path + ".outputPath"),
		logPath: asString(object.logPath, path + ".logPath"),
		startedAt: finiteNonNegative(object.startedAt, path + ".startedAt"),
	};
}

function ensureUnique(values: readonly string[], path: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) throw new SnapshotValidationError(path + " contains duplicate id " + value);
		seen.add(value);
	}
}

function projectCanonicalEvidenceForEmbedding(canonical: EvidenceRef): EvidenceRecordV2 {
	// The embedded compatibility view cannot represent command or excerpt.
	const expectedKind: EvidenceKindV2 = canonical.kind === "command" ? "tool_result" : canonical.kind;
	return {
		id: canonical.id,
		kind: expectedKind,
		summary: canonical.summary,
		...(canonical.locator === undefined ? {} : { locator: canonical.locator }),
		...(canonical.sourceKind === undefined ? {} : { sourceKind: canonical.sourceKind }),
		...(canonical.independenceKey === undefined ? {} : { independenceKey: canonical.independenceKey }),
		origin: canonical.origin,
		recordedAt: canonical.recordedAt,
		verification: canonical.verification,
	};
}

function validateEmbeddedEvidence(
	record: EvidenceRecordV2,
	canonical: EvidenceRef,
	path: string,
): void {
	const fields: Array<keyof EvidenceRecordV2> = [
		"kind",
		"summary",
		"locator",
		"sourceKind",
		"independenceKey",
		"origin",
		"recordedAt",
		"verification",
	];
	const expected = projectCanonicalEvidenceForEmbedding(canonical);
	for (const field of fields) {
		if (record[field] !== expected[field]) {
			throw new SnapshotValidationError(`${path}.${field} conflicts with canonical evidence ${record.id}`);
		}
	}
}

function validateReferences(goal: GoalStateV2): void {
	ensureUnique(goal.criteria.map((item) => item.id), "snapshot.goal.criteria");
	ensureUnique(goal.evidenceLedger.map((item) => item.id), "snapshot.goal.evidenceLedger");
	ensureUnique(goal.claims.map((item) => item.id), "snapshot.goal.claims");
		const criteriaIds = new Set(goal.criteria.map((item) => item.id));
		const claimIds = new Set(goal.claims.map((item) => item.id));
		const isConstraintId = (id: string) => {
			const match = id.match(/^\$constraint:(\d+)$/);
			return Boolean(match && Number(match[1]) < goal.constraints.length);
		};
	const evidenceById = new Map(goal.evidenceLedger.map((item) => [item.id, item]));
	const assertRefs = (refs: readonly string[], path: string) => {
		for (const ref of refs) if (!evidenceById.has(ref)) throw new SnapshotValidationError(path + " references unknown evidence " + ref);
	};
	for (const criterion of goal.criteria) {
		assertRefs(criterion.evidenceRefs, `criterion ${criterion.id}`);
		ensureUnique(criterion.evidence.map((item) => item.id), `criterion ${criterion.id} embedded evidence`);
		for (const [index, record] of criterion.evidence.entries()) {
			const canonical = evidenceById.get(record.id);
			if (!canonical) {
				throw new SnapshotValidationError(`criterion ${criterion.id} embedded evidence references unknown canonical evidence ${record.id}`);
			}
			validateEmbeddedEvidence(record, canonical, `criterion ${criterion.id} embedded evidence[${index}]`);
		}
	}
	for (const claim of goal.claims) assertRefs(claim.evidenceRefs, `claim ${claim.id}`);
	const evaluation = goal.completion.lastEvaluation;
	if (evaluation) {
		for (const item of evaluation.criterionCoverage) {
				if (!criteriaIds.has(item.criterionId) && !isConstraintId(item.criterionId)) {
				throw new SnapshotValidationError("criterion coverage references unknown criterion " + item.criterionId);
			}
			assertRefs(item.evidenceRefs, `criterion coverage ${item.criterionId}`);
		}
		for (const item of evaluation.claimCoverage) {
			if (!claimIds.has(item.claimId)) {
				throw new SnapshotValidationError("claim coverage references unknown claim " + item.claimId);
			}
			assertRefs(item.evidenceRefs, `claim coverage ${item.claimId}`);
		}
		for (const finding of evaluation.findings) {
			const validSubject = finding.subjectId === "$goal"
					|| finding.subjectId === "$judge"
					|| criteriaIds.has(finding.subjectId)
					|| isConstraintId(finding.subjectId)
				|| claimIds.has(finding.subjectId);
			if (!validSubject) throw new SnapshotValidationError("completion finding references unknown subject " + finding.subjectId);
			assertRefs(finding.evidenceRefs ?? [], `completion finding ${finding.subjectId}`);
		}
	}
	if (goal.completion.rejectionCount > goal.completion.rejectionHistory.length) {
		throw new SnapshotValidationError("snapshot.goal.completion.rejectionCount exceeds rejectionHistory length");
	}
}

function validateSemanticConsistency(goal: GoalStateV2): void {
	const assurance = goal.assurance;
	if (goal.completionTransaction) {
		if (!goal.runtime) throw new SnapshotValidationError("snapshot.goal.completionTransaction requires runtime lineage");
		if (goal.status !== "complete") throw new SnapshotValidationError("snapshot.goal.completionTransaction requires complete status");
		const lineage = goal.completionTransaction.lineage;
		if (lineage.goalDefinitionId !== goal.runtime.goalDefinitionId
			|| lineage.revisionId !== goal.runtime.revisionId
			|| lineage.runId !== goal.runtime.runId
			|| lineage.attemptId !== goal.runtime.attemptId) {
			throw new SnapshotValidationError("snapshot.goal.completionTransaction lineage conflicts with runtime");
		}
		if (goal.endedAt !== null && goal.completionTransaction.committedAt > goal.endedAt) {
			throw new SnapshotValidationError("snapshot.goal.completionTransaction committedAt exceeds endedAt");
		}
	}
	if (assurance.reviewRequirement === "none") {
		if (assurance.reviewStatus !== "not_required") {
			throw new SnapshotValidationError("snapshot.goal.assurance.reviewStatus must be not_required when reviewRequirement is none");
		}
		if (assurance.independent) {
			throw new SnapshotValidationError("snapshot.goal.assurance.independent must be false when reviewRequirement is none");
		}
	} else {
		if (assurance.reviewStatus === "not_required") {
			throw new SnapshotValidationError("snapshot.goal.assurance.reviewStatus cannot be not_required when review is advisory or required");
		}
		if (!assurance.independent) {
			throw new SnapshotValidationError("snapshot.goal.assurance.independent must be true when review is advisory or required");
		}
	}

	const evaluation = goal.completion.lastEvaluation;
	if (!evaluation && goal.progress.lastEvaluatedOutcomeRevision !== null) {
		throw new SnapshotValidationError("snapshot.goal.progress.lastEvaluatedOutcomeRevision requires a completion evaluation");
	}
	if (evaluation?.decision === "accept") {
		if (evaluation.findings.length > 0) {
			throw new SnapshotValidationError("snapshot.goal.completion accepted evaluation cannot contain blocking findings");
		}
		if (evaluation.fingerprint !== null) {
			throw new SnapshotValidationError("snapshot.goal.completion accepted evaluation fingerprint must be null");
		}
	}

	if (goal.status !== "complete" || goal.migration?.fromSchemaVersion === 1) return;
	if (goal.completion.requestedAt === null) {
		throw new SnapshotValidationError("snapshot.goal.completion.requestedAt is required for a native completed V2 goal");
	}
	if (!evaluation) {
		throw new SnapshotValidationError("snapshot.goal.completion.lastEvaluation is required for a native completed V2 goal");
	}
	const shadowCompatible = evaluation.advisories.includes(SHADOW_COMPLETION_ADVISORY);
	if (evaluation.decision !== "accept" && !shadowCompatible) {
		throw new SnapshotValidationError("snapshot.goal native completed V2 goal requires an accepted completion audit");
	}
	if (evaluation.evaluatedAt < goal.completion.requestedAt) {
		throw new SnapshotValidationError("snapshot.goal completion evaluation predates its completion request");
	}
	if (assurance.reviewRequirement === "required" && assurance.reviewStatus !== "passed") {
		throw new SnapshotValidationError("snapshot.goal required assurance must pass before native V2 completion");
	}
}

function parseGoalState(value: unknown, path: string): GoalStateV2 {
	const object = asObject(value, path);
	if (!Array.isArray(object.criteria)) throw new SnapshotValidationError(path + ".criteria must be an array");
	if (!Array.isArray(object.evidenceLedger)) throw new SnapshotValidationError(path + ".evidenceLedger must be an array");
	if (!Array.isArray(object.claims)) throw new SnapshotValidationError(path + ".claims must be an array");
	const tokenBudget = object.tokenBudget === null ? null : finiteNonNegative(object.tokenBudget, path + ".tokenBudget");
	const status = asEnum(object.status, GOAL_STATUSES, path + ".status");
	const endedAt = nullableNonNegative(object.endedAt, path + ".endedAt");
	const terminal = status === "complete" || status === "unmet" || status === "blocked";
	if (terminal !== (endedAt !== null)) {
		throw new SnapshotValidationError(path + ".endedAt must be set exactly for complete/unmet/blocked status");
	}
	const createdAt = finiteNonNegative(object.createdAt, path + ".createdAt");
	const updatedAt = finiteNonNegative(object.updatedAt, path + ".updatedAt");
	const evidenceLedger = object.evidenceLedger.map((item, index) => parseEvidenceRef(item, `${path}.evidenceLedger[${index}]`));
	const assurance = parseAssurance(object.assurance, path + ".assurance");
	const completion = parseCompletion(object.completion, path + ".completion");
	const deviations = object.deviations === undefined ? [] : (() => {
		if (!Array.isArray(object.deviations)) throw new SnapshotValidationError(path + ".deviations must be an array");
		return object.deviations.map((item, index) => parseDeviation(item, `${path}.deviations[${index}]`));
	})();
	const blueprint = object.blueprint === undefined ? undefined : parseStoredBlueprint(object.blueprint, path + ".blueprint");
	const headless = object.headless === undefined ? undefined : parseHeadlessMeta(object.headless, path + ".headless");
	const runtime = object.runtime === undefined ? undefined : (() => {
		try { return parseGoalRuntimeMetadataV3(object.runtime, path + ".runtime"); }
		catch (error) { throw new SnapshotValidationError(error instanceof Error ? error.message : String(error)); }
	})();
	const completionTransaction = object.completionTransaction === undefined ? undefined : (() => {
		try { return parseGoalCompletionCommitV3(object.completionTransaction, path + ".completionTransaction"); }
		catch (error) { throw new SnapshotValidationError(error instanceof Error ? error.message : String(error)); }
	})();
	const goal: GoalStateV2 = {
		id: asString(object.id, path + ".id"),
		objective: asString(object.objective, path + ".objective"),
		status,
		criteria: object.criteria.map((item, index) => parseCriterion(item, `${path}.criteria[${index}]`)),
		constraints: stringArray(object.constraints, path + ".constraints"),
		tokenBudget,
		tokensUsed: finiteNonNegative(object.tokensUsed, path + ".tokensUsed"),
		timeUsedMs: finiteNonNegative(object.timeUsedMs, path + ".timeUsedMs"),
		createdAt,
		updatedAt,
		endedAt,
		noProgressCount: integer(object.noProgressCount, path + ".noProgressCount"),
		autoTurnCount: integer(object.autoTurnCount, path + ".autoTurnCount"),
		pausedReason: nullableString(object.pausedReason, path + ".pausedReason"),
		blocker: nullableString(object.blocker, path + ".blocker"),
		taskKind: asEnum(object.taskKind, TASK_KINDS, path + ".taskKind"),
		execution: parseExecution(object.execution, path + ".execution"),
		evidenceLedger,
		claims: object.claims.map((item, index) => parseClaim(item, `${path}.claims[${index}]`)),
		assurance,
		completion,
		progress: parseOutcomeProgress(object.progress, path + ".progress", { createdAt, endedAt, evidenceLedger, assurance, completion }),
		deviations,
		...(blueprint === undefined ? {} : { blueprint }),
		...(headless === undefined ? {} : { headless }),
		...(runtime === undefined ? {} : { runtime }),
		...(completionTransaction === undefined ? {} : { completionTransaction }),
		migration: parseMigration(object.migration, path + ".migration"),
	};
	if (goal.progress.lastOutcomeDeltaAt < goal.createdAt || goal.progress.lastOutcomeDeltaAt > goal.updatedAt) {
		throw new SnapshotValidationError(path + ".progress.lastOutcomeDeltaAt must be between createdAt and updatedAt");
	}
	validateReferences(goal);
	validateSemanticConsistency(goal);
	return goal;
}

function parseSnapshotV2(value: unknown): GoalSnapshotV2 {
	const object = asObject(value, "snapshot");
	if (object.schemaVersion !== GOAL_SNAPSHOT_SCHEMA_VERSION) throw new SnapshotValidationError("snapshot.schemaVersion must be 2");
	const action = asEnum(object.action, SNAPSHOT_ACTIONS, "snapshot.action");
	const goal = object.goal === null ? null : parseGoalState(object.goal, "snapshot.goal");
	if ((action === "clear") !== (goal === null)) throw new SnapshotValidationError("snapshot.clear action and null goal must agree");
	return {
		schemaVersion: GOAL_SNAPSHOT_SCHEMA_VERSION,
		revision: integer(object.revision, "snapshot.revision"),
		savedAt: finiteNonNegative(object.savedAt, "snapshot.savedAt"),
		action,
		goal,
	};
}

/** Exact legacy ID for the common case; collision suffixes are added by migration only when needed. */
export function stableLegacyEvidenceId(criterionId: string, index: number, _text?: string): string {
	return `legacy:${criterionId}:${index}`;
}

function allocateLegacyEvidenceId(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let suffix = 2;
	while (used.has(`${base}:dup${suffix}`)) suffix += 1;
	const allocated = `${base}:dup${suffix}`;
	used.add(allocated);
	return allocated;
}

function migrateLegacyExecution(object: Record<string, unknown>, warnings: string[]): ExecutionDecision {
	const legacyMode = object.executionMode;
	if (legacyMode !== undefined && legacyMode !== "single" && legacyMode !== "orchestrated") {
		throw new SnapshotValidationError("snapshot.goal.executionMode has an unsupported value");
	}
	if (legacyMode === "orchestrated") {
		warnings.push("Legacy orchestrated mode migrated to auto routing with specialist as the minimum topology.");
		return {
			preference: "auto",
			selected: "specialist",
			source: "legacy",
			confidence: 0.5,
			reasons: ["V1 orchestrated required delegated execution but did not distinguish specialist from team."],
			minimum: "specialist",
			reassessOn: ["scope_expanded", "new_workstream", "stalled"],
		};
	}
	if (legacyMode === undefined) warnings.push("Missing legacy executionMode migrated to direct.");
	return {
		preference: "direct",
		selected: "direct",
		source: "legacy",
		confidence: 1,
		reasons: [legacyMode === "single" ? "V1 explicitly selected single-agent execution." : "V1 defaulted missing executionMode to direct execution."],
		reassessOn: ["scope_expanded", "stalled"],
	};
}

function legacyReviewerPassed(object: Record<string, unknown>): boolean {
	return object.reviewerPassed === undefined ? false : asBoolean(object.reviewerPassed, "snapshot.goal.reviewerPassed");
}

function migrateLegacyAssurance(object: Record<string, unknown>, taskKind: TaskKind, updatedAt: number): AssuranceDecision {
	const passed = legacyReviewerPassed(object);
	const required = taskKind !== "coding" && taskKind !== "general";
	return {
		reviewRequirement: required ? "required" : "none",
		reviewStatus: required ? (passed ? "passed" : "pending") : "not_required",
		independent: required,
		depth: required ? "deep" : "light",
		source: "legacy",
		reasons: [required
			? "V1 required independent review for explicit non-coding task types."
			: "V1 did not require independent review for coding-compatible goals."],
		decidedAt: updatedAt,
	};
}

function legacyFingerprint(goalId: string, updatedAt: number, decision: "accept" | "revise"): string | null {
	return decision === "accept"
		? null
		: createHash("sha256").update(`legacy-review\0${goalId}\0${updatedAt}\0${decision}`).digest("hex");
}

function migrateLegacyEvaluation(
	goal: Record<string, unknown>,
	goalId: string,
	criteria: StoredGoalCriterionV2[],
	updatedAt: number,
): CompletionEvaluation | null {
	const passed = legacyReviewerPassed(goal);
	const verdict = goal.reviewerVerdict === undefined ? null : asObject(goal.reviewerVerdict, "snapshot.goal.reviewerVerdict");
	if (!passed && verdict === null) return null;
	const notes = verdict === null ? undefined : optionalString(verdict.notes, "snapshot.goal.reviewerVerdict.notes");
	const model = verdict === null ? undefined : optionalString(verdict.model, "snapshot.goal.reviewerVerdict.model");
	const agentId = optionalString(goal.reviewerAgentId, "snapshot.goal.reviewerAgentId");
	const legacySessionFile = optionalString(goal.reviewerSessionFile, "snapshot.goal.reviewerSessionFile");
	const legacyReportPath = verdict === null ? undefined : optionalString(verdict.reportPath, "snapshot.goal.reviewerVerdict.reportPath");
	const decision = passed ? "accept" : "revise";
	const reason = notes ?? (passed ? "Migrated V1 reviewer approval." : "Migrated V1 reviewer rejection.");
	return {
		decision,
		evaluatedAt: updatedAt,
		criterionCoverage: criteria.map((criterion) => ({
			criterionId: criterion.id,
			status: criterion.evidenceRefs.length > 0 ? "satisfied" : "unsatisfied",
			evidenceRefs: [...criterion.evidenceRefs],
			reason: criterion.evidenceRefs.length > 0 ? "V1 recorded evidence text." : "V1 recorded no evidence.",
		})),
		claimCoverage: [],
		findings: passed ? [] : [{ code: "legacy_reviewer_rejected", subjectId: "$goal", reason }],
		advisories: ["This evaluation used the legacy completion policy and must not satisfy a new V2 completion request."],
		evaluator: {
			kind: "legacy_reviewer",
			...(model === undefined ? {} : { model }),
			...(agentId === undefined ? {} : { agentId }),
			...(legacySessionFile === undefined ? {} : { legacySessionFile }),
			...(legacyReportPath === undefined ? {} : { legacyReportPath }),
		},
		fingerprint: legacyFingerprint(goalId, updatedAt, decision),
	};
}

function migrateLegacyGoal(value: unknown): { goal: GoalStateV2; warnings: string[] } {
	const object = asObject(value, "snapshot.goal");
	const id = asString(object.id, "snapshot.goal.id");
	const objective = asString(object.objective, "snapshot.goal.objective");
	const status = asEnum(object.status, GOAL_STATUSES, "snapshot.goal.status");
	if (!Array.isArray(object.criteria)) throw new SnapshotValidationError("snapshot.goal.criteria must be an array");
	const constraints = stringArray(object.constraints, "snapshot.goal.constraints");
	const tokenBudget = object.tokenBudget === null ? null : finiteNonNegative(object.tokenBudget, "snapshot.goal.tokenBudget");
	const tokensUsed = finiteNonNegative(object.tokensUsed, "snapshot.goal.tokensUsed");
	const timeUsedMs = finiteNonNegative(object.timeUsedMs, "snapshot.goal.timeUsedMs");
	const createdAt = finiteNonNegative(object.createdAt, "snapshot.goal.createdAt");
	const updatedAt = finiteNonNegative(object.updatedAt, "snapshot.goal.updatedAt");
	const endedAt = status === "complete" || status === "unmet" || status === "blocked" ? updatedAt : null;
	const noProgressCount = integer(object.noProgressCount, "snapshot.goal.noProgressCount");
	const autoTurnCount = integer(object.autoTurnCount, "snapshot.goal.autoTurnCount");
	const pausedReason = nullableString(object.pausedReason, "snapshot.goal.pausedReason");
	const blocker = nullableString(object.blocker, "snapshot.goal.blocker");
	const warnings: string[] = [];
	let taskKind: TaskKind;
	if (object.taskType === undefined) {
		taskKind = "coding";
		warnings.push("Missing legacy taskType preserved as coding, matching V1 runtime semantics.");
	} else {
		taskKind = asEnum(object.taskType, TASK_KINDS, "snapshot.goal.taskType");
	}

	const usedEvidenceIds = new Set<string>();
	const evidenceLedger: EvidenceRef[] = [];
	const criteria: StoredGoalCriterionV2[] = object.criteria.map((rawCriterion, criterionIndex) => {
		const criterion = asObject(rawCriterion, `snapshot.goal.criteria[${criterionIndex}]`);
		const criterionId = asString(criterion.id, `snapshot.goal.criteria[${criterionIndex}].id`);
		const description = asString(criterion.description, `snapshot.goal.criteria[${criterionIndex}].description`);
		if (!Array.isArray(criterion.evidence)) throw new SnapshotValidationError(`snapshot.goal.criteria[${criterionIndex}].evidence must be an array`);
		const embedded: EvidenceRecordV2[] = [];
		const evidenceRefs: string[] = [];
		for (const [evidenceIndex, rawEvidence] of criterion.evidence.entries()) {
			const summary = asString(rawEvidence, `snapshot.goal.criteria[${criterionIndex}].evidence[${evidenceIndex}]`);
			const evidenceId = allocateLegacyEvidenceId(stableLegacyEvidenceId(criterionId, evidenceIndex), usedEvidenceIds);
			evidenceRefs.push(evidenceId);
			const canonical: EvidenceRef = {
				id: evidenceId,
				kind: "legacy_text",
				summary,
				excerpt: summary,
				recordedAt: updatedAt,
				origin: "legacy",
				verification: "unverified",
			};
			evidenceLedger.push(canonical);
			embedded.push(projectCanonicalEvidenceForEmbedding(canonical));
		}
		return {
			id: criterionId,
			description,
			level: "blocking",
			evidenceRefs,
			evidence: embedded,
			evidencePolicy: { mode: "adaptive", requiredKinds: [], corroboration: "high_risk_only" },
		};
	});
	if (evidenceLedger.length > 0) warnings.push("Legacy string evidence was preserved in the V2 evidence ledger as unverified legacy_text.");

	const completionSummary = object.completionEvidence === undefined ? null : nullableString(object.completionEvidence, "snapshot.goal.completionEvidence");
	const lastEvaluation = migrateLegacyEvaluation(object, id, criteria, updatedAt);
	const rejected = lastEvaluation?.decision === "revise" || lastEvaluation?.decision === "blocked";
	const rejectionHistory = rejected && lastEvaluation.fingerprint ? [lastEvaluation.fingerprint] : [];
	const goal: GoalStateV2 = {
		id,
		objective,
		status,
		criteria,
		constraints,
		tokenBudget,
		tokensUsed,
		timeUsedMs,
		createdAt,
		updatedAt,
		endedAt,
		noProgressCount,
		autoTurnCount,
		pausedReason,
		blocker,
		taskKind,
		execution: migrateLegacyExecution(object, warnings),
		evidenceLedger,
		claims: [],
		assurance: migrateLegacyAssurance(object, taskKind, updatedAt),
		completion: {
			summary: completionSummary,
			requestedAt: status === "complete" ? updatedAt : null,
			lastEvaluation,
			rejectionHistory,
			rejectionCount: rejectionHistory.length,
		},
		progress: { outcomeRevision: 0, lastOutcomeDeltaAt: updatedAt, lastEvaluatedOutcomeRevision: lastEvaluation ? 0 : null },
		deviations: [],
		migration: { fromSchemaVersion: 1, warnings: [...warnings] },
	};
	validateReferences(goal);
	validateSemanticConsistency(goal);
	return { goal, warnings };
}

function migrateSnapshotV1(value: unknown, options: DecodeGoalSnapshotOptions): DecodeGoalSnapshotResult {
	try {
		const object = asObject(value, "snapshot");
		const action = asEnum(object.action, ["set", "update", "clear", "status", "budget_limited"] as const, "snapshot.action");
		if (!("goal" in object)) throw new SnapshotValidationError("snapshot.goal is required");
		const revision = options.legacyRevision === undefined ? 0 : integer(options.legacyRevision, "options.legacyRevision");
		if (object.goal === null) {
			if (action !== "clear") throw new SnapshotValidationError("V1 null goal requires clear action");
			const savedAt = options.entryTimestamp === undefined ? 0 : finiteNonNegative(options.entryTimestamp, "options.entryTimestamp");
			return { ok: true, snapshot: { schemaVersion: 2, revision, savedAt, action: "clear", goal: null }, migratedFrom: 1, warnings: [] };
		}
		if (action === "clear") throw new SnapshotValidationError("V1 clear action requires null goal");
		const migrated = migrateLegacyGoal(object.goal);
		const savedAt = options.entryTimestamp === undefined ? migrated.goal.updatedAt : finiteNonNegative(options.entryTimestamp, "options.entryTimestamp");
		return {
			ok: true,
			snapshot: { schemaVersion: 2, revision, savedAt, action, goal: migrated.goal },
			migratedFrom: 1,
			warnings: [...migrated.warnings],
		};
	} catch (error) {
		return { ok: false, kind: "corrupt", message: error instanceof Error ? error.message : String(error), version: 1 };
	}
}

/** Decode the latest pi-goal custom entry. Invalid/future data must not fall back to an older goal. */
export function decodeGoalSnapshot(value: unknown, options: DecodeGoalSnapshotOptions = {}): DecodeGoalSnapshotResult {
	let object: Record<string, unknown>;
	try {
		object = asObject(value, "snapshot");
	} catch (error) {
		return { ok: false, kind: "corrupt", message: error instanceof Error ? error.message : String(error) };
	}
	const rawVersion = object.schemaVersion;
	if (rawVersion === undefined || rawVersion === 1) return migrateSnapshotV1(object, options);
	if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
		return { ok: false, kind: "corrupt", message: "snapshot.schemaVersion must be a positive integer" };
	}
	if (rawVersion > GOAL_SNAPSHOT_SCHEMA_VERSION) {
		return {
			ok: false,
			kind: "future_version",
			version: rawVersion,
			message: `Unsupported pi-goal snapshot version ${rawVersion}; current version is ${GOAL_SNAPSHOT_SCHEMA_VERSION}.`,
		};
	}
	try {
		return { ok: true, snapshot: parseSnapshotV2(object), migratedFrom: null, warnings: [] };
	} catch (error) {
		return {
			ok: false,
			kind: "corrupt",
			version: GOAL_SNAPSHOT_SCHEMA_VERSION,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Validate and deep-clone a V2 snapshot before appendEntry or public reuse. */
export function cloneGoalSnapshotV2(snapshot: GoalSnapshotV2): GoalSnapshotV2 {
	const decoded = decodeGoalSnapshot(snapshot);
	if (!decoded.ok || decoded.migratedFrom !== null) {
		throw new SnapshotValidationError(decoded.ok ? "Expected a native V2 snapshot" : decoded.message);
	}
	return decoded.snapshot;
}

export function createGoalSnapshotV2(input: Omit<GoalSnapshotV2, "schemaVersion">): GoalSnapshotV2 {
	return cloneGoalSnapshotV2({ schemaVersion: GOAL_SNAPSHOT_SCHEMA_VERSION, ...input });
}

export interface CreateGoalStateV2Input {
	id: string;
	objective: string;
	criteria: Array<{ id: string; description: string; level?: GateLevel }>;
	constraints?: string[];
	taskKind: TaskKind;
	execution: ExecutionDecision;
	assurance: AssuranceDecision;
	tokenBudget?: number | null;
	/** Headless 蓝图（guided 模式）。 */
	blueprint?: HeadlessBlueprint;
	/** headless 运行元数据。 */
	headless?: GoalHeadlessMeta;
	/** Contract V3 lineage projection shared by interactive and headless adapters. */
	runtime?: GoalRuntimeMetadataV3;
	/** Existing atomic completion receipt, primarily for fixture construction. */
	completionTransaction?: GoalCompletionCommitV3;
	now: number;
}

/** Deterministic factory for new goals; callers own ID generation and routing decisions. */
export function createGoalStateV2(input: CreateGoalStateV2Input): GoalStateV2 {
	const raw: GoalStateV2 = {
		id: input.id,
		objective: input.objective,
		status: "active",
		criteria: input.criteria.map((criterion) => ({
			id: criterion.id,
			description: criterion.description,
			level: criterion.level ?? "blocking",
			evidenceRefs: [],
			evidence: [],
		})),
		constraints: [...(input.constraints ?? [])],
		tokenBudget: input.tokenBudget ?? null,
		tokensUsed: 0,
		timeUsedMs: 0,
		createdAt: input.now,
		updatedAt: input.now,
		endedAt: null,
		noProgressCount: 0,
		autoTurnCount: 0,
		pausedReason: null,
		blocker: null,
		taskKind: input.taskKind,
		execution: input.execution,
		evidenceLedger: [],
		claims: [],
		assurance: input.assurance,
		completion: { summary: null, requestedAt: null, lastEvaluation: null, rejectionHistory: [], rejectionCount: 0 },
		progress: { outcomeRevision: 0, lastOutcomeDeltaAt: input.now, lastEvaluatedOutcomeRevision: null },
		deviations: [],
		...(input.blueprint === undefined ? {} : { blueprint: input.blueprint }),
		...(input.headless === undefined ? {} : { headless: input.headless }),
		...(input.runtime === undefined ? {} : { runtime: input.runtime }),
		...(input.completionTransaction === undefined ? {} : { completionTransaction: input.completionTransaction }),
		migration: null,
	};
	return parseGoalState(raw, "goal");
}
