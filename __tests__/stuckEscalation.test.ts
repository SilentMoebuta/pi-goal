import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEscalationPrompt, type GoalConfig, DEFAULT_GOAL_CONFIG } from "../extensions/config";

// GG-3: stuck-escalation. When a goal stalls (no-progress), pi-goal can ask a
// configurable stronger model (stuckEscalateModel, trusted projects) for a
// fresh concrete next-step suggestion, injected into the next continuation
// before pausing. buildEscalationPrompt is the pure, unit-testable prompt
// builder; the model call + injection is runtime (exercised by a live probe).

describe("buildEscalationPrompt (GG-3 stuck escalation)", () => {
	it("includes the objective and the criteria progress summary", () => {
		const p = buildEscalationPrompt({
			objective: "Refactor the auth module to use JWT",
			criteriaSummary: "  \u2705 [c1] all tests pass\n  \u23F3 [c2] no warnings",
		});
		assert.ok(p.includes("Refactor the auth module to use JWT"), "objective present");
		assert.ok(p.includes("[c1] all tests pass"), "criteria summary present");
	});

	it("asks for a single concrete next step (not a plan dump)", () => {
		const p = buildEscalationPrompt({ objective: "X", criteriaSummary: "" });
		assert.ok(/concrete|next step|single|one/i.test(p), "asks for a concrete next step");
		assert.ok(/no preamble|no explanation|only|reply with/i.test(p), "constrains output format");
	});
});

describe("GoalConfig.stuckEscalateModel (GG-3 config wiring)", () => {
	it("is undefined by default (no escalation — pause-only, backward compatible)", () => {
		assert.equal(DEFAULT_GOAL_CONFIG.stuckEscalateModel, undefined);
	});
	it("is a valid typed field", () => {
		const c: GoalConfig = { superpowersIntegration: true, stuckEscalateModel: "anthropic/claude-sonnet-4" };
		assert.equal(c.stuckEscalateModel, "anthropic/claude-sonnet-4");
	});
});
