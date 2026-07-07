import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	taskRoutingBlock,
	orchestratorConstraintBlock,
	DEFAULT_GOAL_CONFIG,
} from "../extensions/config";

// 深修 A: 编排契约 — propose_goal_draft 接受 taskType+executionMode,
// GoalState 存入,continuationPrompt 对 orchestrated 注入编排者身份约束。
// 深修 B 含在 A (编排者身份 prompt 层,不做工具 deny)。
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §五

describe("taskRoutingBlock — orchestrated 模式编排者约束 (深修 A/B)", () => {
	it("contains orchestrator-vs-executor guidance", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		assert.ok(
			block.includes("编排") || block.includes("orchestrat"),
			`should mention orchestrator guidance, got: ${block.slice(0, 300)}`,
		);
	});

	it("states non-coding tasks should not apply coding gates", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		assert.ok(
			block.includes("非 coding") || block.includes("coding 专用"),
			`should state coding gates are coding-only, got: ${block.slice(0, 400)}`,
		);
	});
});

describe("orchestratorConstraintBlock (深修 B 纯函数)", () => {
	it("returns constraint text for orchestrated (non-coding)", () => {
		const block = orchestratorConstraintBlock("orchestrated", "research");
		assert.ok(block.includes("编排者"), `orchestrated should mention 编排者, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("spawn role"), `should mention spawn role, got: ${block.slice(0, 200)}`);
		assert.ok(!block.includes("deny") || block.includes("不硬 deny"), `should NOT hard-deny, got: ${block.slice(0, 200)}`);
	});

	it("G7 pending (default): single+non-coding injects pre-audit-required constraint", () => {
		const block = orchestratorConstraintBlock("single", "research", "单点查证任务可直接检索确认", "pending");
		assert.ok(block.includes("Single 模式约束"), `single+non-coding should inject single constraint, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("待预审"), `pending should say 待预审, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("预审"), `pending should mention pre-audit, got: ${block.slice(0, 300)}`);
		assert.ok(block.includes("不得自给理由自过"), `should ban self-approve, got: ${block.slice(0, 400)}`);
	});

	it("G7 approved: single+non-coding injects can-execute constraint", () => {
		const block = orchestratorConstraintBlock("single", "research", "单点查证任务可直接检索确认", "approved");
		assert.ok(block.includes("预审已通过"), `approved should say 预审已通过, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("可开始实质执行"), `approved should allow execution, got: ${block.slice(0, 300)}`);
	});

	it("G7 rejected: single+non-coding injects must-downgrade constraint", () => {
		const block = orchestratorConstraintBlock("single", "research", "单点查证任务可直接检索确认", "rejected");
		assert.ok(block.includes("预审被拒"), `rejected should say 预审被拒, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("降级"), `rejected should tell to downgrade, got: ${block.slice(0, 300)}`);
		assert.ok(block.includes("orchestrated"), `rejected should mention orchestrated, got: ${block.slice(0, 400)}`);
	});

	it("returns empty for coding (backward-compat, no constraint)", () => {
		assert.equal(orchestratorConstraintBlock("single", "coding"), "");
	});

	it("returns empty for undefined taskType (legacy backward-compat)", () => {
		assert.equal(orchestratorConstraintBlock(undefined, undefined), "");
		assert.equal(orchestratorConstraintBlock("single", undefined), "");
	});
});
