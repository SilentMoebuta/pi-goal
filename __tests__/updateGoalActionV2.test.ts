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
