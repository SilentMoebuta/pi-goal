import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	injectSuperpowersCoding,
	taskGovernanceBlock,
	DEFAULT_GOAL_CONFIG,
	type GoalConfig,
} from "../extensions/config";

// 深修 C: governance 分流 — 非 coding 任务不套 coding 门,各有自己的 governance 块。
// injectSuperpowersCoding 接收 goalTaskType 参数(per-goal,来自 GoalState.taskType),
// 优先级: goalTaskType > config.forceTaskType > undefined(coding 默认,backward-compat)。
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §四

describe("injectSuperpowersCoding — goalTaskType 分流 (深修 C)", () => {
	it("injects coding gate for undefined goalTaskType (backward-compat)", () => {
		assert.equal(injectSuperpowersCoding(DEFAULT_GOAL_CONFIG, undefined), true);
	});

	it("injects coding gate for explicit 'coding' goalTaskType", () => {
		assert.equal(injectSuperpowersCoding(DEFAULT_GOAL_CONFIG, "coding"), true);
	});

	for (const t of ["research", "document", "business", "pm", "review"] as const) {
		it(`suppresses coding gate for ${t} goalTaskType (no competing instructions)`, () => {
			assert.equal(injectSuperpowersCoding(DEFAULT_GOAL_CONFIG, t), false, `goalTaskType=${t} should suppress coding gate`);
		});
	}

	it("goalTaskType overrides config.forceTaskType (per-goal wins)", () => {
		// config says coding, but goal says research → research wins (suppress)
		const cfg: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: "coding" };
		assert.equal(injectSuperpowersCoding(cfg, "research"), false);
		// config says research, goal undefined → config wins (suppress)
		const cfg2: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: "research" };
		assert.equal(injectSuperpowersCoding(cfg2, undefined), false);
	});

	it("returns false when superpowersIntegration off (regardless of goalTaskType)", () => {
		const cfg: GoalConfig = { superpowersIntegration: false };
		assert.equal(injectSuperpowersCoding(cfg, "coding"), false);
		assert.equal(injectSuperpowersCoding(cfg, "research"), false);
	});
});

describe("taskGovernanceBlock — per-task-type governance (深修 C)", () => {
	it("coding → superpowers 阶段门 (existing behavior preserved)", () => {
		const block = taskGovernanceBlock("coding");
		assert.ok(block.length > 0, "coding governance should be non-empty");
		assert.ok(block.includes("superpowers") || block.includes("TDD") || block.includes("阶段"), `coding governance should mention superpowers/TDD, got: ${block.slice(0, 200)}`);
	});

	it("research uses claim risk and evidence independence instead of URL counts", () => {
		const block = taskGovernanceBlock("research");
		assert.ok(block.includes("independenceKey"), `research governance should explain evidence independence, got: ${block.slice(0, 300)}`);
		assert.ok(block.includes("diagnostics"), `research governance should demote URL/source counts, got: ${block.slice(0, 300)}`);
	});

	it("pm → 盘点→痛点→机会→优先级→reviewer 验论证", () => {
		const block = taskGovernanceBlock("pm");
		assert.ok(block.includes("机会") || block.includes("优先级"), `pm governance should mention 机会/优先级, got: ${block.slice(0, 200)}`);
		assert.ok(block.includes("reviewer") || block.includes("论证"), `pm governance should mention reviewer/论证, got: ${block.slice(0, 200)}`);
	});

	it("document and business use their own non-coding workflows", () => {
		const document = taskGovernanceBlock("document");
		assert.match(document, /audience|structure|artifact/i);
		assert.doesNotMatch(document, /TDD/);
		const business = taskGovernanceBlock("business");
		assert.match(business, /decision|approval|audit/i);
		assert.doesNotMatch(business, /TDD/);
	});

	it("review → 审计清单 + reviewer 复核", () => {
		const block = taskGovernanceBlock("review");
		assert.ok(block.includes("审计") || block.includes("复核"), `review governance should mention 审计/复核, got: ${block.slice(0, 200)}`);
	});

	it("undefined → coding governance (backward-compat)", () => {
		const block = taskGovernanceBlock(undefined);
		assert.ok(block.length > 0);
		// undefined falls back to coding governance
		assert.ok(block.includes("superpowers") || block.includes("TDD") || block.includes("阶段"), `undefined should fall back to coding, got: ${block.slice(0, 200)}`);
	});

	it("research/pm/review governance 含 reviewer roleDef 聚焦规范 (教训14: 避 doom-loop)", () => {
		for (const t of ["research", "pm", "review"] as const) {
			const block = taskGovernanceBlock(t);
			assert.ok(block.includes("doom-loop"), `${t} governance should warn about doom-loop (教训14), got: ${block.slice(0, 300)}`);
			assert.ok(block.includes("report_role_result"), `${t} governance should mention report_role_result as the focused report tool, got: ${block.slice(0, 300)}`);
			assert.ok(/maxTurns|禁探索/.test(block), `${t} governance should mention maxTurns or 禁探索性调用, got: ${block.slice(0, 300)}`);
		}
		// coding governance should NOT carry the reviewer-roleDef hint (no reviewer gate for coding)
		assert.ok(!taskGovernanceBlock("coding").includes("doom-loop"), "coding governance should not carry reviewer-roleDef hint (no reviewer gate)");
	});

	it("separates Contract V3 typed reviewer guidance from the legacy transcript protocol", () => {
		const atomic = taskGovernanceBlock("research", "atomic-v3");
		assert.match(atomic, /goal-reviewer/);
		assert.match(atomic, /resultRef/);
		assert.match(atomic, /submit_completion_bundle/);
		assert.doesNotMatch(atomic, /✅ Ready|❌ Not ready|sessionFile|session 文件名/);

		const legacy = taskGovernanceBlock("research", "legacy-v2");
		assert.match(legacy, /✅ Ready/);
		assert.doesNotMatch(legacy, /submit_completion_bundle/);

		const none = taskGovernanceBlock("research", "none");
		assert.doesNotMatch(none, /report_role_result|goal-reviewer|doom-loop/);
	});
});
