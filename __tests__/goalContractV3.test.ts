import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GOAL_CONTRACT_VERSION,
	applyCompletionBundleV3,
	completionBundleDigest,
	createGoalError,
	createInitialRuntimeMetadataV3,
	parseGoalRuntimeMetadataV3,
	type GoalArtifactV3,
	type GoalCompletionBundleV3,
	type GoalDefinitionV3,
	type GoalRevisionV3,
	type GoalRunV3,
	type GoalAttemptV3,
} from "../extensions/goal-contract-v3";

const digest = { algorithm: "sha256" as const, value: "a".repeat(64) };

function fixture() {
	const definition: GoalDefinitionV3 = {
		contractVersion: GOAL_CONTRACT_VERSION,
		id: "goal-1",
		objective: "Produce the artifact",
		criteria: [{ id: "c1", description: "The output is verified", level: "blocking" }],
		constraints: [],
		verification: [{ id: "checks", kind: "deterministic", required: true, description: "Checks pass" }],
		risk: { level: "low", requiredApprovals: [] },
		budget: {},
		taskKind: "document",
		createdAt: 1_000,
	};
	const revision: GoalRevisionV3 = {
		id: "revision-1",
		goalDefinitionId: definition.id,
		number: 1,
		previousRevisionId: null,
		source: "user",
		reason: "initial goal",
		definition,
		createdAt: 1_000,
	};
	const run: GoalRunV3 = {
		id: "run-1",
		goalDefinitionId: definition.id,
		revisionId: revision.id,
		entrypoint: "interactive",
		status: "active",
		attemptIds: ["attempt-1"],
		currentAttemptId: "attempt-1",
		parentRunId: null,
		previousRunId: null,
		createdAt: 1_000,
		updatedAt: 1_100,
		endedAt: null,
	};
	const attempt: GoalAttemptV3 = {
		id: "attempt-1",
		runId: run.id,
		revisionId: revision.id,
		number: 1,
		previousAttemptId: null,
		status: "active",
		idempotencyKey: "attempt-1",
		startedAt: 1_100,
		endedAt: null,
	};
	const artifact: GoalArtifactV3 = {
		id: "artifact-1",
		uri: "workspace://result.md",
		digest,
		sizeBytes: 10,
		createdByAttemptId: attempt.id,
		createdAt: 1_200,
		verifiedAt: 1_300,
	};
	const bundle: GoalCompletionBundleV3 = {
		contractVersion: GOAL_CONTRACT_VERSION,
		idempotencyKey: "complete-1",
		lineage: { goalDefinitionId: definition.id, revisionId: revision.id, runId: run.id, attemptId: attempt.id },
		summary: "Verified output",
		artifacts: [artifact],
		evidence: [{
			id: "evidence-1",
			kind: "artifact",
			summary: "The artifact was checked",
			criterionIds: ["c1"],
			claimIds: [],
			artifactId: artifact.id,
			digest,
			verification: "verified",
			verifiedAt: 1_300,
			createdByAttemptId: attempt.id,
		}],
		evaluation: {
			id: "evaluation-1",
			revisionId: revision.id,
			runId: run.id,
			attemptId: attempt.id,
			decision: "accept",
			evaluator: { kind: "deterministic", id: "checks", independent: true },
			criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceIds: ["evidence-1"] }],
			findings: [],
			advisories: [],
			observedArtifacts: [{ artifactId: artifact.id, digest }],
			evaluatedAt: 1_400,
		},
		deterministicChecks: [{ id: "checks", status: "passed", summary: "ok", evidenceIds: ["evidence-1"], checkedAt: 1_300 }],
		submittedAt: 1_500,
	};
	return { definition, revision, run, attempt, bundle };
}

describe("Goal Contract V3", () => {
	it("creates and validates a shared runtime lineage projection", () => {
		const metadata = createInitialRuntimeMetadataV3({ goalId: "goal-1", entrypoint: "headless" });
		assert.equal(metadata.contractVersion, 3);
		assert.equal(metadata.runId, "goal-1:run:1");
		assert.deepEqual(parseGoalRuntimeMetadataV3(metadata), metadata);
	});

	it("classifies infrastructure and content errors differently", () => {
		assert.deepEqual(createGoalError("timeout", "provider timed out").retryable, true);
		assert.equal(createGoalError("verification_failed", "missing proof").recovery, "revise");
		assert.equal(createGoalError("approval_required", "needs approval").recovery, "wait_approval");
	});

	it("commits an accepting bundle as one terminal transition", () => {
		const input = fixture();
		const result = applyCompletionBundleV3(input);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.replayed, false);
		assert.equal(result.value.run.status, "completed");
		assert.equal(result.value.attempt.status, "succeeded");
		assert.equal(result.value.run.endedAt, 1_500);
		assert.equal(completionBundleDigest(result.value.bundle), completionBundleDigest(input.bundle));
	});

	it("fails without mutating state when a required check or artifact digest is stale", () => {
		const input = fixture();
		input.bundle.deterministicChecks[0].status = "failed";
		const rejected = applyCompletionBundleV3(input);
		assert.equal(rejected.ok, false);
		if (rejected.ok) return;
		assert.equal(rejected.error.code, "verification_failed");
		assert.equal(input.run.status, "active");
		assert.equal(input.attempt.status, "active");

		const stale = fixture();
		stale.bundle.evidence[0].digest = { ...digest, value: "b".repeat(64) };
		const staleResult = applyCompletionBundleV3(stale);
		assert.equal(staleResult.ok, false);
		if (!staleResult.ok) assert.match(JSON.stringify(staleResult.error.details), /digest/);
	});

	it("rejects evidence digest without artifactId as an invalid pairing (CB-P0-01)", () => {
		const input = fixture();
		const { artifactId: _removed, ...rest } = input.bundle.evidence[0];
		input.bundle.evidence[0] = { ...rest, artifactId: undefined } as typeof input.bundle.evidence[0];
		const rejected = applyCompletionBundleV3(input);
		assert.equal(rejected.ok, false);
		if (rejected.ok) return;
		const issues = rejected.error.details?.issues as Array<{ path: string; code: string }> | undefined;
		assert.ok(issues?.some((issue) => issue.path === "evidence[0].digest" && issue.code === "invalid"), "digest without artifactId must fail closed");
	});

	it("inlines the first validation issues and keeps the full list in details (CB-P1-01)", () => {
		const input = fixture();
		input.bundle.evidence[0].criterionIds = ["unknown-criterion"];
		input.bundle.summary = "";
		input.bundle.evaluation.decision = "revise";
		const rejected = applyCompletionBundleV3(input);
		assert.equal(rejected.ok, false);
		if (rejected.ok) return;
		assert.equal(rejected.error.code, "verification_failed");
		assert.equal(rejected.error.retryable, false);
		assert.equal(rejected.error.recovery, "revise");
		// 主文本内联首批 path/code/reason。
		assert.match(rejected.error.message, /Completion bundle validation failed:/);
		assert.match(rejected.error.message, /summary \(required\)/);
		assert.match(rejected.error.message, /evidence\[0\]\.criterionIds \(unknown_reference\)/);
		// details.issues 保持完整。
		const issues = rejected.error.details?.issues as Array<{ path: string; code: string }> | undefined;
		assert.ok(Array.isArray(issues) && issues.length >= 3);
		// 恢复信息稳定且 idempotency key 未被消耗。
		assert.equal(rejected.error.details?.recovery, "revise");
		assert.equal(rejected.error.details?.retryable, false);
		assert.equal(rejected.error.details?.idempotencyKeyConsumed, false);
		assert.match(String(rejected.error.details?.nextAction), /idempotency key was not consumed/);
	});

	it("caps the inline issue summary and reports the remaining count", () => {
		const input = fixture();
		input.bundle.summary = "";
		input.bundle.evidence[0].criterionIds = ["unknown-1", "unknown-2"];
		input.bundle.evaluation.decision = "revise";
		input.bundle.evaluation.criterionCoverage = [];
		input.bundle.deterministicChecks[0].status = "failed";
		const rejected = applyCompletionBundleV3(input);
		assert.equal(rejected.ok, false);
		if (rejected.ok) return;
		assert.match(rejected.error.message, /\.\.\. and \d+ more issue/);
	});

	it("replays an identical idempotent bundle and rejects a conflicting reuse", () => {
		const input = fixture();
		const committed = applyCompletionBundleV3(input);
		assert.equal(committed.ok, true);
		const replay = applyCompletionBundleV3({ ...input, existingBundle: input.bundle });
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.value.replayed, true);
		const conflict = fixture();
		conflict.bundle.summary = "different payload";
		const conflictResult = applyCompletionBundleV3({ ...conflict, existingBundle: input.bundle });
		assert.equal(conflictResult.ok, false);
		if (!conflictResult.ok) assert.equal(conflictResult.error.code, "idempotency_conflict");
	});
});
