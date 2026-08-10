import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createInitialRuntimeMetadataV3 } from "../extensions/goal-contract-v3";
import { inspectCommittedArtifactsV3, prepareCompletionBundleV3, preflightCompletionSubmissionV3 } from "../extensions/completion-bundle-v3-runtime";
import { createGoalSnapshotV2, createGoalStateV2 } from "../extensions/state";
import type { SubmitCompletionBundleAction } from "../extensions/update-goal-action-v2";
import type { RoleResultEnvelopeV1 } from "../extensions/role-result-v1";

function makeInput() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-v3-completion-"));
	const file = path.join(cwd, "result.md");
	const bytes = Buffer.from("verified result\n");
	fs.writeFileSync(file, bytes);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const goal = createGoalStateV2({
		id: "goal-1",
		objective: "Produce a verified result",
		criteria: [{ id: "c1", description: "Output exists", level: "blocking" }],
		constraints: [],
		taskKind: "general",
		execution: { preference: "direct", selected: "direct", source: "user", confidence: 1, reasons: [], reassessOn: [] },
		assurance: { reviewRequirement: "required", reviewStatus: "pending", independent: true, depth: "deep", source: "user", reasons: [], decidedAt: 1 },
		runtime: createInitialRuntimeMetadataV3({ goalId: "goal-1", entrypoint: "interactive" }),
		now: 1_000,
	});
	const action: SubmitCompletionBundleAction = {
		action: "submit_completion_bundle",
		idempotencyKey: "complete-1",
		summary: "Verified result",
		artifacts: [{ id: "a1", uri: "result.md", digest, sizeBytes: bytes.length }],
		evidence: [{ id: "e1", kind: "artifact", summary: "Result was checked", criterionIds: ["c1"], claimIds: [], artifactId: "a1", digest }],
		deterministicChecks: [],
		reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", status: "completed", digest: "b".repeat(64) },
	};
	const reviewerResult: RoleResultEnvelopeV1 = {
		schemaVersion: 1,
		resultId: "role-result:r1",
		agentId: "r1",
		role: "goal-reviewer",
		status: "completed",
		digest: "b".repeat(64),
		payload: {
			decision: "accept",
			summary: "All blocking criteria are evidenced.",
			criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceIds: ["e1"] }],
			findings: [],
			artifacts: [{ uri: "result.md", digest, sizeBytes: bytes.length }],
			advisories: [],
		},
		error: null,
		turnCount: 3,
		recordedAt: 2_000,
	};
	return { cwd, goal, action, reviewerResult, file, now: 2_100 };
}

describe("Contract V3 completion runtime", () => {
	it("verifies local artifact bytes and builds an atomic V2 patch", () => {
		const input = makeInput();
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
		if (!result.ok) return;
		assert.equal(result.patch.status, "complete");
		assert.equal(result.patch.completionTransaction?.idempotencyKey, "complete-1");
		assert.equal(result.patch.evidenceLedger?.[0].verification, "verified");
		assert.equal(result.bundle.evaluation.evaluator.kind, "reviewer");
	});

	it("rejects stale artifact bytes before any completion patch is produced", () => {
		const input = makeInput();
		fs.writeFileSync(input.file, "changed after review\n");
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /stale|digest/i);
	});

	it("rejects a reviewer payload with unsatisfied blocking coverage", () => {
		const input = makeInput();
		(input.reviewerResult.payload as Record<string, unknown>).criterionCoverage = [{ criterionId: "c1", status: "unsatisfied", evidenceIds: ["e1"] }];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /validation|satisfied|accept/i);
	});

	it("rejects a reviewer payload that omits the schema-required summary", () => {
		const input = makeInput();
		delete (input.reviewerResult.payload as Record<string, unknown>).summary;
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /summary/);
	});

	it("atomically reuses compatible evidence that was persisted during execution", () => {
		const input = makeInput();
		input.goal.evidenceLedger = [{
			id: "e1",
			kind: "artifact",
			summary: "Progress evidence recorded before review",
			recordedAt: 1_500,
			origin: "agent",
			verification: "unverified",
		}];
		input.goal.criteria[0].evidenceRefs = ["e1"];
		input.goal.criteria[0].evidence = [{
			id: "e1",
			kind: "artifact",
			summary: "Progress evidence recorded before review",
			recordedAt: 1_500,
			origin: "agent",
			verification: "unverified",
		}];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.patch.evidenceLedger?.length, 1);
		assert.equal(result.patch.evidenceLedger?.[0].verification, "verified");
		assert.equal(result.patch.criteria?.[0].evidence.length, 1);
		assert.equal(result.patch.criteria?.[0].evidence[0].verification, "verified");
		assert.equal(result.patch.criteria?.[0].evidence[0].summary, "Progress evidence recorded before review");
		assert.doesNotThrow(() => createGoalSnapshotV2({
			revision: 1,
			savedAt: input.now,
			action: "update",
			goal: { ...input.goal, ...result.patch, status: "complete", endedAt: input.now, updatedAt: input.now },
		}));
	});

	it("rejects a completion bundle that reuses an evidence id with a different kind", () => {
		const input = makeInput();
		input.goal.evidenceLedger = [{
			id: "e1",
			kind: "command",
			summary: "A different observation",
			recordedAt: 1_500,
			origin: "tool",
			verification: "verified",
		}];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /kind command, not artifact/);
	});

	it("canonicalizes an absolute reviewer artifact URI to the submitted relative artifact", () => {
		const input = makeInput();
		(input.reviewerResult.payload as Record<string, unknown>).artifacts = [{
			uri: input.file,
			digest: (input.reviewerResult.payload as any).artifacts[0].digest,
			sizeBytes: input.file ? fs.statSync(input.file).size : 0,
		}];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	});

	it("normalizes a sha256-prefixed reviewer receipt at the model-facing boundary", () => {
		const input = makeInput();
		const payload = input.reviewerResult.payload as { artifacts: Array<{ uri: string; digest: string; sizeBytes: number }> };
		const expectedDigest = payload.artifacts[0].digest;
		payload.artifacts[0].digest = `sha256:${expectedDigest}`;
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
		if (!result.ok) return;
		assert.equal(result.bundle.evaluation.observedArtifacts[0].digest.value, expectedDigest);
	});

	it("ignores reviewer-only evidence IDs only when each blocking criterion still cites submitted evidence", () => {
		const input = makeInput();
		(input.reviewerResult.payload as any).criterionCoverage = [{
			criterionId: "c1",
			status: "satisfied",
			evidenceIds: ["e1", "reviewer-private-observation"],
		}];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
		if (result.ok) assert.match(result.bundle.evaluation.advisories.join(" "), /reviewer-private-observation/);
	});

	it("rejects reviewer acceptance when no submitted evidence supports a blocking criterion", () => {
		const input = makeInput();
		(input.reviewerResult.payload as any).criterionCoverage = [{
			criterionId: "c1",
			status: "satisfied",
			evidenceIds: ["reviewer-private-observation"],
		}];
		const result = prepareCompletionBundleV3(input);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /without a submitted evidence reference/);
	});

	it("distinguishes an identical idempotent replay from conflicting key reuse", () => {
		const input = makeInput();
		const committed = prepareCompletionBundleV3(input);
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		const completedGoal = { ...input.goal, ...committed.patch, status: "complete" as const, endedAt: input.now };
		const replay = prepareCompletionBundleV3({ ...input, goal: completedGoal });
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.reason, "IDEMPOTENT_REPLAY");
		const conflictAction = { ...input.action, summary: "different submission" };
		const conflict = prepareCompletionBundleV3({ ...input, goal: completedGoal, action: conflictAction });
		assert.equal(conflict.ok, false);
		if (!conflict.ok) assert.equal(conflict.reason, "IDEMPOTENCY_CONFLICT");

		const replayPreflight = preflightCompletionSubmissionV3(completedGoal, input.action);
		assert.equal(replayPreflight.outcome, "replay");
		const conflictPreflight = preflightCompletionSubmissionV3(completedGoal, conflictAction);
		assert.equal(conflictPreflight.outcome, "conflict");
	});

	it("marks a committed evaluation stale after artifact bytes change", () => {
		const input = makeInput();
		const committed = prepareCompletionBundleV3(input);
		assert.equal(committed.ok, true);
		if (!committed.ok) return;
		const completedGoal = { ...input.goal, ...committed.patch, status: "complete" as const, endedAt: input.now };
		assert.equal(inspectCommittedArtifactsV3(completedGoal, input.cwd, input.now + 1).status, "current");
		fs.writeFileSync(input.file, "changed after commit\n");
		const integrity = inspectCommittedArtifactsV3(completedGoal, input.cwd, input.now + 2);
		assert.equal(integrity.status, "stale");
		assert.equal(integrity.staleArtifacts[0]?.reason, "digest_mismatch");
	});
});
