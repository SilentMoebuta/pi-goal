import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { serializeGoalText, type SerializableGoal } from "../extensions/config";

// serializeGoalText is the get_goal tool's text payload serializer.
// Previously this was an inline hand-written field whitelist in index.ts's
// get_goal handler, which silently dropped taskType/reviewerPassed/executionMode
// (the 深修 D/A fields) — only `details: { goal }` carried them. Extracted to a
// pure exported function so the serialization is unit-testable against the real
// implementation (not a spec-mirror, which would be circular).
//
// Bug origin: discovered during 深修 D live verification (goal-d-live-verification.md).
// The get_goal text output omitted taskType even though state held it; canComplete
// reads state (not text) so the gate still worked, but the user-facing text lied.

function makeGoal(overrides: Partial<SerializableGoal> = {}): SerializableGoal {
	return {
		objective: "test objective",
		status: "active",
		criteria: [{ id: "c1", description: "criterion 1", evidence: ["ev"] }],
		constraints: [],
		tokensUsed: 0,
		tokenBudget: null,
		timeUsedMs: 0,
		autoTurnCount: 0,
		// 深修 D/A fields default to undefined (legacy coding goal)
		...overrides,
	};
}

describe("serializeGoalText — 深修 D/A fields surface in get_goal text", () => {
	it("includes task_type when taskType is set (research)", () => {
		const text = serializeGoalText(makeGoal({ taskType: "research" }));
		const parsed = JSON.parse(text);
		assert.equal(parsed.task_type, "research", `expected task_type=research, got: ${text}`);
	});

	it("includes reviewer_passed when reviewerPassed is true", () => {
		const text = serializeGoalText(makeGoal({ taskType: "research", reviewerPassed: true }));
		const parsed = JSON.parse(text);
		assert.equal(parsed.reviewer_passed, true, `expected reviewer_passed=true, got: ${text}`);
	});

	it("includes execution_mode when executionMode is set (orchestrated)", () => {
		const text = serializeGoalText(makeGoal({ executionMode: "orchestrated" }));
		const parsed = JSON.parse(text);
		assert.equal(parsed.execution_mode, "orchestrated", `expected execution_mode=orchestrated, got: ${text}`);
	});

	it("includes reviewer_passed=false when explicitly false (research goal, not yet approved)", () => {
		// false is meaningful: research goal under review, not approved. Distinct from undefined.
		const text = serializeGoalText(makeGoal({ taskType: "research", reviewerPassed: false }));
		const parsed = JSON.parse(text);
		assert.equal(parsed.reviewer_passed, false, `expected reviewer_passed=false, got: ${text}`);
	});
});

describe("serializeGoalText — legacy/backward-compat (undefined taskType)", () => {
	it("OMITS task_type/reviewer_passed/execution_mode keys for legacy coding goal", () => {
		// undefined fields should be absent from JSON, not null — keeps legacy
		// goal output free of noise from fields that don't apply.
		const text = serializeGoalText(makeGoal()); // all three undefined
		const parsed = JSON.parse(text);
		assert.equal("task_type" in parsed, false, `task_type should be absent, got: ${text}`);
		assert.equal("reviewer_passed" in parsed, false, `reviewer_passed should be absent, got: ${text}`);
		assert.equal("execution_mode" in parsed, false, `execution_mode should be absent, got: ${text}`);
	});
});

describe("serializeGoalText — existing fields preserved (no regression)", () => {
	it("still serializes objective/status/criteria/constraints/tokens/time/turns", () => {
		const goal = makeGoal({
			objective: "do X",
			status: "active",
			criteria: [
				{ id: "c1", description: "first", evidence: [] },
				{ id: "c2", description: "second", evidence: ["a", "b"] },
			],
			constraints: ["no api keys"],
			tokensUsed: 500,
			tokenBudget: 1000,
			timeUsedMs: 90_000,
			autoTurnCount: 3,
		});
		const parsed = JSON.parse(serializeGoalText(goal));
		assert.equal(parsed.objective, "do X");
		assert.equal(parsed.status, "active");
		assert.equal(parsed.criteria.length, 2);
		assert.equal(parsed.criteria[0].done, false, "empty evidence → done false");
		assert.equal(parsed.criteria[1].done, true, "non-empty evidence → done true");
		assert.equal(parsed.criteria[1].evidence.length, 2);
		assert.deepEqual(parsed.constraints, ["no api keys"]);
		assert.equal(parsed.tokens_used, 500);
		assert.equal(parsed.token_budget, 1000);
		assert.equal(parsed.remaining_tokens, 500);
		assert.equal(parsed.time_used_seconds, 90);
		assert.equal(parsed.auto_turns, 3);
	});

	it("remaining_tokens is null when tokenBudget is null (unbounded)", () => {
		const parsed = JSON.parse(serializeGoalText(makeGoal({ tokenBudget: null, tokensUsed: 42 })));
		assert.equal(parsed.remaining_tokens, null);
		assert.equal(parsed.tokens_used, 42);
	});
});
