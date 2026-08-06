import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUpdateGoalAction } from "../extensions/update-goal-action-v2";
import { computeBlueprintEvidenceDiagnostics } from "../extensions/completion-policy-v2";
import type { EvidenceRef } from "../extensions/state";

describe("record_deviation action", () => {
	it("normalizes a valid record_deviation with all fields", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_deviation",
			subjectId: "dag.nodes.research",
			description: "改为串行实现",
			reason: "影响面分析显示无并行空间",
			impact: "无",
		}, { now: 1000 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.action.action, "record_deviation");
		if (result.action.action !== "record_deviation") return;
		assert.equal(result.action.subjectId, "dag.nodes.research");
		assert.equal(result.action.description, "改为串行实现");
		assert.equal(result.action.impact, "无");
	});

	it("accepts a minimal record_deviation (description + reason only)", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_deviation",
			description: "未使用声明的 reviewer 角色",
			reason: "目录中没有匹配角色",
		}, { now: 1000 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		if (result.action.action !== "record_deviation") return;
		assert.equal(result.action.subjectId, undefined);
		assert.equal(result.action.impact, undefined);
	});

	it("rejects record_deviation without description or reason", () => {
		const missingDescription = normalizeUpdateGoalAction({ action: "record_deviation", reason: "r" }, { now: 1 });
		assert.equal(missingDescription.ok, false);
		const missingReason = normalizeUpdateGoalAction({ action: "record_deviation", description: "d" }, { now: 1 });
		assert.equal(missingReason.ok, false);
	});

	it("rejects oversized deviation fields", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_deviation",
			description: "x".repeat(501),
			reason: "r",
		}, { now: 1 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /description/);
	});

	it("does not infer record_deviation from flat legacy fields", () => {
		const result = normalizeUpdateGoalAction({ description: "d", reason: "r" }, { now: 1 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /No update_goal action/);
	});
});

describe("blueprint evidence diagnostics", () => {
	const ledger: EvidenceRef[] = [
		{ id: "e1", kind: "artifact", summary: "测试输出", locator: "out/test.txt", recordedAt: 1, origin: "tool", verification: "verified" },
		{ id: "e2", kind: "command", summary: "npm test", recordedAt: 1, origin: "tool", verification: "verified" },
		{ id: "e3", kind: "artifact", summary: "未验证产物", locator: "out/x.txt", recordedAt: 1, origin: "agent", verification: "unverified" },
	];

	it("reports no advisories when expectations are satisfied", () => {
		const result = computeBlueprintEvidenceDiagnostics({
			criteria: [{ id: "c1", evidenceRefs: ["e1", "e2"] }],
			claims: [],
			evidenceLedger: ledger,
			evidenceSpecs: [{ id: "c1", kinds: ["artifact", "command"], minCount: 1, verification: "verified" }],
			nodeSpecs: [{ id: "research", evidenceKind: "artifact", attachTo: "c1" }],
		});
		assert.deepEqual(result, []);
	});

	it("reports blueprint_evidence_missing when kinds or verification are unsatisfied", () => {
		const result = computeBlueprintEvidenceDiagnostics({
			criteria: [{ id: "c1", evidenceRefs: ["e3"] }],
			claims: [],
			evidenceLedger: ledger,
			evidenceSpecs: [{ id: "c1", kinds: ["command"], minCount: 1, verification: "verified" }],
			nodeSpecs: [],
		});
		assert.deepEqual(result, ["blueprint_evidence_missing: c1 expects command x1 verified (found 0, 0 verified)"]);
	});

	it("reports node evidence missing when a node produced no matching kind", () => {
		const result = computeBlueprintEvidenceDiagnostics({
			criteria: [{ id: "c1", evidenceRefs: ["e1"] }],
			claims: [],
			evidenceLedger: ledger,
			evidenceSpecs: [],
			nodeSpecs: [{ id: "implement", evidenceKind: "command", attachTo: "c1" }],
		});
		assert.deepEqual(result, ["blueprint_node_evidence_missing: node implement (command on c1)"]);
	});

	it("counts by kind with default minCount 1 and any kind", () => {
		const result = computeBlueprintEvidenceDiagnostics({
			criteria: [{ id: "c1", evidenceRefs: ["e3"] }],
			claims: [],
			evidenceLedger: ledger,
			evidenceSpecs: [{ id: "c1" }],
			nodeSpecs: [],
		});
		assert.deepEqual(result, []);
	});

	it("supports claims as attach targets and dedupes advisories", () => {
		const result = computeBlueprintEvidenceDiagnostics({
			criteria: [],
			claims: [{ id: "cl1", evidenceRefs: [] }],
			evidenceLedger: ledger,
			evidenceSpecs: [{ id: "cl1", kinds: ["source"] }, { id: "cl1", kinds: ["source"] }],
			nodeSpecs: [],
		});
		assert.deepEqual(result, ["blueprint_evidence_missing: cl1 expects source x1 (found 0)"]);
	});
});
