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

// 第5条: research 阶段无 HARD-GATE (CLM run 复盘).
// 根因: RESEARCH_GOVERNANCE 是 prompt 文字 (计划→采集→交叉验证→综合→reviewer), 无阶段
// gate 强制——main agent 走 collect→synthesize 跳过交叉验证, 无东西拦 (handoff §八 根因1).
// 诚实标注: per-claim 交叉验证实质不可机器验 (根因5残余), 只能靠 reviewer (第2条已强化) +
// prompt. 机器能做的形式 gate: research goal criteria >=3 (对应 plan/collect/cross-validate
// 阶段产物), evidence 全覆盖 (现有 evidence gate). 形式验非实质验.
describe("validateGoalProposal — 第5条 research 阶段 HARD-GATE (形式)", () => {
	it("rejects research goal with < 3 criteria (need plan/collect/cross-validate stage artifacts)", () => {
		const r = validateGoalProposal({ taskType: "research", executionMode: "single", criteria: ["a", "b"] });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /criteria|>= ?3|阶段/i);
	});
	it("accepts research goal with >= 3 criteria", () => {
		const r = validateGoalProposal({ taskType: "research", executionMode: "single", criteria: ["a", "b", "c"] });
		assert.equal(r.ok, true);
	});
	it("does not enforce criteria count for coding goals (backward-compat)", () => {
		const r = validateGoalProposal({ taskType: "coding", criteria: ["a"] });
		assert.equal(r.ok, true);
	});
});
