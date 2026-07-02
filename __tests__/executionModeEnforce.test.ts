import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateGoalProposal } from "../extensions/config";

// 第1条: executionMode "判简单"偏见修复 (CLM run 复盘).
// 根因: propose_goal_draft 的 executionMode 缺省=undefined=single, 非 coding 任务
// (research/pm/review) 默认走 single, orchestratorConstraintBlock 不触发, main agent
// 直执成为默认路径——"把复杂任务判成简单"的结构性偏好 (handoff §八 根因1+3).
// 解法: 非 coding taskType 时 executionMode 不可缺省, 必须显式选 single|orchestrated.
// backward-compat: coding/undefined taskType 行为不变 (缺省仍合法).

describe("validateGoalProposal — 第1条 executionMode 强制 (非 coding)", () => {
	it("rejects research taskType without explicit executionMode", () => {
		const r = validateGoalProposal({ taskType: "research" });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /executionMode/i);
	});

	it("rejects pm taskType without explicit executionMode", () => {
		const r = validateGoalProposal({ taskType: "pm" });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /executionMode/i);
	});

	it("rejects review taskType without explicit executionMode", () => {
		const r = validateGoalProposal({ taskType: "review" });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /executionMode/i);
	});

	it("accepts research taskType with explicit single", () => {
		const r = validateGoalProposal({ taskType: "research", executionMode: "single" });
		assert.equal(r.ok, true);
	});

	it("accepts research taskType with explicit orchestrated", () => {
		const r = validateGoalProposal({ taskType: "research", executionMode: "orchestrated" });
		assert.equal(r.ok, true);
	});

	it("accepts coding taskType without executionMode (backward-compat)", () => {
		const r = validateGoalProposal({ taskType: "coding" });
		assert.equal(r.ok, true);
	});

	it("accepts undefined taskType without executionMode (legacy backward-compat)", () => {
		const r = validateGoalProposal({});
		assert.equal(r.ok, true);
	});
});
