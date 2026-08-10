import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	GOAL_CONTRACT_VERSION,
	applyCompletionBundleV3,
	createCompletionCommitV3,
	type GoalArtifactV3,
	type GoalCompletionBundleV3,
	type GoalCompletionIntegrityV3,
	type GoalDeterministicCheckV3,
	type GoalEvaluationV3,
	type GoalEvidenceV3,
} from "./goal-contract-v3";
import {
	attemptFromGoalV2,
	definitionFromGoalV2,
	revisionFromGoalV2,
	runFromGoalV2,
} from "./goal-contract-v3-adapter";
import type { CompletionEvaluation, EvidenceRef, GoalStateV2, StoredGoalCriterionV2 } from "./state";
import type { SubmitCompletionBundleAction } from "./update-goal-action-v2";
import type { VerifyResult } from "./verify-command";
import type { RoleResultEnvelopeV1 } from "./role-result-v1";

export type VerifyCompletionArtifactsResult =
	| { ok: true; artifacts: GoalArtifactV3[] }
	| { ok: false; reason: string };

export interface PrepareCompletionBundleInput {
	goal: GoalStateV2;
	action: SubmitCompletionBundleAction;
	reviewerResult: RoleResultEnvelopeV1;
	cwd: string;
	now: number;
	verifyCommand?: string;
	verifyResult?: VerifyResult;
}

export type PrepareCompletionBundleResult =
	| { ok: true; bundle: GoalCompletionBundleV3; patch: Partial<GoalStateV2> }
	| { ok: false; reason: string; details?: Record<string, unknown> };

export type CompletionSubmissionPreflightV3 =
	| { outcome: "proceed" }
	| { outcome: "replay"; transaction: NonNullable<GoalStateV2["completionTransaction"]> }
	| { outcome: "conflict"; transaction: NonNullable<GoalStateV2["completionTransaction"]> }
	| { outcome: "terminal"; reason: string };

/**
 * Classify a completion submission without reading reviewer state, artifacts,
 * or invoking deterministic verification. Adapters must call this before any
 * operation with side effects so at-least-once delivery stays idempotent.
 */
export function preflightCompletionSubmissionV3(
	goal: GoalStateV2,
	action: SubmitCompletionBundleAction,
): CompletionSubmissionPreflightV3 {
	if (goal.status === "active") return { outcome: "proceed" };
	const transaction = goal.completionTransaction;
	if (goal.status === "complete" && transaction?.idempotencyKey === action.idempotencyKey) {
		return transaction.requestDigest === completionSubmissionDigest(action)
			? { outcome: "replay", transaction }
			: { outcome: "conflict", transaction };
	}
	return {
		outcome: "terminal",
		reason: `Completion bundle requires an active goal; current status is ${goal.status}.`,
	};
}

export function verifyCompletionArtifacts(
	action: SubmitCompletionBundleAction,
	cwd: string,
	attemptId: string,
	now: number,
): VerifyCompletionArtifactsResult {
	const artifacts: GoalArtifactV3[] = [];
	const ids = new Set<string>();
	for (const item of action.artifacts) {
		if (ids.has(item.id)) return { ok: false, reason: `Duplicate artifact id ${item.id}.` };
		ids.add(item.id);
		let localPath: string;
		try { localPath = artifactUriToPath(item.uri, cwd); }
		catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
		let bytes: Buffer;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(localPath);
			if (!stat.isFile()) return { ok: false, reason: `Artifact ${item.uri} is not a regular file.` };
			bytes = fs.readFileSync(localPath);
		} catch (error) {
			return { ok: false, reason: `Cannot read artifact ${item.uri}: ${error instanceof Error ? error.message : String(error)}` };
		}
		const actualDigest = createHash("sha256").update(bytes).digest("hex");
		if (actualDigest !== item.digest) return { ok: false, reason: `Artifact ${item.uri} digest is stale or incorrect.` };
		if (stat.size !== item.sizeBytes) return { ok: false, reason: `Artifact ${item.uri} size is stale or incorrect.` };
		artifacts.push({
			id: item.id,
			uri: item.uri,
			digest: { algorithm: "sha256", value: actualDigest },
			sizeBytes: stat.size,
			...(item.mediaType === undefined ? {} : { mediaType: item.mediaType }),
			createdByAttemptId: attemptId,
			createdAt: Math.min(now, Math.max(0, stat.mtimeMs)),
			verifiedAt: now,
		});
	}
	return { ok: true, artifacts };
}

/** Revalidate a committed receipt against current bytes without mutating it. */
export function inspectCommittedArtifactsV3(goal: GoalStateV2, cwd: string, now: number): GoalCompletionIntegrityV3 {
	const transaction = goal.completionTransaction;
	if (!transaction) return { status: "not_applicable", checkedAt: now, staleArtifacts: [] };
	const staleArtifacts: GoalCompletionIntegrityV3["staleArtifacts"] = [];
	for (const artifact of transaction.artifacts) {
		let localPath: string;
		try {
			localPath = artifactUriToPath(artifact.uri, cwd);
		} catch {
			staleArtifacts.push(staleArtifact(artifact, "unreadable"));
			continue;
		}
		let stat: fs.Stats;
		let bytes: Buffer;
		try {
			stat = fs.statSync(localPath);
		} catch {
			staleArtifacts.push(staleArtifact(artifact, "missing"));
			continue;
		}
		if (!stat.isFile()) {
			staleArtifacts.push(staleArtifact(artifact, "not_file", undefined, stat.size));
			continue;
		}
		try {
			bytes = fs.readFileSync(localPath);
		} catch {
			staleArtifacts.push(staleArtifact(artifact, "unreadable", undefined, stat.size));
			continue;
		}
		const actualDigest = createHash("sha256").update(bytes).digest("hex");
		if (actualDigest !== artifact.digest.value) {
			staleArtifacts.push(staleArtifact(artifact, "digest_mismatch", actualDigest, stat.size));
			continue;
		}
		if (stat.size !== artifact.sizeBytes) {
			staleArtifacts.push(staleArtifact(artifact, "size_mismatch", actualDigest, stat.size));
		}
	}
	return { status: staleArtifacts.length > 0 ? "stale" : "current", checkedAt: now, staleArtifacts };
}

function staleArtifact(
	artifact: GoalArtifactV3,
	reason: GoalCompletionIntegrityV3["staleArtifacts"][number]["reason"],
	actualDigest?: string,
	actualSizeBytes?: number,
): GoalCompletionIntegrityV3["staleArtifacts"][number] {
	return {
		artifactId: artifact.id,
		uri: artifact.uri,
		reason,
		expectedDigest: artifact.digest,
		...(actualDigest === undefined ? {} : { actualDigest: { algorithm: "sha256", value: actualDigest } }),
		expectedSizeBytes: artifact.sizeBytes,
		...(actualSizeBytes === undefined ? {} : { actualSizeBytes }),
	};
}

export function prepareCompletionBundleV3(input: PrepareCompletionBundleInput): PrepareCompletionBundleResult {
	if (!input.goal.runtime) return { ok: false, reason: "This goal has no Contract V3 runtime lineage." };
	const preflight = preflightCompletionSubmissionV3(input.goal, input.action);
	if (preflight.outcome === "replay") {
		return { ok: false, reason: "IDEMPOTENT_REPLAY", details: { transaction: preflight.transaction } };
	}
	if (preflight.outcome === "conflict") {
		return { ok: false, reason: "IDEMPOTENCY_CONFLICT", details: { transaction: preflight.transaction } };
	}
	if (preflight.outcome === "terminal") return { ok: false, reason: preflight.reason };
	if (input.reviewerResult.role !== "goal-reviewer") {
		return { ok: false, reason: "Atomic completion requires the typed goal-reviewer role." };
	}
	const payload = parseReviewerPayload(input.reviewerResult.payload);
	if (!payload.ok) return payload;
	const verifiedArtifacts = verifyCompletionArtifacts(input.action, input.cwd, input.goal.runtime.attemptId, input.now);
	if (!verifiedArtifacts.ok) return verifiedArtifacts;
	const artifactById = new Map(verifiedArtifacts.artifacts.map((artifact) => [artifact.id, artifact]));
	const evidence: GoalEvidenceV3[] = input.action.evidence.map((item) => ({
		id: item.id,
		kind: item.kind,
		summary: item.summary,
		criterionIds: item.criterionIds,
		claimIds: item.claimIds,
		...(item.artifactId === undefined ? {} : { artifactId: item.artifactId }),
		...(item.digest === undefined ? {} : { digest: { algorithm: "sha256" as const, value: item.digest } }),
		verification: "verified",
		verifiedAt: input.now,
		createdByAttemptId: input.goal.runtime!.attemptId,
	}));
	for (const item of evidence) {
		if (item.artifactId && !artifactById.has(item.artifactId)) {
			return { ok: false, reason: `Evidence ${item.id} references unknown artifact ${item.artifactId}.` };
		}
	}
	const deterministicChecks: GoalDeterministicCheckV3[] = input.action.deterministicChecks.map((check) => ({
		...check,
		checkedAt: input.now,
	}));
	if (input.verifyCommand) {
		if (!input.verifyResult) return { ok: false, reason: "The configured deterministic verification did not run." };
		deterministicChecks.push({
			id: "goal-v2-verify-command",
			status: input.verifyResult.ok ? "passed" : "failed",
			summary: verificationSummary(input.verifyCommand, input.verifyResult),
			evidenceIds: [],
			checkedAt: input.now,
		});
	}
	const definition = definitionFromGoalV2(input.goal);
	const revision = revisionFromGoalV2(input.goal);
	const run = runFromGoalV2(input.goal);
	const attempt = attemptFromGoalV2(input.goal);
	const submittedEvidenceIds = new Set(evidence.map((item) => item.id));
	const unknownReviewerEvidenceIds = new Set<string>();
	const criterionCoverage = payload.value.criterionCoverage.map((coverage) => ({
		...coverage,
		evidenceIds: coverage.evidenceIds.filter((evidenceId) => {
			const known = submittedEvidenceIds.has(evidenceId);
			if (!known) unknownReviewerEvidenceIds.add(evidenceId);
			return known;
		}),
	}));
	for (const criterion of definition.criteria.filter((item) => item.level === "blocking")) {
		const coverage = criterionCoverage.find((item) => item.criterionId === criterion.id);
		if (coverage?.status === "satisfied" && coverage.evidenceIds.length === 0) {
			return { ok: false, reason: `Reviewer accepted blocking criterion ${criterion.id} without a submitted evidence reference.` };
		}
	}
	const reviewerAdvisories = [...payload.value.advisories];
	if (unknownReviewerEvidenceIds.size > 0) {
		reviewerAdvisories.push(
			`Reviewer referenced evidence IDs not submitted in the completion bundle; ignored: ${[...unknownReviewerEvidenceIds].sort().join(", ")}.`,
		);
	}
	const reviewerOnlyArtifactUris: string[] = [];
	const observedArtifacts: GoalEvaluationV3["observedArtifacts"] = [];
	for (const observed of payload.value.artifacts) {
		const artifact = verifiedArtifacts.artifacts.find((item) => item.uri === observed.uri || sameArtifactUri(item.uri, observed.uri, input.cwd));
		if (!artifact) {
			reviewerOnlyArtifactUris.push(observed.uri);
			continue;
		}
		observedArtifacts.push({
			artifactId: artifact.id,
			digest: { algorithm: "sha256", value: observed.digest },
		});
	}
	if (reviewerOnlyArtifactUris.length > 0) {
		reviewerAdvisories.push(
			`Reviewer observed ${reviewerOnlyArtifactUris.length} non-submitted file(s); excluded from completion artifact integrity.`,
		);
	}
	const evaluation: GoalEvaluationV3 = {
		id: input.reviewerResult.resultId,
		revisionId: revision.id,
		runId: run.id,
		attemptId: attempt.id,
		decision: payload.value.decision,
		evaluator: { kind: "reviewer", id: input.reviewerResult.agentId, independent: true },
		criterionCoverage,
		findings: payload.value.findings,
		advisories: reviewerAdvisories,
		observedArtifacts,
		// The reviewer envelope may predate submission. The authoritative evaluation
		// becomes current only after this runtime revalidates its digest/artifacts.
		evaluatedAt: input.now,
	};
	const bundle: GoalCompletionBundleV3 = {
		contractVersion: GOAL_CONTRACT_VERSION,
		idempotencyKey: input.action.idempotencyKey,
		lineage: {
			goalDefinitionId: definition.id,
			revisionId: revision.id,
			runId: run.id,
			attemptId: attempt.id,
		},
		summary: input.action.summary,
		artifacts: verifiedArtifacts.artifacts,
		evidence,
		evaluation,
		deterministicChecks,
		submittedAt: input.now,
	};
	const transition = applyCompletionBundleV3({ definition, revision, run, attempt, bundle });
	if (!transition.ok) return { ok: false, reason: transition.error.message, details: transition.error.details };
	const v2Evidence = evidence.map(toV2Evidence);
	const existingEvidenceById = new Map(input.goal.evidenceLedger.map((entry) => [entry.id, entry]));
	for (const entry of v2Evidence) {
		const existing = existingEvidenceById.get(entry.id);
		if (!existing) continue;
		if (existing.kind !== entry.kind) {
			return { ok: false, reason: `Evidence id ${entry.id} already exists with kind ${existing.kind}, not ${entry.kind}.` };
		}
		if (existing.verification === "rejected") {
			return { ok: false, reason: `Evidence id ${entry.id} was previously rejected and cannot be committed as verified.` };
		}
	}
	const mergedEvidenceLedger = input.goal.evidenceLedger.map((entry) => {
		const submitted = v2Evidence.find((candidate) => candidate.id === entry.id);
		return submitted ? { ...entry, verification: "verified" as const } : entry;
	});
	for (const entry of v2Evidence) {
		if (!existingEvidenceById.has(entry.id)) mergedEvidenceLedger.push(entry);
	}
	const criteria = attachCriterionEvidence(input.goal.criteria, mergedEvidenceLedger, evidence);
	const claims = input.goal.claims.map((claim) => ({
		...claim,
		evidenceRefs: [...new Set([...claim.evidenceRefs, ...evidence.filter((item) => item.claimIds.includes(claim.id)).map((item) => item.id)])],
	}));
	const completionEvaluation: CompletionEvaluation = {
		decision: "accept",
		evaluatedAt: evaluation.evaluatedAt,
		criterionCoverage: evaluation.criterionCoverage.map((coverage) => ({
			criterionId: coverage.criterionId,
			status: coverage.status,
			evidenceRefs: coverage.evidenceIds,
			reason: "Structured Goal Contract V3 reviewer coverage.",
		})),
		claimCoverage: [],
		findings: evaluation.findings.map((finding) => ({
			code: finding.code,
			subjectId: finding.subjectId,
			reason: finding.reason,
			...(finding.evidenceRefs.length === 0 ? {} : { evidenceRefs: finding.evidenceRefs }),
			...(finding.missingEvidenceKind ? { missingEvidenceKind: finding.missingEvidenceKind as EvidenceRef["kind"] } : {}),
		})),
		advisories: evaluation.advisories,
		evaluator: {
			kind: "reviewer",
			agentId: input.reviewerResult.agentId,
			reportDigest: input.reviewerResult.digest,
		},
		fingerprint: null,
	};
	return {
		ok: true,
		bundle,
		patch: {
			status: "complete",
			criteria,
			claims,
			evidenceLedger: mergedEvidenceLedger,
			assurance: input.goal.assurance.reviewRequirement === "none"
				? input.goal.assurance
				: { ...input.goal.assurance, reviewStatus: "passed" },
			completion: {
				...input.goal.completion,
				summary: input.action.summary,
				requestedAt: input.now,
				lastEvaluation: completionEvaluation,
				rejectionCount: 0,
			},
			completionTransaction: createCompletionCommitV3(bundle, input.action.reviewerResultRef, completionSubmissionDigest(input.action)),
			noProgressCount: 0,
		},
	};
}

export function completionSubmissionDigest(action: SubmitCompletionBundleAction): string {
	return createHash("sha256").update(stableJson(action)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function artifactUriToPath(uri: string, cwd: string): string {
	if (uri.startsWith("workspace://")) return path.resolve(cwd, uri.slice("workspace://".length));
	if (uri.startsWith("file://")) return fileURLToPath(uri);
	if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error(`Artifact URI scheme is not mechanically verifiable: ${uri}`);
	return path.resolve(cwd, uri);
}

/** Reviewers may report the same local file as an absolute path even when the
 * submitter used a workspace-relative URI. Canonicalize local references for
 * identity while retaining the submitter's URI in the committed artifact. */
function sameArtifactUri(left: string, right: string, cwd: string): boolean {
	try {
		return artifactUriToPath(left, cwd) === artifactUriToPath(right, cwd);
	} catch {
		return false;
	}
}

function toV2Evidence(evidence: GoalEvidenceV3): EvidenceRef {
	return {
		id: evidence.id,
		kind: evidence.kind,
		summary: evidence.summary,
		...(evidence.artifactId === undefined ? {} : { locator: evidence.artifactId }),
		recordedAt: evidence.verifiedAt,
		origin: evidence.kind === "source" || evidence.kind === "observation" ? "agent" : "tool",
		verification: "verified",
	};
}

function attachCriterionEvidence(
	criteria: readonly StoredGoalCriterionV2[],
	canonical: readonly EvidenceRef[],
	v3Evidence: readonly GoalEvidenceV3[],
): StoredGoalCriterionV2[] {
	return criteria.map((criterion) => {
		const additions = canonical.filter((entry) => v3Evidence.find((item) => item.id === entry.id)?.criterionIds.includes(criterion.id));
		const additionsById = new Map(additions.map((entry) => [entry.id, entry]));
		const existingIds = new Set(criterion.evidence.map((entry) => entry.id));
		return {
			...criterion,
			evidenceRefs: [...new Set([...criterion.evidenceRefs, ...additions.map((entry) => entry.id)])],
			evidence: [
				...criterion.evidence.map((existing) => {
					const entry = additionsById.get(existing.id);
					return entry ? toEmbeddedCriterionEvidence(entry) : existing;
				}),
				...additions.filter((entry) => !existingIds.has(entry.id)).map(toEmbeddedCriterionEvidence),
			],
		};
	});
}

function toEmbeddedCriterionEvidence(entry: EvidenceRef): StoredGoalCriterionV2["evidence"][number] {
	return {
		id: entry.id,
		kind: entry.kind === "command" ? "tool_result" : entry.kind,
		summary: entry.summary,
		...(entry.locator === undefined ? {} : { locator: entry.locator }),
		...(entry.sourceKind === undefined ? {} : { sourceKind: entry.sourceKind }),
		...(entry.independenceKey === undefined ? {} : { independenceKey: entry.independenceKey }),
		origin: entry.origin,
		recordedAt: entry.recordedAt,
		verification: entry.verification,
	};
}

type ReviewerPayload = {
	decision: "accept" | "revise" | "blocked";
	summary: string;
	criterionCoverage: GoalEvaluationV3["criterionCoverage"];
	findings: GoalEvaluationV3["findings"];
	artifacts: Array<{ uri: string; digest: string; sizeBytes: number }>;
	advisories: string[];
};

function parseReviewerPayload(value: Record<string, unknown> | null):
	| { ok: true; value: ReviewerPayload }
	| { ok: false; reason: string } {
	try {
		if (!value) throw new Error("Reviewer payload is missing.");
		const decision = enumString(value.decision, ["accept", "revise", "blocked"] as const, "decision");
		const summary = stringValue(value.summary, "summary");
		const criterionCoverage = objectArray(value.criterionCoverage, "criterionCoverage").map((item, index) => ({
			criterionId: stringValue(item.criterionId, `criterionCoverage[${index}].criterionId`),
			status: enumString(item.status, ["satisfied", "unsatisfied", "blocked"] as const, `criterionCoverage[${index}].status`),
			evidenceIds: stringArray(item.evidenceIds, `criterionCoverage[${index}].evidenceIds`),
		}));
		const findings = objectArray(value.findings, "findings").map((item, index) => {
			const missingEvidenceKind = stringValue(item.missingEvidenceKind, `findings[${index}].missingEvidenceKind`, true);
			return {
				id: stringValue(item.id, `findings[${index}].id`),
				code: stringValue(item.code, `findings[${index}].code`),
				severity: stringValue(item.severity, `findings[${index}].severity`),
				subjectId: stringValue(item.subjectId, `findings[${index}].subjectId`),
				reason: stringValue(item.reason, `findings[${index}].reason`),
				evidenceRefs: stringArray(item.evidenceRefs, `findings[${index}].evidenceRefs`),
				...(missingEvidenceKind ? { missingEvidenceKind } : {}),
			};
		});
		const artifacts = objectArray(value.artifacts, "artifacts").map((item, index) => ({
			uri: stringValue(item.uri, `artifacts[${index}].uri`),
			digest: digestValue(item.digest, `artifacts[${index}].digest`),
			sizeBytes: integerValue(item.sizeBytes, `artifacts[${index}].sizeBytes`),
		}));
		const advisories = value.advisories === undefined ? [] : stringArray(value.advisories, "advisories");
		return { ok: true, value: { decision, summary, criterionCoverage, findings, artifacts, advisories } };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function verificationSummary(command: string, result: VerifyResult): string {
	return `${result.ok ? "passed" : "failed"}: ${command} (exit ${result.exitCode ?? "none"})`;
}

function objectArray(value: unknown, pathName: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${pathName} must be an array`);
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${pathName}[${index}] must be an object`);
		return item as Record<string, unknown>;
	});
}

function stringArray(value: unknown, pathName: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${pathName} must be an array`);
	return value.map((item, index) => stringValue(item, `${pathName}[${index}]`));
}

function stringValue(value: unknown, pathName: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${pathName} must be a string`);
	return value;
}

function digestValue(value: unknown, pathName: string): string {
	const supplied = stringValue(value, pathName);
	// Role output is model-facing and some providers conventionally render a
	// digest receipt as `sha256:<hex>`. Accept that one unambiguous transport
	// spelling at this boundary, but keep the Contract V3 representation bare.
	const digest = supplied.startsWith("sha256:") ? supplied.slice("sha256:".length) : supplied;
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${pathName} must be a lowercase sha256 digest`);
	return digest;
}

function integerValue(value: unknown, pathName: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${pathName} must be a non-negative integer`);
	return value;
}

function enumString<const T extends readonly string[]>(value: unknown, allowed: T, pathName: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${pathName} must be one of ${allowed.join(", ")}`);
	return value as T[number];
}
