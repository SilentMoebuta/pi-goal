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
	it("returns constraint text for orchestrated", () => {
		const block = orchestratorConstraintBlock("orchestrated");
		assert.ok(block.includes("编排者"), `orchestrated should mention 编排者, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("spawn role"), `should mention spawn role, got: ${block.slice(0, 200)}`);
		assert.ok(!block.includes("deny") || block.includes("不硬 deny"), `should NOT hard-deny, got: ${block.slice(0, 200)}`);
	});

	it("returns empty for single (backward-compat, no constraint)", () => {
		assert.equal(orchestratorConstraintBlock("single"), "");
	});

	it("returns empty for undefined (backward-compat)", () => {
		assert.equal(orchestratorConstraintBlock(undefined), "");
	});
});
