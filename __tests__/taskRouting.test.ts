import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadGoalConfig,
	taskRoutingBlock,
	injectSuperpowersCoding,
	DEFAULT_GOAL_CONFIG,
	type GoalConfig,
} from "../extensions/config";

// taskRoutingBlock is a pure function (prompt string builder, no pi types).
// Tests verify the routing清单 content: task-type→workflow mapping, tiebreak
// rule, on-miss dynamic-generation instruction, superpowers-is-coding-only note,
// and forceTaskType override. Per design task_workflow_routing_design.md.

describe("injectSuperpowersCoding (rollback cleanliness)", () => {
	it("injects superpowers when forceTaskType unset (LLM auto-judges, default)", () => {
		assert.equal(injectSuperpowersCoding(DEFAULT_GOAL_CONFIG), true);
		const cfg: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: undefined };
		assert.equal(injectSuperpowersCoding(cfg), true);
	});

	it("injects superpowers when forceTaskType explicitly 'coding'", () => {
		const cfg: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: "coding" };
		assert.equal(injectSuperpowersCoding(cfg), true);
	});

	it("suppresses superpowers when forceTaskType is non-coding (research/pm/review) — clean rollback, no competing instructions", () => {
		for (const t of ["research", "pm", "review"]) {
			const cfg: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: t };
			assert.equal(injectSuperpowersCoding(cfg), false, `forceTaskType=${t} should suppress superpowers`);
		}
	});

	it("returns false when superpowersIntegration off (regardless of forceTaskType)", () => {
		const cfg: GoalConfig = { superpowersIntegration: false, forceTaskType: undefined };
		assert.equal(injectSuperpowersCoding(cfg), false);
	});
});

describe("taskRoutingBlock", () => {
	it("contains routing entries for all 4 task types (coding/research/pm/review)", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		assert.ok(block.includes("coding"), "missing coding row");
		assert.ok(block.includes("research"), "missing research row");
		assert.ok(block.includes("pm") || block.includes("PM"), "missing PM row");
		assert.ok(block.includes("review"), "missing review row");
	});

	it("contains the multi-match tiebreak rule (orchestrator > executor roles)", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		// tiebreak: 编排型 (PM/reviewer) > 执行型 (researcher/coder)
		assert.ok(
			block.includes("编排") && block.includes("执行"),
			"tiebreak rule missing orchestrator/executor distinction",
		);
		assert.ok(
			block.includes("PM") || block.includes("pm"),
			"tiebreak should name PM as orchestrator",
		);
		assert.ok(
			block.includes("researcher") || block.includes("coder"),
			"tiebreak should name researcher/coder as executor",
		);
	});

	it("instructs on-miss dynamic workflow generation (DAGSpec → dag_execute)", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		assert.ok(block.includes("dag_execute"), "missing dag_execute instruction");
		assert.ok(
			block.toLowerCase().includes("dag") || block.includes("DAGSpec"),
			"missing DAGSpec reference",
		);
		assert.ok(
			block.includes("无匹配") || block.toLowerCase().includes("no match") || block.includes("未匹配"),
			"missing on-miss trigger wording",
		);
	});

	it("states superpowers is coding-only (non-coding skips coding gates)", () => {
		const block = taskRoutingBlock(DEFAULT_GOAL_CONFIG);
		assert.ok(
			block.includes("coding") && block.toLowerCase().includes("superpowers"),
			"missing superpowers-coding link",
		);
		assert.ok(
			block.includes("非") && (block.includes("coding") || block.includes("编码")),
			"missing non-coding skip instruction",
		);
	});

	it("notes user-explicit task-type override when forceTaskType is set", () => {
		const cfg: GoalConfig = { ...DEFAULT_GOAL_CONFIG, forceTaskType: "research" };
		const block = taskRoutingBlock(cfg);
		assert.ok(
			block.includes("research"),
			"forceTaskType value should appear in block",
		);
		assert.ok(
			block.includes("显式") || block.toLowerCase().includes("explicit") || block.includes("指定"),
			"missing explicit-override note",
		);
	});
});

describe("loadGoalConfig forceTaskType", () => {
	it("defaults forceTaskType to undefined (LLM auto-judges)", () => {
		assert.equal(DEFAULT_GOAL_CONFIG.forceTaskType, undefined);
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.forceTaskType, undefined);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("reads forceTaskType from .pi/goal.json (trusted projects)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, ".pi", "goal.json"),
				JSON.stringify({ forceTaskType: "pm" }),
			);
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.forceTaskType, "pm");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("ignores forceTaskType on untrusted projects (rollback only for trusted)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, ".pi", "goal.json"),
				JSON.stringify({ forceTaskType: "pm" }),
			);
			const cfg = loadGoalConfig(tmp, false);
			assert.equal(cfg.forceTaskType, undefined); // untrusted → ignored
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
