import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	cloneGoalSnapshotV2,
	createGoalStateV2,
	createGoalSnapshotV2,
	decodeGoalSnapshot,
	SHADOW_COMPLETION_ADVISORY,
	stableLegacyEvidenceId,
	type DecodeGoalSnapshotResult,
	type GoalStateV2,
} from "../extensions/state";
import { createInitialRuntimeMetadataV3 } from "../extensions/goal-contract-v3";

function makeV1Goal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "goal-1",
		objective: "Finish the migration",
		status: "active",
		criteria: [{ id: "c1", description: "Tests pass", evidence: ["npm test passed"] }],
		constraints: ["no commit"],
		tokenBudget: null,
		tokensUsed: 120,
		timeUsedMs: 4_000,
		createdAt: 1_000,
		updatedAt: 5_000,
		noProgressCount: 0,
		autoTurnCount: 2,
		pausedReason: null,
		blocker: null,
		completionEvidence: null,
		...overrides,
	};
}

function makeV1Snapshot(goalOverrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { action: "update", goal: makeV1Goal(goalOverrides) };
}

function assertDecoded(result: DecodeGoalSnapshotResult): asserts result is Extract<DecodeGoalSnapshotResult, { ok: true }> {
	assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

describe("decodeGoalSnapshot V1 migration", () => {
	it("migrates unversioned state and preserves terminal complete", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot({
			status: "complete",
			completionEvidence: "All requested work is done.",
		}), { legacyRevision: 9, entryTimestamp: 6_000 });
		assertDecoded(result);

		assert.equal(result.migratedFrom, 1);
		assert.equal(result.snapshot.schemaVersion, 2);
		assert.equal(result.snapshot.revision, 9);
		assert.equal(result.snapshot.savedAt, 6_000);
		assert.equal(result.snapshot.goal?.status, "complete");
		assert.equal(result.snapshot.goal?.endedAt, 5_000);
		assert.equal(result.snapshot.goal?.completion.summary, "All requested work is done.");
		assert.equal(result.snapshot.goal?.completion.requestedAt, 5_000);
	});

	it("maps legacy single to direct", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot({
			executionMode: "single",
			singleRationale: "The work is tightly scoped.",
		}));
		assertDecoded(result);
		assert.deepEqual(result.snapshot.goal?.execution, {
			preference: "direct",
			selected: "direct",
			source: "legacy",
			confidence: 1,
			reasons: ["V1 explicitly selected single-agent execution."],
			reassessOn: ["scope_expanded", "stalled"],
		});
	});

	it("maps legacy orchestrated to auto with specialist minimum", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot({ executionMode: "orchestrated" }));
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.execution.preference, "auto");
		assert.equal(result.snapshot.goal?.execution.minimum, "specialist");
		assert.equal(result.snapshot.goal?.execution.selected, "specialist");
	});

	it("maps a missing legacy mode to direct", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot());
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.execution.preference, "direct");
		assert.equal(result.snapshot.goal?.execution.minimum, undefined);
		assert.equal(result.snapshot.goal?.execution.selected, "direct");
	});

	it("preserves V1 missing taskType semantics as coding", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot());
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.taskKind, "coding");
		assert.ok(result.warnings.some((warning) => warning.includes("taskType")));
	});

	it("migrates string evidence into one global ledger with criterion references", () => {
		const snapshot = makeV1Snapshot({
			criteria: [{ id: "criterion-a", description: "Verified", evidence: ["source A", "source B"] }],
		});
		const first = decodeGoalSnapshot(snapshot);
		const second = decodeGoalSnapshot(snapshot);
		assertDecoded(first);
		assertDecoded(second);

		const firstEvidence = first.snapshot.goal!.evidenceLedger;
		const secondEvidence = second.snapshot.goal!.evidenceLedger;
		assert.deepEqual(firstEvidence.map((item) => item.id), secondEvidence.map((item) => item.id));
		assert.deepEqual(firstEvidence.map((item) => item.summary), ["source A", "source B"]);
		assert.deepEqual(firstEvidence.map((item) => item.excerpt), ["source A", "source B"]);
		assert.ok(firstEvidence.every((item) => item.locator === undefined));
		assert.ok(firstEvidence.every((item) => item.kind === "legacy_text"));
		assert.ok(firstEvidence.every((item) => item.verification === "unverified"));
		assert.notEqual(firstEvidence[0].id, firstEvidence[1].id);
		assert.deepEqual(first.snapshot.goal!.criteria[0].evidenceRefs, firstEvidence.map((item) => item.id));
		assert.equal(first.snapshot.goal!.criteria[0].level, "blocking");
	});

	it("uses the locked exact stable legacy evidence ID", () => {
		assert.equal(stableLegacyEvidenceId("c1", 0, "same"), "legacy:c1:0");
		assert.equal(stableLegacyEvidenceId("c1", 0, "changed"), "legacy:c1:0");
	});

	it("preserves a legacy reviewer verdict and assurance decision as audit data", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot({
			taskType: "research",
			reviewerPassed: true,
			reviewerAgentId: "agent-reviewer",
			reviewerSessionFile: "/legacy/reviewer.jsonl",
			reviewerVerdict: {
				model: "provider/model",
				verifiedSources: 3,
				checksPassed: true,
				reportPath: "/legacy/report.md",
				notes: "Approved",
			},
		}));
		assertDecoded(result);
		const evaluation = result.snapshot.goal?.completion.lastEvaluation;
		assert.equal(evaluation?.decision, "accept");
		assert.equal(evaluation?.evaluator.kind, "legacy_reviewer");
		assert.equal(evaluation?.evaluator.agentId, "agent-reviewer");
		assert.equal(evaluation?.fingerprint, null);
		assert.equal(result.snapshot.goal?.assurance.reviewRequirement, "required");
		assert.equal(result.snapshot.goal?.assurance.reviewStatus, "passed");
	});

	it("initializes claims and rejection history without inventing facts", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot());
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.endedAt, null);
		assert.deepEqual(result.snapshot.goal?.claims, []);
		assert.equal(result.snapshot.goal?.completion.requestedAt, null);
		assert.deepEqual(result.snapshot.goal?.completion.rejectionHistory, []);
		assert.equal(result.snapshot.goal?.completion.rejectionCount, 0);
	});

	it("migrates a V1 clear without inventing a goal", () => {
		const result = decodeGoalSnapshot({ action: "clear", goal: null }, { entryTimestamp: 8_000, legacyRevision: 3 });
		assertDecoded(result);
		assert.equal(result.snapshot.goal, null);
		assert.equal(result.snapshot.action, "clear");
		assert.equal(result.snapshot.savedAt, 8_000);
	});
});

describe("GoalSnapshotV2 validation and cloning", () => {
	function migratedGoal(): GoalStateV2 {
		const result = decodeGoalSnapshot(makeV1Snapshot());
		assertDecoded(result);
		return result.snapshot.goal!;
	}

	function nativeGoal(): GoalStateV2 {
		const goal = migratedGoal();
		goal.migration = null;
		return goal;
	}

	it("creates a validated deep clone", () => {
		const sourceGoal = migratedGoal();
		const snapshot = createGoalSnapshotV2({
			revision: 4,
			savedAt: 9_000,
			action: "update",
			goal: sourceGoal,
		});
		sourceGoal.evidenceLedger[0].summary = "mutated source";
		sourceGoal.execution.preference = "team";

		assert.equal(snapshot.goal?.evidenceLedger[0].summary, "npm test passed");
		assert.equal(snapshot.goal?.execution.preference, "direct");

		const secondClone = cloneGoalSnapshotV2(snapshot);
		snapshot.goal!.evidenceLedger[0].summary = "mutated first clone";
		assert.equal(secondClone.goal?.evidenceLedger[0].summary, "npm test passed");
	});

	it("round-trips native V2 without migration", () => {
		const snapshot = createGoalSnapshotV2({ revision: 2, savedAt: 7_000, action: "status", goal: migratedGoal() });
		const result = decodeGoalSnapshot(snapshot);
		assertDecoded(result);
		assert.equal(result.migratedFrom, null);
		assert.deepEqual(result.snapshot, snapshot);
	});

	it("mechanically initializes the durable outcome marker for an older V2 snapshot", () => {
		const goal = migratedGoal();
		delete (goal as Partial<GoalStateV2>).progress;
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 2, savedAt: 7_000, action: "status", goal });
		assertDecoded(result);
		assert.deepEqual(result.snapshot.goal?.progress, {
			outcomeRevision: 0,
			lastOutcomeDeltaAt: 5_000,
			lastEvaluatedOutcomeRevision: null,
		});
	});

	it("round-trips optional Contract V3 lineage without requiring it on older V2 snapshots", () => {
		const goal = migratedGoal();
		goal.runtime = createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: "interactive" });
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 2, savedAt: 7_000, action: "update", goal });
		assertDecoded(result);
		assert.deepEqual(result.snapshot.goal?.runtime, goal.runtime);

		delete goal.runtime;
		const legacyV2 = decodeGoalSnapshot({ schemaVersion: 2, revision: 3, savedAt: 8_000, action: "update", goal });
		assertDecoded(legacyV2);
		assert.equal(legacyV2.snapshot.goal?.runtime, undefined);
	});

	it("round-trips an atomic V3 completion receipt", () => {
		const goal = migratedGoal();
		goal.runtime = createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: "headless" });
		goal.status = "complete";
		goal.endedAt = 6_000;
		goal.completion.requestedAt = 5_500;
		goal.completion.lastEvaluation = {
			decision: "accept", evaluatedAt: 5_600, criterionCoverage: [], claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "reviewer", agentId: "r1", reportDigest: "b".repeat(64) }, fingerprint: null,
		};
		goal.completionTransaction = {
			contractVersion: 3,
			idempotencyKey: "complete-1",
			requestDigest: "d".repeat(64),
			bundleDigest: "a".repeat(64),
			lineage: { goalDefinitionId: goal.runtime.goalDefinitionId, revisionId: goal.runtime.revisionId, runId: goal.runtime.runId, attemptId: goal.runtime.attemptId },
			artifacts: [{ id: "artifact-1", uri: "result.md", digest: { algorithm: "sha256", value: "c".repeat(64) }, sizeBytes: 1, createdByAttemptId: goal.runtime.attemptId, createdAt: 5_000, verifiedAt: 5_500 }],
			reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", digest: "b".repeat(64) },
			committedAt: 5_600,
		};
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 4, savedAt: 6_000, action: "update", goal });
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.completionTransaction?.reviewerResultRef.role, "goal-reviewer");
		assert.equal(result.snapshot.goal?.completionTransaction?.artifacts[0].sizeBytes, 1);
	});

	it("conservatively marks evaluations stale when an older V2 snapshot has no freshness marker", () => {
		const goal = migratedGoal();
		goal.completion.lastEvaluation = {
			decision: "accept",
			evaluatedAt: 4_000,
			criterionCoverage: [{
				criterionId: "c1", status: "satisfied", evidenceRefs: [goal.evidenceLedger[0].id], reason: "Covered before later evidence.",
			}],
			claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "judge" }, fingerprint: null,
		};
		delete (goal as Partial<GoalStateV2>).progress;
		const withoutProgress = decodeGoalSnapshot({ schemaVersion: 2, revision: 2, savedAt: 7_000, action: "update", goal });
		assertDecoded(withoutProgress);
		assert.equal(withoutProgress.snapshot.goal?.progress.lastEvaluatedOutcomeRevision, null);
		assert.equal(withoutProgress.snapshot.goal?.progress.lastOutcomeDeltaAt, 5_000);

		const markerlessGoal = withoutProgress.snapshot.goal!;
		markerlessGoal.progress = { outcomeRevision: 3, lastOutcomeDeltaAt: 5_000, lastEvaluatedOutcomeRevision: null };
		delete (markerlessGoal.progress as Partial<GoalStateV2["progress"]>).lastEvaluatedOutcomeRevision;
		const withoutMarker = decodeGoalSnapshot({ schemaVersion: 2, revision: 3, savedAt: 7_000, action: "update", goal: markerlessGoal });
		assertDecoded(withoutMarker);
		assert.equal(withoutMarker.snapshot.goal?.progress.lastEvaluatedOutcomeRevision, null);
	});

	it("fails closed on an impossible durable outcome timestamp", () => {
		const goal = migratedGoal();
		goal.progress = { outcomeRevision: 2, lastOutcomeDeltaAt: goal.updatedAt + 1, lastEvaluatedOutcomeRevision: null };
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 3, savedAt: 7_000, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /lastOutcomeDeltaAt must be between/);
	});

	it("fails closed on a future version", () => {
		const result = decodeGoalSnapshot({ schemaVersion: 3, revision: 1, savedAt: 1, action: "clear", goal: null });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.kind, "future_version");
			assert.equal(result.version, 3);
		}
	});

	it("fails closed on corrupt revision and savedAt", () => {
		const goal = migratedGoal();
		const badRevision = decodeGoalSnapshot({ schemaVersion: 2, revision: -1, savedAt: 1, action: "update", goal });
		assert.equal(badRevision.ok, false);
		assert.equal(badRevision.ok ? "" : badRevision.kind, "corrupt");

		const badSavedAt = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: Number.NaN, action: "update", goal });
		assert.equal(badSavedAt.ok, false);
		assert.equal(badSavedAt.ok ? "" : badSavedAt.kind, "corrupt");
	});

	it("fails closed when clear action and goal disagree", () => {
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "clear", goal: migratedGoal() });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /clear action.*null goal/i);
	});

	it("fails closed when endedAt disagrees with terminal status", () => {
		const terminalGoal = migratedGoal();
		terminalGoal.status = "complete";
		terminalGoal.endedAt = null;
		const missingEnd = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal: terminalGoal });
		assert.equal(missingEnd.ok, false);
		assert.match(missingEnd.ok ? "" : missingEnd.message, /endedAt must be set exactly/);

		const activeGoal = migratedGoal();
		activeGoal.endedAt = activeGoal.updatedAt;
		const prematureEnd = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal: activeGoal });
		assert.equal(prematureEnd.ok, false);
		assert.match(prematureEnd.ok ? "" : prematureEnd.message, /endedAt must be set exactly/);
	});

	it("fails closed on corrupt V1 nested evidence", () => {
		const result = decodeGoalSnapshot(makeV1Snapshot({
			criteria: [{ id: "c1", description: "bad", evidence: [123] }],
		}));
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.kind, "corrupt");
	});

	it("fails closed on missing evidence summary and unknown reassessment triggers", () => {
		const evidenceGoal = migratedGoal();
		delete (evidenceGoal.evidenceLedger[0] as { summary?: string }).summary;
		const evidenceResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal: evidenceGoal });
		assert.equal(evidenceResult.ok, false);
		assert.match(evidenceResult.ok ? "" : evidenceResult.message, /summary must be a string/);

		const executionGoal = migratedGoal();
		(executionGoal.execution.reassessOn as string[]) = ["scope_change"];
		const executionResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal: executionGoal });
		assert.equal(executionResult.ok, false);
		assert.match(executionResult.ok ? "" : executionResult.message, /reassessOn\[0\].*unsupported/);
	});

	it("fails closed on dangling criterion and claim evidence references", () => {
		const goal = migratedGoal();
		goal.criteria[0].evidenceRefs = ["missing"];
		const criterionResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal });
		assert.equal(criterionResult.ok, false);
		assert.match(criterionResult.ok ? "" : criterionResult.message, /unknown evidence missing/);

		const claimGoal = migratedGoal();
		claimGoal.claims = [{ id: "claim-1", text: "A material claim", materiality: "material", evidenceRefs: ["missing"] }];
		const claimResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal: claimGoal });
		assert.equal(claimResult.ok, false);
		assert.match(claimResult.ok ? "" : claimResult.message, /unknown evidence missing/);
	});

	it("validates all canonical evidence kinds and metadata", () => {
		const goal = migratedGoal();
		const command = {
			id: "command-1",
			kind: "command" as const,
			summary: "Full test suite passed",
			sourceKind: "workspace" as const,
			independenceKey: "local-test-run",
			excerpt: "npm test: 249 passed",
			recordedAt: 8_000,
			origin: "tool" as const,
			verification: "verified" as const,
		};
		goal.evidenceLedger.push(command);
		goal.criteria[0].evidenceRefs.push("command-1");
		goal.criteria[0].evidence.push({
			id: command.id,
			kind: "tool_result",
			summary: command.summary,
			sourceKind: command.sourceKind,
			independenceKey: command.independenceKey,
			recordedAt: command.recordedAt,
			origin: command.origin,
			verification: command.verification,
		});
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.evidenceLedger.at(-1)?.kind, "command");
		assert.equal(result.snapshot.goal?.evidenceLedger.at(-1)?.summary, "Full test suite passed");
		assert.equal(result.snapshot.goal?.evidenceLedger.at(-1)?.locator, undefined);
		assert.equal(result.snapshot.goal?.evidenceLedger.at(-1)?.independenceKey, "local-test-run");
		assert.equal(result.snapshot.goal?.criteria[0].evidence.at(-1)?.kind, "tool_result");
	});

	it("validates claim coverage, findings, advisories, fingerprint, and rejection counters", () => {
		const goal = migratedGoal();
		const evidenceId = goal.evidenceLedger[0].id;
		goal.claims = [{ id: "claim-1", text: "A claim", materiality: "material", risk: "high", evidenceRefs: [evidenceId] }];
		goal.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 8_000,
			criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceRefs: [evidenceId], reason: "Covered" }],
			claimCoverage: [{ claimId: "claim-1", status: "insufficient", evidenceRefs: [evidenceId], reason: "Needs corroboration" }],
			findings: [{ code: "high_risk_claim_needs_corroboration", subjectId: "claim-1", missingEvidenceKind: "source", reason: "One origin" }],
			advisories: ["Use a primary source."],
			evaluator: { kind: "judge", model: "provider/model" },
			fingerprint: "fingerprint-1",
		};
		goal.completion.rejectionHistory = ["fingerprint-1"];
		goal.completion.rejectionCount = 1;
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 5, savedAt: 8_000, action: "update", goal });
		assertDecoded(result);
		assert.equal(result.snapshot.goal?.completion.lastEvaluation?.claimCoverage[0].status, "insufficient");
		assert.equal(result.snapshot.goal?.completion.lastEvaluation?.findings[0].missingEvidenceKind, "source");
		assert.equal(result.snapshot.goal?.completion.rejectionCount, 1);
	});

	it("fails closed when completion coverage references unknown criteria or claims", () => {
		const criterionGoal = migratedGoal();
		criterionGoal.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 8_000,
			criterionCoverage: [{ criterionId: "missing-criterion", status: "unsatisfied", evidenceRefs: [], reason: "Missing" }],
			claimCoverage: [],
			findings: [],
			advisories: [],
			evaluator: { kind: "judge" },
			fingerprint: "criterion-fingerprint",
		};
		const criterionResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal: criterionGoal });
		assert.equal(criterionResult.ok, false);
		assert.match(criterionResult.ok ? "" : criterionResult.message, /criterion coverage references unknown criterion missing-criterion/);

		const claimGoal = migratedGoal();
		claimGoal.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 8_000,
			criterionCoverage: [],
			claimCoverage: [{ claimId: "missing-claim", status: "insufficient", evidenceRefs: [], reason: "Missing" }],
			findings: [],
			advisories: [],
			evaluator: { kind: "judge" },
			fingerprint: "claim-fingerprint",
		};
		const claimResult = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal: claimGoal });
		assert.equal(claimResult.ok, false);
		assert.match(claimResult.ok ? "" : claimResult.message, /claim coverage references unknown claim missing-claim/);
	});

	it("fails closed when a completion finding references an unknown subject", () => {
		const goal = migratedGoal();
		goal.completion.lastEvaluation = {
			decision: "blocked",
			evaluatedAt: 8_000,
			criterionCoverage: [],
			claimCoverage: [],
			findings: [{ code: "unknown_subject", subjectId: "missing-subject", reason: "Invalid reference" }],
			advisories: [],
			evaluator: { kind: "judge" },
			fingerprint: "subject-fingerprint",
		};
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /completion finding references unknown subject missing-subject/);
	});

	it("fails closed when a completion finding references unknown evidence", () => {
		const goal = migratedGoal();
		goal.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 8_000,
			criterionCoverage: [],
			claimCoverage: [],
			findings: [{ code: "evidence", subjectId: "c1", reason: "Bad evidence", evidenceRefs: ["missing-evidence"] }],
			advisories: [],
			evaluator: { kind: "reviewer" },
			fingerprint: "finding-evidence",
		};
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /completion finding.*unknown evidence missing-evidence/i);
	});

	it("accepts criterion, claim, $goal, and $judge finding subjects", () => {
		const goal = migratedGoal();
		goal.claims = [{ id: "claim-1", text: "A claim", materiality: "material", evidenceRefs: [] }];
		goal.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 8_000,
			criterionCoverage: [],
			claimCoverage: [],
			findings: [
				{ code: "criterion", subjectId: "c1", reason: "Criterion finding" },
				{ code: "claim", subjectId: "claim-1", reason: "Claim finding" },
				{ code: "goal", subjectId: "$goal", reason: "Goal finding" },
				{ code: "judge", subjectId: "$judge", reason: "Judge finding" },
			],
			advisories: [],
			evaluator: { kind: "judge" },
			fingerprint: "valid-subjects",
		};
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assertDecoded(result);
		assert.deepEqual(result.snapshot.goal?.completion.lastEvaluation?.findings.map((finding) => finding.subjectId), [
			"c1",
			"claim-1",
			"$goal",
			"$judge",
		]);
	});

	it("accepts stable coverage and findings for an existing explicit constraint", () => {
		const snapshot = createGoalSnapshotV2({ revision: 1, savedAt: 10, action: "update", goal: migratedGoal() });
		const goal = snapshot.goal!;
		goal.constraints = ["Do not publish"];
		goal.completion.lastEvaluation = {
			decision: "revise", evaluatedAt: 10,
			criterionCoverage: [{ criterionId: "$constraint:0", status: "unsatisfied", evidenceRefs: [], reason: "No verification" }],
			claimCoverage: [],
			findings: [{ code: "blocking_requirement_unsatisfied", subjectId: "$constraint:0", reason: "Constraint not verified" }],
			advisories: [], evaluator: { kind: "judge" }, fingerprint: "f".repeat(64),
		};
		assert.equal(decodeGoalSnapshot(snapshot).ok, true);
		goal.completion.lastEvaluation.criterionCoverage[0].criterionId = "$constraint:1";
		assert.equal(decodeGoalSnapshot(snapshot).ok, false);
	});

	it("fails closed when embedded evidence contradicts the canonical ledger", () => {
		const goal = migratedGoal();
		goal.criteria[0].evidence[0].summary = "Contradictory embedded summary";
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /embedded evidence\[0\]\.summary conflicts with canonical evidence legacy:c1:0/);
	});

	it("fails closed when embedded evidence has no canonical ledger entry", () => {
		const goal = migratedGoal();
		goal.criteria[0].evidence.push({
			id: "embedded-only",
			kind: "observation",
			summary: "Embedded only",
			origin: "agent",
			recordedAt: 8_000,
			verification: "unverified",
		});
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /embedded evidence references unknown canonical evidence embedded-only/);
	});

	it("rejects a rejection count larger than its history", () => {
		const goal = migratedGoal();
		goal.completion.rejectionCount = 1;
		const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 1, action: "update", goal });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /rejectionCount exceeds/);
	});

	it("fails closed on contradictory assurance state", () => {
		const cases: Array<(goal: GoalStateV2) => void> = [
			(goal) => { goal.assurance.reviewRequirement = "none"; goal.assurance.reviewStatus = "pending"; },
			(goal) => { goal.assurance.reviewRequirement = "none"; goal.assurance.independent = true; },
			(goal) => { goal.assurance.reviewRequirement = "required"; goal.assurance.reviewStatus = "not_required"; },
			(goal) => {
				goal.assurance.reviewRequirement = "advisory";
				goal.assurance.reviewStatus = "pending";
				goal.assurance.independent = false;
			},
		];
		for (const mutate of cases) {
			const goal = nativeGoal();
			mutate(goal);
			const result = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal });
			assert.equal(result.ok, false);
			assert.match(result.ok ? "" : result.message, /assurance/);
		}
	});

	it("requires a coherent accepted audit for native V2 completion", () => {
		const completed = nativeGoal();
		completed.status = "complete";
		completed.endedAt = completed.updatedAt;
		completed.completion.summary = "Done";
		completed.completion.requestedAt = completed.updatedAt;

		const missing = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal: completed });
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.message, /lastEvaluation.*required/);

		completed.completion.lastEvaluation = {
			decision: "revise", evaluatedAt: completed.updatedAt,
			criterionCoverage: [], claimCoverage: [], findings: [], advisories: [],
			evaluator: { kind: "judge" }, fingerprint: null,
		};
		const rejected = decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal: completed });
		assert.equal(rejected.ok, false);
		assert.match(rejected.ok ? "" : rejected.message, /accepted completion audit/);

		completed.completion.lastEvaluation = {
			...completed.completion.lastEvaluation,
			decision: "accept",
		};
		assert.equal(decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal: completed }).ok, true);
	});

	it("allows an explicitly marked non-authoritative shadow audit on a completed canary goal", () => {
		const goal = nativeGoal();
		goal.status = "complete";
		goal.endedAt = goal.updatedAt;
		goal.completion.summary = "Legacy judge accepted while V2 ran in shadow.";
		goal.completion.requestedAt = goal.updatedAt;
		goal.completion.lastEvaluation = {
			decision: "revise", evaluatedAt: goal.updatedAt,
			criterionCoverage: [], claimCoverage: [], findings: [],
			advisories: [SHADOW_COMPLETION_ADVISORY], evaluator: { kind: "judge" }, fingerprint: null,
		};
		assert.equal(decodeGoalSnapshot({ schemaVersion: 2, revision: 1, savedAt: 8_000, action: "update", goal }).ok, true);
	});
});

describe("createGoalStateV2", () => {
	it("creates a canonical empty-ledger goal from locked routing and assurance decisions", () => {
		const goal = createGoalStateV2({
			id: "new-goal",
			objective: "Do focused work",
			criteria: [
				{ id: "must", description: "Required output" },
				{ id: "nice", description: "Optional context", level: "advisory" },
			],
			taskKind: "general",
			execution: {
				preference: "auto",
				selected: "direct",
				source: "auto",
				confidence: 0.9,
				reasons: ["Single lane"],
				reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
			},
			assurance: {
				reviewRequirement: "none",
				reviewStatus: "not_required",
				independent: false,
				depth: "light",
				source: "auto",
				reasons: ["Low risk with deterministic verification"],
				decidedAt: 10_000,
			},
			now: 10_000,
		});
		assert.equal(goal.taskKind, "general");
		assert.deepEqual(goal.criteria.map((item) => item.level), ["blocking", "advisory"]);
		assert.deepEqual(goal.evidenceLedger, []);
		assert.deepEqual(goal.claims, []);
		assert.equal(goal.execution.selected, "direct");
		assert.deepEqual(goal.execution.reassessOn, ["scope_expanded", "new_workstream", "conflict", "stalled"]);
		assert.equal(goal.endedAt, null);
		assert.equal(goal.completion.requestedAt, null);
	});

	it("rejects out-of-range execution confidence", () => {
		assert.throws(() => createGoalStateV2({
			id: "bad",
			objective: "bad confidence",
			criteria: [],
			taskKind: "general",
			execution: {
				preference: "auto",
				selected: "direct",
				source: "auto",
				confidence: 1.1,
				reasons: [],
				reassessOn: [],
			},
			assurance: {
				reviewRequirement: "none",
				reviewStatus: "not_required",
				independent: false,
				depth: "light",
				source: "auto",
				reasons: [],
				decidedAt: 1,
			},
			now: 1,
		}), /confidence.*<= 1/);
	});
});
