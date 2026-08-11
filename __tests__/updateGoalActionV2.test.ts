import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	normalizeUpdateGoalAction,
	type NormalizeUpdateGoalActionResult,
} from "../extensions/update-goal-action-v2";

function normalized(result: NormalizeUpdateGoalActionResult) {
	assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	return result.action;
}

describe("canonical update_goal action union", () => {
	it("rejects structured record_evidence without an immutable id with a stable code", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: { kind: "artifact", summary: "Built artifact" },
			criterionIds: ["c1"],
		}, { now: 100 });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.kind, "invalid");
		assert.equal(result.code, "evidence_id_required");
		assert.equal(result.recovery, "provide_immutable_evidence_id");
		assert.match(result.reason, /immutable evidence\.id/);
	});

	it("routes a JSON-stringified evidence object to legacy with completionCompatible=false", () => {
		// 把结构化对象序列化成字符串不是合法输入：走 legacy 兼容会生成
		// legacy_text，而 V3 bundle 不接受该 kind——直接拒绝并给出恢复动作。
		const jsonString = JSON.stringify({ kind: "artifact", summary: "Built artifact" });
		const result = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: jsonString,
			criterionIds: ["c1"],
		}, { now: 100 });
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
		if (!result.ok) return;
		assert.equal(result.action.action, "record_evidence");
		if (result.action.action !== "record_evidence") return;
		assert.equal(result.action.completionCompatible, false, "string evidence must be flagged not completion-compatible");
	});

	it("marks structured evidence completionCompatible=true and preserves id/kind", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: { id: "ev:typed", kind: "artifact", summary: "Built artifact", verification: "verified" },
			criterionIds: ["c1"],
		}, { now: 100 });
		assert.equal(result.ok, true, result.ok ? undefined : result.reason);
		if (!result.ok) return;
		assert.equal(result.action.action, "record_evidence");
		if (result.action.action !== "record_evidence") return;
		assert.equal(result.action.completionCompatible, true);
		assert.equal(result.action.evidence?.id, "ev:typed");
		assert.equal(result.action.evidence?.kind, "artifact");
		assert.equal(result.action.evidence?.verification, "verified");
	});

	it("normalizes record_evidence with locator/time/origin defaults", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: { id: "ev1", kind: "artifact", summary: "Built artifact", excerpt: "artifact details" },
			criterionIds: ["c1", "c1"],
			claimId: "claim-1",
		}, { now: 100 }));
			assert.equal(action.action, "record_evidence");
			if (action.action !== "record_evidence") return;
			assert.ok(action.evidence);
		assert.equal(action.evidence.summary, "Built artifact");
		assert.equal(action.evidence.locator, undefined);
		assert.equal(action.evidence.recordedAt, 100);
		assert.equal(action.evidence.origin, "agent");
		assert.equal(action.evidence.verification, "unverified");
		assert.deepEqual(action.criterionIds, ["c1"]);
		assert.deepEqual(action.claimIds, ["claim-1"]);
	});

	it("normalizes reuse of one ledger ID across additional targets", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "record_evidence", evidenceId: "ev1", criterionId: "c2",
		}, { now: 200 }));
		assert.equal(action.action, "record_evidence");
		if (action.action !== "record_evidence") return;
		assert.equal(action.evidence, null);
		assert.equal(action.evidenceId, "ev1");
		assert.deepEqual(action.criterionIds, ["c2"]);
	});

	it("normalizes criterion targets nested inside evidence", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: {
				id: "ev1", kind: "artifact", summary: "Built artifact",
				criterionIds: ["c1", "c2"], claimIds: ["claim-1"],
			},
		}, { now: 100 }));
		assert.equal(action.action, "record_evidence");
		if (action.action !== "record_evidence") return;
		assert.deepEqual(action.criterionIds, ["c1", "c2"]);
		assert.deepEqual(action.claimIds, ["claim-1"]);
	});

	it("normalizes upsert_claim", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "upsert_claim",
			claim: { id: "claim-1", text: "A material claim", materiality: "material", risk: "high", evidenceRefs: ["e2", "e1", "e1"] },
		}, { now: 1 }));
		assert.equal(action.action, "upsert_claim");
		if (action.action === "upsert_claim") assert.deepEqual(action.claim.evidenceRefs, ["e1", "e2"]);
	});

	it("normalizes request_completion", () => {
		const action = normalized(normalizeUpdateGoalAction({ action: "request_completion", summary: "All blocking outcomes are met." }, { now: 1 }));
		assert.deepEqual(action, { action: "request_completion", summary: "All blocking outcomes are met." });
	});

	it("treats an explicit action as authoritative when optional defaults are noisy", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "request_completion",
			summary: "Done.",
			status: "",
			criterionIds: [],
			findings: [],
			reasons: [],
			reviewerPassed: false,
		}, { now: 1 }));
		assert.deepEqual(action, { action: "request_completion", summary: "Done." });
	});

	it("normalizes record_review", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "record_review",
				review: {
				status: "passed",
				reason: "Independent review passed.",
					evaluator: { kind: "reviewer", model: "provider/model", agentId: "review-1" },
					sessionFile: "/sessions/review-1.jsonl",
			},
		}, { now: 1 }));
		assert.equal(action.action, "record_review");
		if (action.action === "record_review") assert.equal(action.review.evaluator.agentId, "review-1");
	});

	it("normalizes patch-first review locations and rejects non-global rewrites", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "record_review",
			review: {
				status: "failed",
				reason: "One section needs repair.",
				evaluator: { kind: "reviewer", agentId: "review-1" },
				sessionFile: "/sessions/review-1.jsonl",
				findings: [{
					code: "R-017", subjectId: "$goal", reason: "Unsupported sentence",
					missingEvidenceKind: "source", scope: "local", targetPath: "sections/01.md",
					sectionId: "opening", anchor: "## Opening", requiredFix: "Add the source-backed limit.", rewriteRequired: false,
				}],
			},
		}, { now: 1 }));
		assert.equal(action.action, "record_review");
		if (action.action === "record_review") assert.equal(action.review.findings[0].targetPath, "sections/01.md");

		const invalid = normalizeUpdateGoalAction({
			action: "record_review",
			review: {
				status: "failed", reason: "bad", evaluator: { kind: "reviewer", agentId: "r" }, sessionFile: "/r.jsonl",
				findings: [{ code: "R", subjectId: "$goal", reason: "bad", missingEvidenceKind: "source", scope: "local", rewriteRequired: true, rewriteReason: "rewrite" }],
			},
		}, { now: 1 });
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.match(invalid.reason, /only when scope=global/);
	});

	it("normalizes change_execution", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "change_execution",
			execution: {
				preference: "auto",
				selected: "team",
				source: "auto",
				confidence: 0.8,
				reasons: ["Three independent lanes"],
				reassessOn: ["new_workstream"],
			},
		}, { now: 1 }));
			assert.equal(action.action, "change_execution");
			if (action.action === "change_execution") {
				assert.ok(action.execution);
				assert.equal(action.execution.selected, "team");
			}
		});

		it("normalizes a semantic runtime reassessment", () => {
			const action = normalized(normalizeUpdateGoalAction({
				action: "change_execution",
				reassessTrigger: "new_workstream",
				routing: {
					uncertainty: "high", coupling: "low", risk: "low", specialistNeed: "helpful",
					independentWorkstreams: 3, heterogeneousSkills: true, effort: "large",
				},
			}, { now: 1 }));
			assert.equal(action.action, "change_execution");
			if (action.action !== "change_execution") return;
			assert.equal(action.execution, null);
			assert.equal(action.routing?.trigger, "new_workstream");
			assert.equal(action.routing?.signals.independentWorkstreams, 3);
		});

	it("normalizes mark_unmet", () => {
		const action = normalized(normalizeUpdateGoalAction({ action: "mark_unmet", blocker: "Needs a user credential." }, { now: 1 }));
		assert.deepEqual(action, { action: "mark_unmet", blocker: "Needs a user credential." });
	});

	it("normalizes a Contract V3 atomic completion bundle without inferring legacy actions", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "submit_completion_bundle",
			bundle: {
				idempotencyKey: "complete-1",
				summary: "Verified output",
				artifacts: [{ id: "a1", uri: "result.md", digest: "a".repeat(64), sizeBytes: 10 }],
				evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], claimIds: [], artifactId: "a1", digest: "a".repeat(64) }],
				deterministicChecks: [{ id: "checks", status: "passed", summary: "ok", evidenceIds: ["e1"] }],
				reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", status: "completed", digest: "b".repeat(64) },
			},
		}, { now: 1 }));
		assert.equal(action.action, "submit_completion_bundle");
		if (action.action !== "submit_completion_bundle") return;
		assert.equal(action.artifacts[0].sizeBytes, 10);
		assert.equal(action.reviewerResultRef.role, "goal-reviewer");
	});

	it("defaults omitted bundle evidence claimIds to an empty array", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "submit_completion_bundle",
			bundle: {
				idempotencyKey: "complete-without-claims",
				summary: "Verified output",
				artifacts: [{ id: "a1", uri: "result.md", digest: "a".repeat(64), sizeBytes: 10 }],
				evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], artifactId: "a1", digest: "a".repeat(64) }],
				reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", status: "completed", digest: "b".repeat(64) },
			},
		}, { now: 1 }));
		assert.equal(action.action, "submit_completion_bundle");
		if (action.action !== "submit_completion_bundle") return;
		assert.deepEqual(action.evidence[0].claimIds, []);
	});

	it("defaults omitted criterionIds and canonicalizes an artifact URI reference", () => {
		const action = normalized(normalizeUpdateGoalAction({
			action: "submit_completion_bundle",
			bundle: {
				idempotencyKey: "complete-with-uri-reference",
				summary: "Verified output",
				artifacts: [{ id: "decision-record", uri: "outputs/decision-record.md", digest: "a".repeat(64), sizeBytes: 10 }],
				evidence: [{ id: "e1", kind: "artifact", summary: "checked", artifactId: "outputs/decision-record.md", digest: "a".repeat(64) }],
				reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", status: "completed", digest: "b".repeat(64) },
			},
		}, { now: 1 }));
		assert.equal(action.action, "submit_completion_bundle");
		if (action.action !== "submit_completion_bundle") return;
		assert.deepEqual(action.evidence[0].criterionIds, []);
		assert.equal(action.evidence[0].artifactId, "decision-record");
	});

	describe("bundle evidence artifactId/digest pairing (CB-P0-01)", () => {
		const validPair = {
			action: "submit_completion_bundle",
			bundle: {
				idempotencyKey: "complete-pair",
				summary: "Verified output",
				artifacts: [{ id: "a1", uri: "result.md", digest: "a".repeat(64), sizeBytes: 10 }],
				evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], claimIds: [], artifactId: "a1", digest: "a".repeat(64) }],
				reviewerResultRef: { resultId: "role-result:r1", agentId: "r1", role: "goal-reviewer", status: "completed", digest: "b".repeat(64) },
			},
		};

		it("rejects artifactId without digest at the entry with a stable code and recovery", () => {
			const result = normalizeUpdateGoalAction({
				...validPair,
				bundle: { ...validPair.bundle, evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], claimIds: [], artifactId: "a1" }] },
			}, { now: 1 });
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.kind, "invalid");
			assert.equal(result.code, "artifact_reference_pair_required");
			assert.equal(result.recovery, "provide_artifactId_and_digest_together");
			assert.match(result.reason, /bundle\.evidence\[0\]/);
			assert.match(result.reason, /digest/);
		});

		it("rejects digest without artifactId at the entry with the same stable code", () => {
			const result = normalizeUpdateGoalAction({
				...validPair,
				bundle: { ...validPair.bundle, evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], claimIds: [], digest: "a".repeat(64) }] },
			}, { now: 1 });
			assert.equal(result.ok, false);
			if (result.ok) return;
			assert.equal(result.code, "artifact_reference_pair_required");
			assert.equal(result.recovery, "provide_artifactId_and_digest_together");
			assert.match(result.reason, /artifactId and digest must be provided together/);
		});

		it("keeps a valid paired digest untouched and canonicalizes a URI alias", () => {
			const result = normalizeUpdateGoalAction({
				...validPair,
				bundle: {
					...validPair.bundle,
					artifacts: [{ id: "decision-record", uri: "outputs/decision-record.md", digest: "a".repeat(64), sizeBytes: 10 }],
					evidence: [{ id: "e1", kind: "artifact", summary: "checked", criterionIds: ["c1"], claimIds: [], artifactId: "outputs/decision-record.md", digest: "a".repeat(64) }],
				},
			}, { now: 1 });
			const action = normalized(result);
			assert.equal(action.action, "submit_completion_bundle");
			if (action.action !== "submit_completion_bundle") return;
			assert.equal(action.evidence[0].artifactId, "decision-record");
			assert.equal(action.evidence[0].digest, "a".repeat(64));
		});

		it("accepts non-artifact evidence without artifactId or digest", () => {
			const result = normalizeUpdateGoalAction({
				...validPair,
				bundle: { ...validPair.bundle, evidence: [{ id: "e1", kind: "observation", summary: "observed", criterionIds: ["c1"], claimIds: [] }] },
			}, { now: 1 });
			const action = normalized(result);
			assert.equal(action.action, "submit_completion_bundle");
			if (action.action !== "submit_completion_bundle") return;
			assert.equal(action.evidence[0].artifactId, undefined);
			assert.equal(action.evidence[0].digest, undefined);
		});
	});
});

describe("legacy flat update_goal compatibility", () => {
	it("maps criterionId + evidence to stable legacy record_evidence", () => {
		const first = normalizeUpdateGoalAction({ criterionId: "c1", evidence: "npm test passed" }, { now: 5 });
		const second = normalizeUpdateGoalAction({ criterionId: "c1", evidence: "npm test passed" }, { now: 9 });
		const a = normalized(first);
		const b = normalized(second);
		assert.equal(first.ok && first.legacy, true);
		assert.equal(a.action, "record_evidence");
		assert.equal(b.action, "record_evidence");
			if (a.action === "record_evidence" && b.action === "record_evidence") {
				assert.ok(a.evidence);
				assert.ok(b.evidence);
			assert.equal(a.evidence.id, b.evidence.id);
			assert.equal(a.evidence.kind, "legacy_text");
			assert.equal(a.evidence.origin, "legacy");
			assert.equal(a.completionCompatible, false, "legacy string evidence must be flagged not completion-compatible");
			assert.deepEqual(a.criterionIds, ["c1"]);
		}
	});

	it("maps legacy complete and unmet statuses", () => {
		assert.deepEqual(
			normalized(normalizeUpdateGoalAction({ status: "complete", evidence: "Done with evidence" }, { now: 1 })),
			{ action: "request_completion", summary: "Done with evidence" },
		);
		assert.deepEqual(
			normalized(normalizeUpdateGoalAction({ status: "unmet", blocker: "External dependency" }, { now: 1 })),
			{ action: "mark_unmet", blocker: "External dependency" },
		);
	});

	it("maps a legacy reviewer verdict", () => {
		const action = normalized(normalizeUpdateGoalAction({
			reviewerPassed: true,
			reviewerAgentId: "agent-1",
			reviewerSessionFile: "/legacy/session.jsonl",
			reviewerVerdict: { model: "provider/model", reportPath: "/legacy/report.md", notes: "Approved" },
		}, { now: 1 }));
		assert.equal(action.action, "record_review");
		if (action.action !== "record_review") return;
		assert.equal(action.review.status, "passed");
		assert.equal(action.review.reason, "Approved");
		assert.equal(action.review.evaluator.kind, "legacy_reviewer");
		assert.equal(action.review.evaluator.legacyReportPath, "/legacy/report.md");
	});

	it("maps the legacy single-rationale pre-review", () => {
		const action = normalized(normalizeUpdateGoalAction({
				singleRationalePreApproved: false,
				singleRationaleReviewer: { model: "provider/model" },
				reviewerAgentId: "agent-pre-review",
				reviewerSessionFile: "/legacy/pre-review.jsonl",
		}, { now: 1 }));
		assert.equal(action.action, "record_review");
		if (action.action === "record_review") {
			assert.equal(action.review.status, "failed");
			assert.equal(action.review.evaluator.model, "provider/model");
		}
	});

	it("maps legacy single/orchestrated execution modes", () => {
		const direct = normalized(normalizeUpdateGoalAction({ executionMode: "single" }, { now: 1 }));
		const delegated = normalized(normalizeUpdateGoalAction({ executionMode: "orchestrated" }, { now: 1 }));
		assert.equal(direct.action === "change_execution" && direct.execution?.selected, "direct");
		assert.equal(delegated.action === "change_execution" && delegated.execution?.minimum, "specialist");
		if (direct.action === "change_execution") assert.deepEqual(direct.execution?.reassessOn, ["scope_expanded", "stalled"]);
		if (delegated.action === "change_execution") assert.deepEqual(delegated.execution?.reassessOn, ["scope_expanded", "new_workstream", "stalled"]);
	});
});

describe("atomic action enforcement", () => {
	it("rejects a legacy review and completion request in one call", () => {
		const result = normalizeUpdateGoalAction({
			status: "complete",
			evidence: "done",
			reviewerPassed: true,
		}, { now: 1 });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.kind, "mixed_action");
			assert.match(result.reason, /record_review.*request_completion|request_completion.*record_review/);
		}
	});

	it("rejects mixed canonical action fields", () => {
		const result = normalizeUpdateGoalAction({
			action: "request_completion",
			summary: "done",
			blocker: "but also blocked",
		}, { now: 1 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "mixed_action");
	});

	it("rejects unknown actions and malformed payloads", () => {
		assert.equal(normalizeUpdateGoalAction({ action: "finish" }, { now: 1 }).ok, false);
		assert.equal(normalizeUpdateGoalAction({ action: "request_completion", summary: "" }, { now: 1 }).ok, false);
		assert.equal(normalizeUpdateGoalAction({ action: "record_evidence", evidence: { id: "e1", kind: "unknown" } }, { now: 1 }).ok, false);
		assert.equal(normalizeUpdateGoalAction({
			action: "change_execution",
			execution: {
				preference: "auto", selected: "direct", source: "auto", confidence: 1,
				reasons: [], reassessOn: ["scope_change"],
			},
		}, { now: 1 }).ok, false);
	});
});
