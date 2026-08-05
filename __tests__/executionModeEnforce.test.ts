import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateGoalProposal } from "../extensions/config";

describe("validateGoalProposal V2", () => {
	it("allows automatic routing for every task kind", () => {
		for (const taskType of ["general", "coding", "research", "pm", "review"]) {
			assert.equal(validateGoalProposal({ taskType, criteria: ["Deliver the requested outcome"] }).ok, true);
		}
	});

	it("keeps legacy executionMode inputs valid", () => {
		assert.equal(validateGoalProposal({ taskType: "research", executionMode: "single", criteria: ["Answer the question"] }).ok, true);
		assert.equal(validateGoalProposal({ taskType: "research", executionMode: "orchestrated", criteria: ["Answer the question"] }).ok, true);
	});

	it("rejects mixed legacy and V2 execution controls", () => {
		const result = validateGoalProposal({ executionMode: "single", executionPreference: "auto", criteria: ["Outcome"] });
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /not both|execution/i);
	});

	it("accepts one real research outcome criterion", () => {
		assert.equal(validateGoalProposal({ taskType: "research", criteria: ["Produce a supported answer"] }).ok, true);
	});

	it("rejects no outcome criteria and blank criteria", () => {
		assert.equal(validateGoalProposal({ criteria: [] }).ok, false);
		assert.equal(validateGoalProposal({ criteria: [" "] }).ok, false);
	});

	it("requires at least one blocking outcome criterion", () => {
		const result = validateGoalProposal({
			criteria: [{ description: "Helpful context", level: "advisory" }],
		});
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /blocking outcome/i);
	});

	it("rejects blank objectives and provided empty or blank constraints", () => {
		for (const objective of ["", " \t\n "]) {
			const result = validateGoalProposal({ objective, criteria: ["Outcome"] });
			assert.equal(result.ok, false);
			assert.match(result.reason ?? "", /objective.*(empty|blank)/i);
		}
		for (const constraints of [[], [""], [" \t "]]) {
			const result = validateGoalProposal({ objective: "Outcome", criteria: ["Outcome"], constraints });
			assert.equal(result.ok, false);
			assert.match(result.reason ?? "", /constraints?.*(empty|blank)/i);
		}
	});

	it("requires unique research claim ids after whitespace normalization", () => {
		const result = validateGoalProposal({
			objective: "Research outcome",
			criteria: ["Supported answer"],
			researchClaims: [
				{ id: "claim-1" },
				{ id: " claim-1 " },
			],
		});
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /duplicate claim id.*claim-1/i);
	});

	it("rejects blank research claim ids and text", () => {
		assert.equal(validateGoalProposal({ criteria: ["Outcome"], researchClaims: [{ id: " " }] }).ok, false);
		assert.equal(validateGoalProposal({ criteria: ["Outcome"], researchClaims: [{ id: "claim", text: " " }] }).ok, false);
	});

	it("rejects every draft evidence ref as unknown because the draft ledger is empty", () => {
		const result = validateGoalProposal({
			objective: "Research outcome",
			criteria: ["Supported answer"],
			researchClaims: [{ id: "claim-1", evidenceRefs: ["source-before-start"] }],
		});
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /unknown draft evidence.*source-before-start/i);
		assert.match(result.reason ?? "", /ledger is empty/i);
	});
});
