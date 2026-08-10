import { createHash } from "node:crypto";

export const GOAL_CONTRACT_VERSION = 3 as const;
export const GOAL_RUNTIME_METADATA_VERSION = 1 as const;

export type GoalEntrypoint = "interactive" | "headless" | "api";
export type GoalRevisionSource = "user" | "system" | "migration";
export type GoalRunStatus =
	| "created"
	| "active"
	| "waiting_user"
	| "waiting_approval"
	| "paused"
	| "retrying"
	| "completed"
	| "failed"
	| "cancelled"
	| "unmet";
export type GoalAttemptStatus = "active" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface GoalCriterionV3 {
	id: string;
	description: string;
	level: "blocking" | "advisory";
}

export interface GoalVerificationRuleV3 {
	id: string;
	kind: "deterministic" | "reviewer" | "human" | "dataset";
	required: boolean;
	description: string;
}

export interface GoalRiskPolicyV3 {
	level: "low" | "medium" | "high";
	requiredApprovals: string[];
}

export interface GoalBudgetV3 {
	tokens?: number;
	activeTimeMs?: number;
	deadlineAt?: number;
}

export interface GoalDefinitionV3 {
	contractVersion: typeof GOAL_CONTRACT_VERSION;
	id: string;
	objective: string;
	criteria: GoalCriterionV3[];
	constraints: string[];
	verification: GoalVerificationRuleV3[];
	risk: GoalRiskPolicyV3;
	budget: GoalBudgetV3;
	taskKind: string;
	profile?: string;
	createdAt: number;
}

export interface GoalRevisionV3 {
	id: string;
	goalDefinitionId: string;
	number: number;
	previousRevisionId: string | null;
	source: GoalRevisionSource;
	reason: string;
	definition: GoalDefinitionV3;
	createdAt: number;
}

export interface GoalRunV3 {
	id: string;
	goalDefinitionId: string;
	revisionId: string;
	entrypoint: GoalEntrypoint;
	status: GoalRunStatus;
	attemptIds: string[];
	currentAttemptId: string | null;
	parentRunId: string | null;
	previousRunId: string | null;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
}

export interface GoalAttemptV3 {
	id: string;
	runId: string;
	revisionId: string;
	number: number;
	previousAttemptId: string | null;
	status: GoalAttemptStatus;
	idempotencyKey: string;
	startedAt: number;
	endedAt: number | null;
}

export interface WorkflowNodeLineageV3 {
	nodeId: string;
	parentNodeId: string | null;
	previousNodeId: string | null;
	runId: string;
	attemptId: string;
}

/**
 * A compact V3 lineage projection that can live inside a V2 snapshot. It is
 * deliberately optional so old snapshots remain byte-for-byte decodable.
 */
export interface GoalRuntimeMetadataV3 {
	version: typeof GOAL_RUNTIME_METADATA_VERSION;
	contractVersion: typeof GOAL_CONTRACT_VERSION;
	goalDefinitionId: string;
	revisionId: string;
	revisionNumber: number;
	runId: string;
	attemptId: string;
	attemptNumber: number;
	entrypoint: GoalEntrypoint;
	parentRunId: string | null;
	previousRunId: string | null;
	previousAttemptId: string | null;
}

export type GoalErrorCode =
	| "rate_limit"
	| "capacity"
	| "network"
	| "provider_abort"
	| "worker_crash"
	| "timeout"
	| "schema_invalid"
	| "verification_failed"
	| "policy_denied"
	| "approval_required"
	| "waiting_for_user"
	| "budget_exhausted"
	| "cancelled"
	| "stale_revision"
	| "stale_artifact"
	| "invalid_transition"
	| "idempotency_conflict"
	| "internal";

export type GoalRecoveryAction = "retry_attempt" | "revise" | "wait_user" | "wait_approval" | "stop";

export interface GoalErrorV3 {
	code: GoalErrorCode;
	message: string;
	retryable: boolean;
	recovery: GoalRecoveryAction;
	details?: Record<string, unknown>;
	cause?: GoalErrorV3;
}

export type GoalResultV3<T> =
	| { ok: true; value: T; lineage: GoalLineageV3 }
	| { ok: false; error: GoalErrorV3; lineage?: GoalLineageV3 };

export interface GoalLineageV3 {
	goalDefinitionId: string;
	revisionId: string;
	runId: string;
	attemptId: string;
}

export interface GoalDigestV3 {
	algorithm: "sha256";
	value: string;
}

export interface GoalArtifactV3 {
	id: string;
	uri: string;
	digest: GoalDigestV3;
	sizeBytes: number;
	mediaType?: string;
	createdByAttemptId: string;
	createdAt: number;
	verifiedAt: number;
}

export interface GoalEvidenceV3 {
	id: string;
	kind: "source" | "artifact" | "command" | "tool_result" | "observation" | "user_confirmation";
	summary: string;
	criterionIds: string[];
	claimIds: string[];
	artifactId?: string;
	digest?: GoalDigestV3;
	verification: "verified" | "rejected";
	verifiedAt: number;
	createdByAttemptId: string;
}

export interface GoalEvaluationV3 {
	id: string;
	revisionId: string;
	runId: string;
	attemptId: string;
	decision: "accept" | "revise" | "blocked";
	evaluator: {
		kind: "deterministic" | "reviewer" | "human" | "dataset";
		id: string;
		independent: boolean;
	};
	criterionCoverage: Array<{
		criterionId: string;
		status: "satisfied" | "unsatisfied" | "blocked";
		evidenceIds: string[];
	}>;
	findings: Array<{
		id: string;
		code: string;
		severity: string;
		subjectId: string;
		reason: string;
		evidenceRefs: string[];
		missingEvidenceKind?: string;
	}>;
	advisories: string[];
	observedArtifacts: Array<{ artifactId: string; digest: GoalDigestV3 }>;
	evaluatedAt: number;
}

export interface GoalDeterministicCheckV3 {
	id: string;
	status: "passed" | "failed";
	summary: string;
	evidenceIds: string[];
	checkedAt: number;
}

export interface GoalCompletionBundleV3 {
	contractVersion: typeof GOAL_CONTRACT_VERSION;
	idempotencyKey: string;
	lineage: GoalLineageV3;
	summary: string;
	artifacts: GoalArtifactV3[];
	evidence: GoalEvidenceV3[];
	evaluation: GoalEvaluationV3;
	deterministicChecks: GoalDeterministicCheckV3[];
	submittedAt: number;
}

export interface CompletionBundleValidationIssue {
	path: string;
	code: "required" | "invalid" | "unknown_reference" | "lineage_mismatch" | "stale" | "unsatisfied";
	message: string;
}

export type CompletionBundleValidationResult =
	| { ok: true }
	| { ok: false; issues: CompletionBundleValidationIssue[] };

export interface CompletionTransitionV3 {
	run: GoalRunV3;
	attempt: GoalAttemptV3;
	bundle: GoalCompletionBundleV3;
	replayed: boolean;
}

export interface GoalCompletionCommitV3 {
	contractVersion: typeof GOAL_CONTRACT_VERSION;
	idempotencyKey: string;
	requestDigest: string;
	bundleDigest: string;
	lineage: GoalLineageV3;
	artifacts: GoalArtifactV3[];
	reviewerResultRef: {
		resultId: string;
		agentId: string;
		role: string;
		digest: string;
	};
	committedAt: number;
}

export interface GoalCompletionIntegrityV3 {
	status: "not_applicable" | "unchecked" | "current" | "stale";
	checkedAt: number | null;
	staleArtifacts: Array<{
		artifactId: string;
		uri: string;
		reason: "missing" | "not_file" | "unreadable" | "digest_mismatch" | "size_mismatch";
		expectedDigest: GoalDigestV3;
		actualDigest?: GoalDigestV3;
		expectedSizeBytes: number;
		actualSizeBytes?: number;
	}>;
}

export interface ApplyCompletionBundleInputV3 {
	definition: GoalDefinitionV3;
	revision: GoalRevisionV3;
	run: GoalRunV3;
	attempt: GoalAttemptV3;
	bundle: GoalCompletionBundleV3;
	existingBundle?: GoalCompletionBundleV3;
}

const ERROR_POLICIES: Record<GoalErrorCode, Pick<GoalErrorV3, "retryable" | "recovery">> = {
	rate_limit: { retryable: true, recovery: "retry_attempt" },
	capacity: { retryable: true, recovery: "retry_attempt" },
	network: { retryable: true, recovery: "retry_attempt" },
	provider_abort: { retryable: true, recovery: "retry_attempt" },
	worker_crash: { retryable: true, recovery: "retry_attempt" },
	timeout: { retryable: true, recovery: "retry_attempt" },
	schema_invalid: { retryable: false, recovery: "revise" },
	verification_failed: { retryable: false, recovery: "revise" },
	policy_denied: { retryable: false, recovery: "stop" },
	approval_required: { retryable: false, recovery: "wait_approval" },
	waiting_for_user: { retryable: false, recovery: "wait_user" },
	budget_exhausted: { retryable: false, recovery: "wait_user" },
	cancelled: { retryable: false, recovery: "stop" },
	stale_revision: { retryable: false, recovery: "revise" },
	stale_artifact: { retryable: false, recovery: "revise" },
	invalid_transition: { retryable: false, recovery: "stop" },
	idempotency_conflict: { retryable: false, recovery: "stop" },
	internal: { retryable: false, recovery: "stop" },
};

export function createGoalError(
	code: GoalErrorCode,
	message: string,
	options: { details?: Record<string, unknown>; cause?: GoalErrorV3; retryable?: boolean; recovery?: GoalRecoveryAction } = {},
): GoalErrorV3 {
	const policy = ERROR_POLICIES[code];
	return {
		code,
		message,
		retryable: options.retryable ?? policy.retryable,
		recovery: options.recovery ?? policy.recovery,
		...(options.details === undefined ? {} : { details: options.details }),
		...(options.cause === undefined ? {} : { cause: options.cause }),
	};
}

export function lineageOf(
	definition: GoalDefinitionV3,
	revision: GoalRevisionV3,
	run: GoalRunV3,
	attempt: GoalAttemptV3,
): GoalLineageV3 {
	return {
		goalDefinitionId: definition.id,
		revisionId: revision.id,
		runId: run.id,
		attemptId: attempt.id,
	};
}

export function createInitialRuntimeMetadataV3(input: {
	goalId: string;
	entrypoint: GoalEntrypoint;
	revisionId?: string;
	runId?: string;
	attemptId?: string;
}): GoalRuntimeMetadataV3 {
	const goalDefinitionId = requiredId(input.goalId, "goalId");
	return {
		version: GOAL_RUNTIME_METADATA_VERSION,
		contractVersion: GOAL_CONTRACT_VERSION,
		goalDefinitionId,
		revisionId: input.revisionId ?? `${goalDefinitionId}:revision:1`,
		revisionNumber: 1,
		runId: input.runId ?? `${goalDefinitionId}:run:1`,
		attemptId: input.attemptId ?? `${goalDefinitionId}:run:1:attempt:1`,
		attemptNumber: 1,
		entrypoint: input.entrypoint,
		parentRunId: null,
		previousRunId: null,
		previousAttemptId: null,
	};
}

export function parseGoalRuntimeMetadataV3(value: unknown, path = "runtime"): GoalRuntimeMetadataV3 {
	const object = asRecord(value, path);
	if (object.version !== GOAL_RUNTIME_METADATA_VERSION) throw new Error(`${path}.version must be ${GOAL_RUNTIME_METADATA_VERSION}`);
	if (object.contractVersion !== GOAL_CONTRACT_VERSION) throw new Error(`${path}.contractVersion must be ${GOAL_CONTRACT_VERSION}`);
	const revisionNumber = nonNegativeInteger(object.revisionNumber, `${path}.revisionNumber`);
	const attemptNumber = nonNegativeInteger(object.attemptNumber, `${path}.attemptNumber`);
	if (revisionNumber < 1) throw new Error(`${path}.revisionNumber must be >= 1`);
	if (attemptNumber < 1) throw new Error(`${path}.attemptNumber must be >= 1`);
	return {
		version: GOAL_RUNTIME_METADATA_VERSION,
		contractVersion: GOAL_CONTRACT_VERSION,
		goalDefinitionId: requiredId(object.goalDefinitionId, `${path}.goalDefinitionId`),
		revisionId: requiredId(object.revisionId, `${path}.revisionId`),
		revisionNumber,
		runId: requiredId(object.runId, `${path}.runId`),
		attemptId: requiredId(object.attemptId, `${path}.attemptId`),
		attemptNumber,
		entrypoint: enumValue(object.entrypoint, ["interactive", "headless", "api"] as const, `${path}.entrypoint`),
		parentRunId: nullableId(object.parentRunId, `${path}.parentRunId`),
		previousRunId: nullableId(object.previousRunId, `${path}.previousRunId`),
		previousAttemptId: nullableId(object.previousAttemptId, `${path}.previousAttemptId`),
	};
}

export function validateCompletionBundleV3(input: ApplyCompletionBundleInputV3): CompletionBundleValidationResult {
	const issues: CompletionBundleValidationIssue[] = [];
	const add = (path: string, code: CompletionBundleValidationIssue["code"], message: string) => {
		issues.push({ path, code, message });
	};
	const expected = lineageOf(input.definition, input.revision, input.run, input.attempt);
	for (const key of Object.keys(expected) as Array<keyof GoalLineageV3>) {
		if (input.bundle.lineage[key] !== expected[key]) {
			add(`lineage.${key}`, "lineage_mismatch", `expected ${expected[key]}, received ${input.bundle.lineage[key]}`);
		}
	}
	if (input.revision.goalDefinitionId !== input.definition.id || input.revision.definition.id !== input.definition.id) {
		add("revision", "lineage_mismatch", "revision does not belong to the supplied goal definition");
	}
	if (input.run.goalDefinitionId !== input.definition.id || input.run.revisionId !== input.revision.id) {
		add("run", "lineage_mismatch", "run does not belong to the supplied revision");
	}
	if (input.attempt.runId !== input.run.id || input.attempt.revisionId !== input.revision.id) {
		add("attempt", "lineage_mismatch", "attempt does not belong to the supplied run and revision");
	}
	if (input.run.status !== "active") add("run.status", "invalid", "completion requires an active run");
	if (input.attempt.status !== "active") add("attempt.status", "invalid", "completion requires an active attempt");
	if (!input.bundle.idempotencyKey.trim()) add("idempotencyKey", "required", "idempotencyKey is required");
	if (!input.bundle.summary.trim()) add("summary", "required", "summary is required");
	if (input.bundle.contractVersion !== GOAL_CONTRACT_VERSION) add("contractVersion", "invalid", "unsupported contract version");

	const artifactById = new Map<string, GoalArtifactV3>();
	for (const [index, artifact] of input.bundle.artifacts.entries()) {
		const artifactPath = `artifacts[${index}]`;
		if (artifactById.has(artifact.id)) add(`${artifactPath}.id`, "invalid", `duplicate artifact id ${artifact.id}`);
		artifactById.set(artifact.id, artifact);
		if (!artifact.uri.trim()) add(`${artifactPath}.uri`, "required", "artifact uri is required");
		if (!validDigest(artifact.digest)) add(`${artifactPath}.digest`, "invalid", "artifact requires a lowercase sha256 digest");
		if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) add(`${artifactPath}.sizeBytes`, "invalid", "sizeBytes must be a non-negative integer");
		if (artifact.createdByAttemptId !== input.attempt.id) add(`${artifactPath}.createdByAttemptId`, "lineage_mismatch", "artifact was not produced by the active attempt");
		if (artifact.verifiedAt < artifact.createdAt) add(`${artifactPath}.verifiedAt`, "invalid", "artifact verification predates creation");
	}

	const criterionIds = new Set(input.definition.criteria.map((criterion) => criterion.id));
	const evidenceById = new Map<string, GoalEvidenceV3>();
	for (const [index, evidence] of input.bundle.evidence.entries()) {
		const evidencePath = `evidence[${index}]`;
		if (evidenceById.has(evidence.id)) add(`${evidencePath}.id`, "invalid", `duplicate evidence id ${evidence.id}`);
		evidenceById.set(evidence.id, evidence);
		if (!evidence.summary.trim()) add(`${evidencePath}.summary`, "required", "evidence summary is required");
		if (evidence.verification !== "verified") add(`${evidencePath}.verification`, "unsatisfied", "completion evidence must be verified");
		if (evidence.createdByAttemptId !== input.attempt.id) add(`${evidencePath}.createdByAttemptId`, "lineage_mismatch", "evidence was not produced by the active attempt");
		for (const criterionId of evidence.criterionIds) {
			if (!criterionIds.has(criterionId)) add(`${evidencePath}.criterionIds`, "unknown_reference", `unknown criterion ${criterionId}`);
		}
		if (evidence.artifactId) {
			const artifact = artifactById.get(evidence.artifactId);
			if (!artifact) add(`${evidencePath}.artifactId`, "unknown_reference", `unknown artifact ${evidence.artifactId}`);
			else if (!evidence.digest || !sameDigest(evidence.digest, artifact.digest)) add(`${evidencePath}.digest`, "stale", "artifact evidence digest does not match the submitted artifact");
		}
	}

	const evaluation = input.bundle.evaluation;
	if (evaluation.revisionId !== input.revision.id || evaluation.runId !== input.run.id || evaluation.attemptId !== input.attempt.id) {
		add("evaluation", "lineage_mismatch", "evaluation does not belong to the active revision/run/attempt");
	}
	if (evaluation.decision !== "accept") add("evaluation.decision", "unsatisfied", "atomic completion requires an accepting evaluation");
	if (evaluation.findings.length > 0) add("evaluation.findings", "unsatisfied", "an accepting evaluation cannot contain blocking findings");
	const coverageByCriterion = new Map(evaluation.criterionCoverage.map((coverage) => [coverage.criterionId, coverage]));
	for (const criterion of input.definition.criteria.filter((item) => item.level === "blocking")) {
		const coverage = coverageByCriterion.get(criterion.id);
		if (!coverage || coverage.status !== "satisfied") {
			add("evaluation.criterionCoverage", "unsatisfied", `blocking criterion ${criterion.id} is not satisfied`);
			continue;
		}
		for (const evidenceId of coverage.evidenceIds) {
			if (!evidenceById.has(evidenceId)) add("evaluation.criterionCoverage", "unknown_reference", `criterion ${criterion.id} references unknown evidence ${evidenceId}`);
		}
	}
	for (const [index, observation] of evaluation.observedArtifacts.entries()) {
		const artifact = artifactById.get(observation.artifactId);
		if (!artifact) add(`evaluation.observedArtifacts[${index}]`, "unknown_reference", `unknown artifact ${observation.artifactId}`);
		else if (!sameDigest(observation.digest, artifact.digest)) add(`evaluation.observedArtifacts[${index}].digest`, "stale", "evaluation observed a different artifact digest");
	}
	for (const [index, check] of input.bundle.deterministicChecks.entries()) {
		if (check.status !== "passed") add(`deterministicChecks[${index}].status`, "unsatisfied", `deterministic check ${check.id} did not pass`);
		for (const evidenceId of check.evidenceIds) {
			if (!evidenceById.has(evidenceId)) add(`deterministicChecks[${index}].evidenceIds`, "unknown_reference", `unknown evidence ${evidenceId}`);
		}
	}
	for (const rule of input.definition.verification.filter((item) => item.required)) {
		const satisfied = rule.kind === "deterministic"
			? input.bundle.deterministicChecks.some((check) => check.id === rule.id && check.status === "passed")
			: evaluation.evaluator.kind === rule.kind;
		if (!satisfied) add("verification", "unsatisfied", `required verification ${rule.id} (${rule.kind}) is missing`);
	}
	if (input.definition.risk.requiredApprovals.length > 0 && evaluation.evaluator.kind !== "human") {
		add("evaluation.evaluator", "unsatisfied", "the goal risk policy requires a human approval evaluation");
	}

	return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Validate the whole completion bundle before returning any state mutation.
 * Callers persist the returned run, attempt, and bundle together.
 */
export function applyCompletionBundleV3(input: ApplyCompletionBundleInputV3): GoalResultV3<CompletionTransitionV3> {
	const lineage = lineageOf(input.definition, input.revision, input.run, input.attempt);
	if (input.existingBundle?.idempotencyKey === input.bundle.idempotencyKey) {
		if (completionBundleDigest(input.existingBundle) !== completionBundleDigest(input.bundle)) {
			return {
				ok: false,
				error: createGoalError("idempotency_conflict", "The idempotency key was already used for a different completion bundle."),
				lineage,
			};
		}
		return {
			ok: true,
			value: { run: input.run, attempt: input.attempt, bundle: input.existingBundle, replayed: true },
			lineage,
		};
	}
	if (input.existingBundle) {
		return {
			ok: false,
			error: createGoalError("invalid_transition", "This run already has a committed completion bundle."),
			lineage,
		};
	}
	const validation = validateCompletionBundleV3(input);
	if (!validation.ok) {
		return {
			ok: false,
			error: createGoalError("verification_failed", "Completion bundle validation failed.", { details: { issues: validation.issues } }),
			lineage,
		};
	}
	const endedAt = Math.max(input.bundle.submittedAt, input.attempt.startedAt, input.run.createdAt);
	return {
		ok: true,
		value: {
			run: { ...input.run, status: "completed", updatedAt: endedAt, endedAt, currentAttemptId: input.attempt.id },
			attempt: { ...input.attempt, status: "succeeded", endedAt },
			bundle: input.bundle,
			replayed: false,
		},
		lineage,
	};
}

export function isArtifactObservationCurrent(
	artifact: GoalArtifactV3,
	observation: { artifactId: string; digest: GoalDigestV3 },
): boolean {
	return artifact.id === observation.artifactId && sameDigest(artifact.digest, observation.digest);
}

export function completionBundleDigest(bundle: GoalCompletionBundleV3): string {
	return createHash("sha256").update(stableJson(bundle)).digest("hex");
}

export function createCompletionCommitV3(
	bundle: GoalCompletionBundleV3,
	reviewerResultRef: GoalCompletionCommitV3["reviewerResultRef"],
	requestDigest = completionBundleDigest(bundle),
): GoalCompletionCommitV3 {
	return parseGoalCompletionCommitV3({
		contractVersion: GOAL_CONTRACT_VERSION,
		idempotencyKey: bundle.idempotencyKey,
		requestDigest,
		bundleDigest: completionBundleDigest(bundle),
		lineage: bundle.lineage,
		artifacts: bundle.artifacts,
		reviewerResultRef,
		committedAt: bundle.submittedAt,
	});
}

export function parseGoalCompletionCommitV3(value: unknown, path = "completionTransaction"): GoalCompletionCommitV3 {
	const object = asRecord(value, path);
	if (object.contractVersion !== GOAL_CONTRACT_VERSION) throw new Error(`${path}.contractVersion must be ${GOAL_CONTRACT_VERSION}`);
	const lineageObject = asRecord(object.lineage, `${path}.lineage`);
	const lineage: GoalLineageV3 = {
		goalDefinitionId: requiredId(lineageObject.goalDefinitionId, `${path}.lineage.goalDefinitionId`),
		revisionId: requiredId(lineageObject.revisionId, `${path}.lineage.revisionId`),
		runId: requiredId(lineageObject.runId, `${path}.lineage.runId`),
		attemptId: requiredId(lineageObject.attemptId, `${path}.lineage.attemptId`),
	};
	if (!Array.isArray(object.artifacts)) throw new Error(`${path}.artifacts must be an array`);
	const artifacts = object.artifacts.map((item, index) => parseArtifact(item, `${path}.artifacts[${index}]`));
	const refObject = asRecord(object.reviewerResultRef, `${path}.reviewerResultRef`);
	return {
		contractVersion: GOAL_CONTRACT_VERSION,
		idempotencyKey: requiredId(object.idempotencyKey, `${path}.idempotencyKey`),
		requestDigest: sha256String(object.requestDigest, `${path}.requestDigest`),
		bundleDigest: sha256String(object.bundleDigest, `${path}.bundleDigest`),
		lineage,
		artifacts,
		reviewerResultRef: {
			resultId: requiredId(refObject.resultId, `${path}.reviewerResultRef.resultId`),
			agentId: requiredId(refObject.agentId, `${path}.reviewerResultRef.agentId`),
			role: requiredId(refObject.role, `${path}.reviewerResultRef.role`),
			digest: sha256String(refObject.digest, `${path}.reviewerResultRef.digest`),
		},
		committedAt: finiteNonNegativeNumber(object.committedAt, `${path}.committedAt`),
	};
}

function validDigest(value: GoalDigestV3): boolean {
	return value.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(value.value);
}

function parseArtifact(value: unknown, path: string): GoalArtifactV3 {
	const object = asRecord(value, path);
	const digestObject = asRecord(object.digest, `${path}.digest`);
	const digest: GoalDigestV3 = {
		algorithm: enumValue(digestObject.algorithm, ["sha256"] as const, `${path}.digest.algorithm`),
		value: sha256String(digestObject.value, `${path}.digest.value`),
	};
	return {
		id: requiredId(object.id, `${path}.id`),
		uri: requiredId(object.uri, `${path}.uri`),
		digest,
		sizeBytes: nonNegativeInteger(object.sizeBytes, `${path}.sizeBytes`),
		...(object.mediaType === undefined ? {} : { mediaType: requiredId(object.mediaType, `${path}.mediaType`) }),
		createdByAttemptId: requiredId(object.createdByAttemptId, `${path}.createdByAttemptId`),
		createdAt: finiteNonNegativeNumber(object.createdAt, `${path}.createdAt`),
		verifiedAt: finiteNonNegativeNumber(object.verifiedAt, `${path}.verifiedAt`),
	};
}

function sameDigest(left: GoalDigestV3, right: GoalDigestV3): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
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

function requiredId(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function nullableId(value: unknown, path: string): string | null {
	return value === null ? null : requiredId(value, path);
}

function nonNegativeInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
	return value;
}

function finiteNonNegativeNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a finite non-negative number`);
	return value;
}

function sha256String(value: unknown, path: string): string {
	const digest = requiredId(value, path);
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${path} must be a lowercase sha256 digest`);
	return digest;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
	return value as T[number];
}
