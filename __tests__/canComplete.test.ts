import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	canComplete,
	type CompletableGoal,
} from "../extensions/config";

// canComplete is a pure function gate: checks (1) all criteria have evidence
// and (2) for non-coding goals, an independent reviewer has APPROVED
// (reviewerPassed=true). Returns {ok, reason}. Backward-compat: undefined
// taskType and "coding" taskType have NO reviewer gate (legacy behavior intact).
//
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §三
// Root cause: SESSION_HANDOFF §八 根因2+4 (main agent 自审自评 = 循环论证)

function makeGoal(overrides: Partial<CompletableGoal> = {}): CompletableGoal {
	return {
		taskType: undefined,
		reviewerPassed: false,
		criteria: [{ evidence: ["evidence text"] }], // default: evidence-filled
		...overrides,
	};
}

describe("canComplete — criterion evidence gate (existing behavior preserved)", () => {
	it("rejects when any criterion lacks evidence", () => {
		const goal = makeGoal({
			criteria: [{ evidence: [] }, { evidence: ["x"] }],
		});
		const r = canComplete(goal);
		assert.equal(r.ok, false);
		assert.ok(r.reason?.match(/evidence/i), `reason should mention evidence, got: ${r.reason}`);
	});

	it("passes when all criteria have evidence (no taskType = legacy)", () => {
		const goal = makeGoal({ taskType: undefined });
		assert.equal(canComplete(goal).ok, true);
	});
});

describe("canComplete — reviewer gate for non-coding goals (深修 D)", () => {
	for (const t of ["research", "pm", "review"] as const) {
		it(`rejects ${t} goal without reviewer APPROVE`, () => {
			const goal = makeGoal({ taskType: t, reviewerPassed: false });
			const r = canComplete(goal);
			assert.equal(r.ok, false);
			assert.ok(r.reason?.match(/reviewer/i), `reason should mention reviewer, got: ${r.reason}`);
		});

		it(`rejects ${t} goal with reviewerPassed=true but NO reviewerVerdict (第2条: 裸布尔不再够)`, () => {
			const goal = makeGoal({ taskType: t, reviewerPassed: true, reviewerVerdict: undefined });
			const r = canComplete(goal);
			assert.equal(r.ok, false);
			assert.ok(r.reason?.match(/verdict/i), `should demand verdict, got: ${r.reason}`);
		});

		it(`rejects ${t} goal with reviewerVerdict failing contract (shallow thinking)`, () => {
			const goal = makeGoal({ taskType: t, reviewerPassed: true, reviewerVerdict: { thinkingLevel: "low", verifiedSources: 1, checksPassed: true } });
			assert.equal(canComplete(goal).ok, false);
		});

		it(`passes ${t} goal after reviewer APPROVE with valid verdict (第2条)`, () => {
			const goal = makeGoal({ taskType: t, reviewerPassed: true, reviewerVerdict: { model: "x/y", thinkingLevel: "medium", verifiedSources: 3, checksPassed: true } });
			assert.equal(canComplete(goal).ok, true);
		});
	}
});

describe("canComplete — backward-compat (coding/undefined have no reviewer gate)", () => {
	it("coding goal passes without reviewer APPROVE", () => {
		const goal = makeGoal({ taskType: "coding", reviewerPassed: false });
		assert.equal(canComplete(goal).ok, true);
	});

	it("undefined taskType (legacy) passes without reviewer APPROVE", () => {
		const goal = makeGoal({ taskType: undefined, reviewerPassed: false });
		assert.equal(canComplete(goal).ok, true);
	});

	it("coding goal passes with reviewerPassed=true but no verdict (backward-compat, 第2条只约束非 coding)", () => {
		const goal = makeGoal({ taskType: "coding", reviewerPassed: true, reviewerVerdict: undefined });
		assert.equal(canComplete(goal).ok, true);
	});
});

describe("canComplete — evidence gate takes precedence over reviewer gate", () => {
	it("research goal with missing evidence AND no reviewer → reports evidence first", () => {
		const goal = makeGoal({
			taskType: "research",
			reviewerPassed: false,
			criteria: [{ evidence: [] }],
		});
		const r = canComplete(goal);
		assert.equal(r.ok, false);
		// evidence check runs first (cheap, deterministic)
		assert.ok(r.reason?.match(/evidence/i), `should report evidence first, got: ${r.reason}`);
	});
});
