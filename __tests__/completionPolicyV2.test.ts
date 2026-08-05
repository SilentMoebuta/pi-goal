import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	adaptStateCriteriaForPolicy,
	normalizeJudgeVerdict,
	rejectionEscalation,
	rejectionFingerprint,
	selectReviewerPolicy,
	validateCompletionPolicy,
	type CompletionFailure,
	type EvidenceRef,
	type NormalizedJudgeVerdict,
} from "../extensions/completion-policy-v2";
import type { GoalCriterionV2 } from "../extensions/state";

function source(id: string, independenceKey = id): EvidenceRef {
	return {
		id,
		kind: "source",
		summary: `Primary source ${id}`,
		locator: `https://example.test/${id}`,
		sourceKind: "primary",
		independenceKey,
		recordedAt: 1,
		origin: "agent",
		verification: "verified",
	};
}

function verdict(overrides: Partial<NormalizedJudgeVerdict> = {}): NormalizedJudgeVerdict {
	return {
		schemaVersion: "goal_completion_policy_v2",
		outcome: "accept",
		requirements: [],
		claims: [],
		blockingFailures: [],
		advisories: [],
		...overrides,
	};
}

describe("completion policy V2 research evidence", () => {
	it("accepts one authoritative source for an ordinary material claim", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-1", text: "The API supports X", materiality: "material", risk: "ordinary", evidenceRefs: ["e1"] }],
			evidenceLedger: [source("e1")],
			judgeVerdict: verdict({
				claims: [{ id: "claim-1", support: "sufficient", evidenceRefs: ["e1"], reason: "Official API reference." }],
			}),
		});
		assert.equal(result.canComplete, true);
		assert.deepEqual(result.blockingFailures, []);
	});

	it("does not treat an unclassified observation as an authoritative research source", () => {
		const observation: EvidenceRef = {
			id: "observation", kind: "observation", summary: "Agent observed it", locator: "note:1",
			recordedAt: 1, origin: "agent", verification: "verified",
		};
		const result = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-1", text: "External fact", materiality: "material", evidenceRefs: ["observation"] }],
			evidenceLedger: [observation],
			judgeVerdict: verdict({ claims: [{ id: "claim-1", support: "sufficient", evidenceRefs: ["observation"], reason: "Observed" }] }),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.missingEvidenceKind === "source"));
	});

	it("requires two independent origins only for a high-risk material claim", () => {
		const oneSource = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-risk", text: "High-impact conclusion", materiality: "material", risk: "high", evidenceRefs: ["e1"] }],
			evidenceLedger: [source("e1")],
			judgeVerdict: verdict({
				claims: [{ id: "claim-risk", support: "sufficient", evidenceRefs: ["e1"], reason: "One source." }],
			}),
		});
		assert.equal(oneSource.canComplete, false);
		assert.ok(oneSource.blockingFailures.some((failure) => failure.code === "high_risk_claim_needs_corroboration"));

		const corroborated = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-risk", text: "High-impact conclusion", materiality: "material", risk: "high", evidenceRefs: ["e1", "e2"] }],
			evidenceLedger: [source("e1", "origin-a"), source("e2", "origin-b")],
			judgeVerdict: verdict({
				claims: [{ id: "claim-risk", support: "sufficient", evidenceRefs: ["e2", "e1"], reason: "Independent confirmation." }],
			}),
		});
		assert.equal(corroborated.canComplete, true);
	});

	it("does not count two mirrors of the same origin as corroboration", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-risk", text: "High-impact conclusion", materiality: "material", risk: "high", evidenceRefs: ["e1", "e2"] }],
			evidenceLedger: [source("e1", "same-origin"), source("e2", "same-origin")],
			judgeVerdict: verdict({
				claims: [{ id: "claim-risk", support: "sufficient", evidenceRefs: ["e1", "e2"], reason: "Two mirrors." }],
			}),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.code === "high_risk_claim_needs_corroboration"));
	});

	it("requires explicit independence keys for high-risk corroboration", () => {
		const first = { ...source("e1"), independenceKey: undefined };
		const second = { ...source("e2"), independenceKey: undefined };
		const result = validateCompletionPolicy({
			criteria: [],
			claims: [{ id: "claim-risk", text: "High-impact conclusion", materiality: "material", risk: "high", evidenceRefs: ["e1", "e2"] }],
			evidenceLedger: [first, second],
			judgeVerdict: verdict({
				claims: [{ id: "claim-risk", support: "sufficient", evidenceRefs: ["e1", "e2"], reason: "Origins were not established." }],
			}),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.code === "high_risk_claim_needs_corroboration"));
	});

	it("keeps unmet advisory criteria and supporting claims non-blocking", () => {
		const result = validateCompletionPolicy({
			criteria: [{ id: "nice-to-have", description: "Optional broader context", level: "advisory", evidenceRefs: [] }],
			claims: [{ id: "supporting", text: "Background detail", materiality: "supporting", evidenceRefs: [] }],
			evidenceLedger: [],
			judgeVerdict: verdict({
				requirements: [{ id: "nice-to-have", status: "unsatisfied", evidenceRefs: [], reason: "Not needed for the core answer." }],
				claims: [{ id: "supporting", support: "insufficient", evidenceRefs: [], reason: "Background only." }],
				blockingFailures: [{ code: "blocking_requirement_unsatisfied", subjectId: "nice-to-have", reason: "Judge over-classified it." }],
			}),
		});
		assert.equal(result.canComplete, true);
		assert.equal(result.blockingFailures.length, 0);
		assert.ok(result.advisories.some((item) => item.includes("nice-to-have")));
		assert.ok(result.advisories.some((item) => item.includes("supporting")));
	});

	it("rejects unknown, malformed, or judge-invented evidence references", () => {
		const result = validateCompletionPolicy({
			criteria: [{ id: "must", description: "Required result", level: "blocking", evidenceRefs: ["missing"] }],
			evidenceLedger: [],
			judgeVerdict: verdict({
				requirements: [{ id: "must", status: "satisfied", evidenceRefs: ["invented"], reason: "Claimed complete." }],
			}),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.code === "invalid_evidence_ref"));
	});

	it("rejects and removes judge coverage for unknown criteria and claims", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			claims: [],
			evidenceLedger: [],
			judgeVerdict: verdict({
				outcome: "accept",
				requirements: [{ id: "invented-criterion", status: "satisfied", evidenceRefs: [], reason: "Invented" }],
				claims: [{ id: "invented-claim", support: "sufficient", evidenceRefs: [], reason: "Invented" }],
			}),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => /unknown criteria.*invented-criterion/i.test(failure.reason)));
		assert.ok(result.blockingFailures.some((failure) => /unknown claims.*invented-claim/i.test(failure.reason)));
		assert.deepEqual(result.judge.requirements, []);
		assert.deepEqual(result.judge.claims, []);
	});

	it("supports every canonical evidence kind and falls back when locator is empty", () => {
		const kinds = ["source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text"] as const;
		const evidenceLedger: EvidenceRef[] = kinds.map((kind, index) => ({
			id: `e${index}`,
			kind,
			summary: `${kind} evidence`,
			locator: index === 0 ? "" : `${kind}:${index}`,
			recordedAt: 1,
			origin: "agent",
			verification: "verified",
		}));
		const criteria = kinds.map((_, index) => ({
			id: `c${index}`,
			description: `Kind ${index} is accepted`,
			evidenceRefs: [`e${index}`],
		}));
		const result = validateCompletionPolicy({
			criteria,
			evidenceLedger,
			judgeVerdict: verdict({
				requirements: criteria.map((criterion, index) => ({
					id: criterion.id,
					status: "satisfied",
					evidenceRefs: [`e${index}`],
					reason: "Canonical evidence.",
				})),
			}),
		});
		assert.equal(result.canComplete, true);
	});

	it("requires blocking criteria to be assessed against attached evidence", () => {
		const result = validateCompletionPolicy({
			criteria: [{ id: "must", description: "Required result", evidenceRefs: ["e1"] }],
			evidenceLedger: [source("e1")],
			judgeVerdict: verdict({
				requirements: [{ id: "must", status: "satisfied", evidenceRefs: [], reason: "No evidence cited." }],
			}),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.code === "blocking_requirement_unsatisfied"));
	});
});

describe("judge normalization and rejection loop control", () => {
	it("normalizes ordering and duplicate evidence/advisory strings", () => {
		const normalized = normalizeJudgeVerdict({
			schemaVersion: "goal_completion_policy_v2",
			outcome: "accept",
			requirements: [{ id: "b", status: "satisfied", evidenceRefs: ["z", "a", "a"], reason: "ok" }],
			claims: [],
			blockingFailures: [],
			advisories: ["second", "first", "second"],
		});
		assert.equal(normalized.ok, true);
		assert.deepEqual(normalized.verdict.requirements[0].evidenceRefs, ["a", "z"]);
		assert.deepEqual(normalized.verdict.advisories, ["first", "second"]);
	});

	it("blank or non-string advisories are dropped and never invalidate the verdict", () => {
		// UX finding: the judge emitted empty-string entries; the strict path
		// turned them into judge_contract_invalid and the goal REVISE-looped.
		const normalized = normalizeJudgeVerdict({
			schemaVersion: "goal_completion_policy_v2",
			outcome: "accept",
			requirements: [{ id: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "ok" }],
			claims: [],
			blockingFailures: [],
			advisories: ["", "  ", 42, "real advisory", null],
		});
		assert.equal(normalized.ok, true);
		assert.deepEqual(normalized.verdict.advisories, ["real advisory"]);
		assert.equal(normalized.errors.length, 0);

		// End-to-end: a verdict with blank advisories can still complete.
		const result = validateCompletionPolicy({
			criteria: [{ id: "c1", description: "Deliverable exists", level: "blocking", evidenceRefs: ["e1"] }],
			claims: [],
			evidenceLedger: [source("e1")],
			judgeVerdict: {
				schemaVersion: "goal_completion_policy_v2",
				outcome: "accept",
				requirements: [{ id: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "ok" }],
				claims: [],
				blockingFailures: [],
				advisories: [""],
			},
		});
		assert.equal(result.canComplete, true);
		assert.deepEqual(result.blockingFailures, []);
	});

	it("fails closed on malformed judge output", () => {
		const normalized = normalizeJudgeVerdict({ outcome: "done", requirements: {}, claims: [] });
		assert.equal(normalized.ok, false);
		assert.equal(normalized.verdict.outcome, "continue");
		assert.ok(normalized.errors.length >= 2);
	});

	it("requires the Goal V2 judge schema version", () => {
		const result = normalizeJudgeVerdict({
			outcome: "accept",
			requirements: [],
			claims: [],
			blockingFailures: [],
			advisories: [],
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.join(" "), /schemaVersion/i);
	});

	it("fingerprints structural failures, not wording or order", () => {
		const a: CompletionFailure[] = [
			{ code: "material_claim_unsupported", subjectId: "c2", reason: "first wording" },
			{ code: "invalid_evidence_ref", subjectId: "c1", missingEvidenceKind: "source", reason: "x" },
		];
		const b: CompletionFailure[] = [
			{ code: "invalid_evidence_ref", subjectId: "c1", missingEvidenceKind: "source", reason: "different wording" },
			{ code: "material_claim_unsupported", subjectId: "c2", reason: "translated wording" },
		];
		assert.match(rejectionFingerprint(a), /^[a-f0-9]{64}$/);
		assert.equal(rejectionFingerprint(a), rejectionFingerprint(b));
	});

	it("escalates equivalent consecutive rejection 1 feedback, 2 replan, 3 pause", () => {
		const fingerprint = "same";
		assert.deepEqual(rejectionEscalation(fingerprint, []), { fingerprint, consecutiveCount: 1, action: "feedback" });
		assert.equal(rejectionEscalation(fingerprint, [fingerprint]).action, "replan");
		assert.equal(rejectionEscalation(fingerprint, [fingerprint, fingerprint]).action, "pause");
		assert.equal(rejectionEscalation(fingerprint, [fingerprint, "different"]).consecutiveCount, 1);
	});
});

describe("risk-based reviewer policy", () => {
	it("does not require a reviewer merely because taskType is research", () => {
		const policy = selectReviewerPolicy({
			taskType: "research",
			risk: "low",
			deterministicVerificationAvailable: true,
		});
		assert.equal(policy.mode, "none");
	});

	it("makes medium risk advisory and high-risk evidence required", () => {
		assert.equal(selectReviewerPolicy({ risk: "medium" }).mode, "advisory");
		const high = selectReviewerPolicy({ risk: "low", hasHighRiskClaims: true });
		assert.equal(high.mode, "required");
		assert.equal(high.independent, true);
		assert.equal(high.depth, "deep");
	});

	it("requires review for conflicts and irreversible external actions", () => {
		assert.equal(selectReviewerPolicy({ risk: "low", hasEvidenceConflict: true }).mode, "required");
		assert.equal(selectReviewerPolicy({ risk: "low", irreversibleExternalAction: true }).mode, "required");
	});
});

describe("deterministic completion prerequisites", () => {
	it("fails closed while a required independent review is pending", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			evidenceLedger: [],
			assurance: { reviewRequirement: "required", reviewStatus: "pending" },
			judgeVerdict: verdict(),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.subjectId === "$goal"));
	});

	it("treats a failed configured verifier as blocking evidence", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			evidenceLedger: [],
			deterministicVerification: { ok: false, exitCode: 1 },
			judgeVerdict: verdict(),
		});
		assert.equal(result.canComplete, false);
		assert.ok(result.blockingFailures.some((failure) => failure.missingEvidenceKind === "command"));
	});

	it("fingerprints a non-accepting verdict even when it omitted findings", () => {
		const result = validateCompletionPolicy({
			criteria: [],
			evidenceLedger: [],
			judgeVerdict: verdict({ outcome: "continue" }),
		});
		assert.equal(result.canComplete, false);
		assert.equal(result.blockingFailures.length, 1);
		assert.match(rejectionFingerprint(result.blockingFailures), /^[a-f0-9]{64}$/);
	});
});

describe("snapshot V2 compatibility adapter", () => {
	it("flattens embedded state evidence without redefining state-owned types", () => {
		const stateCriterion: GoalCriterionV2 = {
			id: "c1",
			description: "Tests pass",
			evidencePolicy: { mode: "adaptive", requiredKinds: ["tool_result"], corroboration: "none" },
			evidence: [{
				id: "ev1",
				kind: "tool_result",
				summary: "npm test passed",
				origin: "tool",
				recordedAt: 10,
				verification: "verified",
			}],
		};
		const adapted = adaptStateCriteriaForPolicy([stateCriterion]);
		assert.deepEqual(adapted.criteria[0].evidenceRefs, ["ev1"]);
		assert.equal(adapted.evidenceLedger[0].kind, "tool_result");
		assert.equal(adapted.evidenceLedger[0].locator, "state-evidence:ev1");
	});
});
