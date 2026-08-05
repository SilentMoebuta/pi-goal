import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canComplete, type CompletableGoal } from "../extensions/config";

function makeGoal(overrides: Partial<CompletableGoal> = {}): CompletableGoal {
	return { criteria: [{ evidence: ["evidence text"] }], ...overrides };
}

describe("legacy completion compatibility gate", () => {
	it("still rejects uncovered outcome criteria", () => {
		const result = canComplete(makeGoal({ criteria: [{ evidence: [] }, { evidence: ["x"] }] }));
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /evidence/i);
	});

	it("does not require review merely because a goal is non-coding", () => {
		for (const taskType of ["research", "pm", "review"] as const) {
			assert.equal(canComplete(makeGoal({ taskType, reviewerPassed: false })).ok, true);
		}
	});

	it("requires a real verdict when risk-based assurance selected review", () => {
		const missing = canComplete(makeGoal({ reviewRequired: true, reviewerPassed: false }));
		assert.equal(missing.ok, false);
		assert.match(missing.reason ?? "", /reviewer/i);

		const bare = canComplete(makeGoal({ reviewRequired: true, reviewerPassed: true }));
		assert.equal(bare.ok, false);
		assert.match(bare.reason ?? "", /verdict/i);
	});

	it("does not gate on reviewer model, thinking level, or URL count", () => {
		const result = canComplete(makeGoal({
			reviewRequired: true,
			reviewerPassed: true,
			reviewerVerdict: { thinkingLevel: "low", verifiedSources: 1, checksPassed: false },
		}));
		assert.equal(result.ok, true);
	});

	it("checks outcome evidence before assurance", () => {
		const result = canComplete(makeGoal({
			criteria: [{ evidence: [] }],
			reviewRequired: true,
			reviewerPassed: false,
		}));
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /evidence/i);
	});
});
