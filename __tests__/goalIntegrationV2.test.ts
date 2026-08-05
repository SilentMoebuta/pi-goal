import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildBoundedEvidencePacket,
	completionDecisionToEvaluation,
} from "../extensions/goal-integration-v2";
import { validateCompletionPolicy } from "../extensions/completion-policy-v2";
import { createGoalStateV2, type EvidenceRef, type GoalStateV2 } from "../extensions/state";

function makeGoal(): GoalStateV2 {
	return createGoalStateV2({
		id: "goal-1",
		objective: "Produce a verified research answer",
		criteria: [
			{ id: "blocking", description: "Core answer is supported" },
			{ id: "advisory", description: "Optional historical context", level: "advisory" },
		],
		constraints: ["Do not publish", "Use public evidence"],
		taskKind: "research",
		execution: {
			preference: "auto",
			selected: "specialist",
			source: "auto",
			confidence: 0.8,
			reasons: ["One research lane"],
			reassessOn: ["conflict"],
		},
		assurance: {
			reviewRequirement: "advisory",
			reviewStatus: "pending",
			independent: true,
			depth: "standard",
			source: "auto",
			reasons: ["Medium risk"],
			decidedAt: 1,
		},
		now: 1,
	});
}

function evidence(id: string, locator = `${id}:locator`): EvidenceRef {
	return {
		id,
		kind: "source",
		summary: `${id} evidence summary`,
		locator,
		sourceKind: "primary",
		independenceKey: id,
		excerpt: `${id} evidence excerpt`,
		recordedAt: 2,
		origin: "agent",
		verification: "verified",
	};
}

describe("bounded completion evidence packet", () => {
	it("prioritizes blocking/material evidence and reports every truncation", () => {
		const goal = makeGoal();
		goal.evidenceLedger = [evidence("ea"), evidence("es"), evidence("eb", ""), evidence("em")];
		goal.criteria[0].evidenceRefs = ["eb"];
		goal.criteria[1].evidenceRefs = ["ea"];
		goal.claims = [
			{ id: "supporting", text: "Background", materiality: "supporting", evidenceRefs: ["es"] },
			{ id: "material", text: "Core claim", materiality: "material", evidenceRefs: ["em"] },
		];
		goal.completion.rejectionHistory = ["old-1", "old-2", "old-3"];

		const packet = buildBoundedEvidencePacket({
			goal,
			latestResponse: "abcdefgh",
			deterministicVerification: {
				command: "npm test",
				result: { ok: true, exitCode: 0, stdout: "passed", stderr: "warning" },
			},
			limits: {
				maxCriteria: 1,
				maxClaims: 1,
				maxEvidence: 2,
				maxConstraints: 1,
				maxRejectionHistory: 2,
				maxLatestResponseChars: 4,
				maxDeterministicOutputChars: 3,
			},
		});

		assert.deepEqual(packet.criteria.map((item) => item.id), ["blocking"]);
		assert.deepEqual(packet.claims.map((item) => item.id), ["material"]);
		assert.deepEqual(packet.evidenceLedger.map((item) => item.id), ["eb", "em"]);
		assert.equal(packet.evidenceLedger[0].locator, "evidence:eb");
		assert.equal(packet.latestResponse, "abcd");
		assert.equal(packet.deterministicVerification?.stdout, "pas");
		assert.equal(packet.deterministicVerification?.stderr, "war");
		assert.deepEqual(packet.rejectionHistory, ["old-2", "old-3"]);
		assert.deepEqual(packet.truncation, {
			criteriaOmitted: 1,
			claimsOmitted: 1,
			evidenceOmitted: 2,
			constraintsOmitted: 1,
			rejectionHistoryOmitted: 1,
			evidenceRefsOmitted: 0,
			textFieldsTruncated: 3,
		});
	});

	it("uses an explicit rejection history override", () => {
		const packet = buildBoundedEvidencePacket({
			goal: makeGoal(),
			latestResponse: "done",
			rejectionHistory: ["override"],
		});
		assert.deepEqual(packet.rejectionHistory, ["override"]);
	});
});

describe("completion decision state integration", () => {
	it("converts a rejected policy decision into a fingerprinted state evaluation", () => {
		const ev = evidence("e1");
		const decision = validateCompletionPolicy({
			criteria: [{ id: "c1", description: "Core", level: "blocking", evidenceRefs: ["e1"] }],
			claims: [{ id: "claim", text: "Risky", materiality: "material", risk: "high", evidenceRefs: ["e1"] }],
			evidenceLedger: [ev],
			judgeVerdict: {
				outcome: "continue",
				requirements: [{ id: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Covered" }],
				claims: [{ id: "claim", support: "sufficient", evidenceRefs: ["e1"], reason: "Only one origin" }],
				blockingFailures: [],
				advisories: ["Find another origin"],
			},
		});
		const evaluation = completionDecisionToEvaluation(decision, {
			evaluatedAt: 10,
			evaluator: { kind: "judge", model: "provider/model" },
		});
		assert.equal(evaluation.decision, "revise");
		assert.match(evaluation.fingerprint ?? "", /^[a-f0-9]{64}$/);
		assert.equal(evaluation.criterionCoverage[0].criterionId, "c1");
		assert.equal(evaluation.claimCoverage[0].status, "sufficient");
		assert.equal(evaluation.findings[0].code, "high_risk_claim_needs_corroboration");
		assert.equal(evaluation.evaluator.model, "provider/model");
	});

	it("leaves accepted evaluations without a rejection fingerprint", () => {
		const ev = evidence("e1");
		const decision = validateCompletionPolicy({
			criteria: [{ id: "c1", description: "Core", evidenceRefs: ["e1"] }],
			evidenceLedger: [ev],
			judgeVerdict: {
				schemaVersion: "goal_completion_policy_v2",
				outcome: "accept",
				requirements: [{ id: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Covered" }],
				claims: [], blockingFailures: [], advisories: [],
			},
		});
		const evaluation = completionDecisionToEvaluation(decision, {
			evaluatedAt: 10,
			evaluator: { kind: "deterministic" },
		});
		assert.equal(evaluation.decision, "accept");
		assert.equal(evaluation.fingerprint, null);
	});
});
