import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	applyAuthoritativeCompletionEvaluation,
	applyShadowCompletionEvaluation,
	hasPendingCompletionRequest,
	parseV2JudgeResponse,
} from "../extensions/completion-runtime-v2";
import { createGoalStateV2, type CompletionEvaluation } from "../extensions/state";

function goal() {
	return createGoalStateV2({
		id: "g", objective: "ship", criteria: [{ id: "c", description: "works" }],
		taskKind: "coding", now: 1,
		execution: { preference: "direct", selected: "direct", source: "user", confidence: 1, reasons: [], reassessOn: [] },
		assurance: { reviewRequirement: "none", reviewStatus: "not_required", independent: false, depth: "light", source: "auto", reasons: [], decidedAt: 1 },
	});
}

function evaluation(fingerprint: string | null, decision: CompletionEvaluation["decision"] = "revise"): CompletionEvaluation {
	return {
		decision, evaluatedAt: 5, criterionCoverage: [], claimCoverage: [],
		findings: decision === "accept" ? [] : [{ code: "missing", subjectId: "c", reason: "missing" }],
		advisories: [], evaluator: { kind: "judge" }, fingerprint,
	};
}

describe("completion request ownership", () => {
	it("evaluates each request at most once", () => {
		const state = goal();
		assert.equal(hasPendingCompletionRequest(state), false);
		state.completion.requestedAt = 4;
		assert.equal(hasPendingCompletionRequest(state), true);
		state.completion.lastEvaluation = evaluation("a");
		assert.equal(hasPendingCompletionRequest(state), false);
		state.completion.requestedAt = 6;
		assert.equal(hasPendingCompletionRequest(state), true);
	});

	it("parses plain or fenced-ish JSON and leaves malformed output untrusted", () => {
		assert.deepEqual(parseV2JudgeResponse('{"outcome":"accept"}'), { outcome: "accept" });
		assert.deepEqual(parseV2JudgeResponse('note {"outcome":"continue"} tail'), { outcome: "continue" });
		assert.equal(parseV2JudgeResponse("not json"), "not json");
	});
});

describe("completion rejection escalation", () => {
	it("feeds back, replans, then pauses on the third identical fingerprint", () => {
		const state = goal();
		let next = applyAuthoritativeCompletionEvaluation(state, evaluation("same"));
		assert.equal(next.rejectionAction, "feedback");
		state.completion = next.completion;
		next = applyAuthoritativeCompletionEvaluation(state, evaluation("same"));
		assert.equal(next.rejectionAction, "replan");
		state.completion = next.completion;
		next = applyAuthoritativeCompletionEvaluation(state, evaluation("same"));
		assert.equal(next.rejectionAction, "pause");
		assert.equal(next.status, "paused");
	});

	it("a new fingerprint resets the consecutive count", () => {
		const state = goal();
		state.completion.rejectionHistory = ["old", "old"];
		state.completion.rejectionCount = 2;
		const next = applyAuthoritativeCompletionEvaluation(state, evaluation("new"));
		assert.equal(next.completion.rejectionCount, 1);
		assert.equal(next.status, "active");
	});

	it("shadow audit never changes rejection counters or status", () => {
		const state = goal();
		const completion = applyShadowCompletionEvaluation(state, evaluation("shadow"));
		assert.deepEqual(completion.rejectionHistory, []);
		assert.equal(completion.rejectionCount, 0);
	});

	it("accept completes and clears the consecutive rejection count", () => {
		const state = goal();
		state.completion.rejectionCount = 2;
		const next = applyAuthoritativeCompletionEvaluation(state, evaluation(null, "accept"));
		assert.equal(next.status, "complete");
		assert.equal(next.completion.rejectionCount, 0);
	});

	it("starts a fresh rejection streak after an intervening acceptance", () => {
		const rejected = applyAuthoritativeCompletionEvaluation(goal(), evaluation("same"));
		const acceptedGoal = {
			...goal(),
			completion: rejected.completion,
		};
		const accepted = applyAuthoritativeCompletionEvaluation(acceptedGoal, evaluation(null, "accept"));
		const rejectedAgain = applyAuthoritativeCompletionEvaluation({
			...goal(),
			completion: accepted.completion,
		}, evaluation("same"));
		assert.equal(rejectedAgain.rejectionAction, "feedback");
		assert.equal(rejectedAgain.completion.rejectionCount, 1);
	});
});
