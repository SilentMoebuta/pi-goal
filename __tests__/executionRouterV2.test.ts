import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	reassessExecution,
	routeExecution,
	type ExecutionRoutingSignals,
} from "../extensions/execution-router-v2";

function signals(overrides: Partial<ExecutionRoutingSignals> = {}): ExecutionRoutingSignals {
	return {
		uncertainty: "low",
		coupling: "low",
		risk: "low",
		specialistNeed: "none",
		independentWorkstreams: 1,
		heterogeneousSkills: false,
		effort: "small",
		...overrides,
	};
}

describe("semantic execution router V2", () => {
	it("routes a small, low-uncertainty single-lane task directly", () => {
		const decision = routeExecution({ signals: signals() });
		assert.equal(decision.mode, "direct");
		assert.equal(decision.source, "auto");
		assert.equal(decision.status, "ready");
	});

	it("uses one specialist for domain-heavy but coupled work", () => {
		const decision = routeExecution({
			signals: signals({ specialistNeed: "required", uncertainty: "high", coupling: "high", effort: "large" }),
		});
		assert.equal(decision.mode, "specialist");
	});

	it("uses a bounded specialist probe when route confidence is low", () => {
		const result = routeExecution({
			signals: signals({ confidence: 0.35 }),
			availableModes: ["direct", "specialist"],
		});
		assert.equal(result.mode, "specialist");
		assert.match(result.reasons.join(" "), /confidence|probe/i);
		assert.equal(result.shouldReassess, true);
	});

	it("treats a draft preference as non-binding automatic policy", () => {
		const result = routeExecution({
			signals: signals({ independentWorkstreams: 3, heterogeneousSkills: true, effort: "large" }),
			preferredMode: "direct",
		});
		assert.equal(result.mode, "direct");
		assert.equal(result.source, "auto");
		assert.equal(result.locked, false);
		assert.match(result.reasons.join(" "), /draft policy/i);
	});

	it("does not manufacture a role from risk alone; assurance owns risk", () => {
		const decision = routeExecution({ signals: signals({ risk: "high", effort: "medium" }) });
		assert.equal(decision.mode, "direct");
	});

	it("uses a team only when parallelism justifies coordination", () => {
		const decision = routeExecution({
			signals: signals({
				independentWorkstreams: 3,
				heterogeneousSkills: true,
				effort: "large",
				uncertainty: "medium",
			}),
		});
		assert.equal(decision.mode, "team");
		assert.equal(decision.shouldReassess, true);

		const tooCoupled = routeExecution({
			signals: signals({
				independentWorkstreams: 3,
				heterogeneousSkills: true,
				effort: "large",
				coupling: "high",
			}),
		});
		assert.notEqual(tooCoupled.mode, "team");
	});

	it("honors a user lock across reassessment", () => {
		const locked = routeExecution({
			signals: signals({ independentWorkstreams: 4, heterogeneousSkills: true, effort: "large" }),
			userSelection: { mode: "direct", locked: true },
		});
		assert.equal(locked.mode, "direct");
		assert.equal(locked.locked, true);

		const reassessed = reassessExecution({
			signals: signals({ repeatedFailureCount: 5, independentWorkstreams: 4, effort: "large" }),
			currentDecision: locked,
		});
		assert.equal(reassessed.mode, "direct");
		assert.equal(reassessed.source, "user");
	});

	it("blocks instead of silently falling back when a locked mode is unavailable", () => {
		const decision = routeExecution({
			signals: signals(),
			availableModes: ["direct", "specialist"],
			userSelection: { mode: "team", locked: true },
		});
		assert.equal(decision.mode, "team");
		assert.equal(decision.status, "blocked");
		assert.equal(decision.fallbackFrom, undefined);
	});

	it("falls back to the nearest available mode when no lock exists", () => {
		const decision = routeExecution({
			signals: signals({ independentWorkstreams: 3, heterogeneousSkills: true, effort: "large" }),
			availableModes: ["direct", "specialist"],
		});
		assert.equal(decision.mode, "specialist");
		assert.equal(decision.source, "fallback");
		assert.equal(decision.fallbackFrom, "team");
	});

	it("falls back from a missing specialist directly instead of manufacturing a team", () => {
		const decision = routeExecution({
			signals: signals({ specialistNeed: "required" }),
			availableModes: ["direct", "team"],
		});
		assert.equal(decision.mode, "direct");
		assert.equal(decision.fallbackFrom, "specialist");
	});

	it("reports blocked when no execution mode is available", () => {
		const decision = routeExecution({ signals: signals(), availableModes: [] });
		assert.equal(decision.status, "blocked");
		assert.equal(decision.mode, "direct");
	});
});

describe("runtime execution-mode reassessment", () => {
	it("escalates repeated direct failure to a specialist", () => {
		const current = routeExecution({ signals: signals() });
		const next = reassessExecution({
			signals: signals({ repeatedFailureCount: 2, uncertainty: "medium" }),
			currentDecision: current,
		});
		assert.equal(next.mode, "specialist");
		assert.equal(next.source, "reassessment");
	});

	it("escalates a stalled specialist when multiple independent lanes emerge", () => {
		const current = routeExecution({ signals: signals({ specialistNeed: "required", effort: "large" }) });
		const next = reassessExecution({
			signals: signals({
				specialistNeed: "required",
				repeatedFailureCount: 2,
				independentWorkstreams: 2,
				remainingWorkstreams: 2,
				heterogeneousSkills: true,
				effort: "large",
			}),
			currentDecision: current,
		});
		assert.equal(next.mode, "team");
	});

	it("de-escalates a team when only one lane remains", () => {
		const current = routeExecution({
			signals: signals({ independentWorkstreams: 3, heterogeneousSkills: true, effort: "large" }),
		});
		assert.equal(current.mode, "team");
		const next = reassessExecution({
			signals: signals({ independentWorkstreams: 3, remainingWorkstreams: 1, effort: "large" }),
			currentDecision: current,
		});
		assert.equal(next.mode, "direct");
	});
});
