import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseBlueprint, type GoalSpecDoc, type HeadlessBlueprint } from "../extensions/spec-doc";
import {
	appendGoalLog,
	buildGoalLogEntry,
	buildGoalResultView,
	createGoalFromBlueprint,
	finalizeHeadlessGoal,
	HEADLESS_LOG_MAX_BYTES,
	specCriterionId,
	validateBlueprint,
} from "../extensions/headless";
import type { GoalStateV2 } from "../extensions/state";

function doc(overrides: Partial<GoalSpecDoc> = {}): GoalSpecDoc {
	return {
		title: "t",
		original: "o",
		objective: "实现 JWT 迁移",
		criteria: [
			{ description: "测试通过", level: "blocking" },
			{ description: "README 更新", level: "advisory" },
		],
		constraints: ["不新增依赖"],
		claims: [{ id: "parity", text: "迁移等价", materiality: "material", risk: "high", evidenceRefs: [] }],
		decisions: [],
		machine: { taskKind: "coding" },
		...overrides,
	};
}

const BLUEPRINT: HeadlessBlueprint = {
	execution: {
		topology: "team",
		roleDefs: [{ name: "migrator", description: "迁移专家", prompt: "负责迁移" }],
		dag: {
			nodes: [
				{ id: "research", task: "分析影响面", roleDef: "migrator", consumers: ["implement"] },
				{ id: "implement", task: "实现迁移", roleDef: "migrator", consumers: ["$result"] },
			],
		},
	},
	evidence: {
		criteria: [{ id: "c1", kinds: ["artifact", "command"], minCount: 1, verification: "verified" }],
		nodes: [{ id: "research", evidenceKind: "artifact", attachTo: "c1" }],
	},
	review: { requirement: "required", checklist: ["运行契约测试"], model: "anthropic/sonnet" },
	verification: { command: "npm test" },
	budget: { tokens: 500000 },
};

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-headless-")); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeGoal(blueprint: HeadlessBlueprint, docOverride?: Partial<GoalSpecDoc>): GoalStateV2 {
	return createGoalFromBlueprint({
		id: "goal-h1",
		doc: doc(docOverride),
		blueprint,
		specPath: path.join(tmpDir, "spec.md"),
		outputPath: path.join(tmpDir, "spec.result.json"),
		logPath: path.join(tmpDir, "spec.goal.jsonl"),
		now: 1000,
	});
}

describe("validateBlueprint", () => {
	it("accepts a valid blueprint in a trusted project", () => {
		const result = validateBlueprint(BLUEPRINT, doc(), { trusted: true });
		assert.equal(result.ok, true);
	});

	it("rejects verification.command in an untrusted project", () => {
		const result = validateBlueprint(BLUEPRINT, doc(), { trusted: false });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("trusted")));
	});

	it("rejects evidence expectations referencing unknown criteria", () => {
		const result = validateBlueprint(
			{ ...BLUEPRINT, evidence: { criteria: [{ id: "ghost", kinds: ["artifact"] }], nodes: [] } },
			doc(),
			{ trusted: true },
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("ghost")));
	});

	it("accepts evidence expectations referencing generated criterion ids c1..cN", () => {
		assert.equal(specCriterionId(0), "c1");
		assert.equal(specCriterionId(1), "c2");
		const result = validateBlueprint(
			{ ...BLUEPRINT, evidence: { criteria: [{ id: "c2", kinds: ["artifact"] }], nodes: [] } },
			doc(),
			{ trusted: true },
		);
		assert.equal(result.ok, true);
	});

	it("rejects unknown evidence kinds and specialist without role or roleDefs", () => {
		const badKind = validateBlueprint(
			{ ...BLUEPRINT, evidence: { criteria: [{ id: "c1", kinds: ["magic"] }], nodes: [] } },
			doc(),
			{ trusted: true },
		);
		assert.equal(badKind.ok, false);
		const bareSpecialist = validateBlueprint({ execution: { topology: "specialist" } }, doc(), { trusted: true });
		assert.equal(bareSpecialist.ok, false);
		if (!bareSpecialist.ok) assert.ok(bareSpecialist.errors.some((error) => error.includes("specialist")));
	});
});

describe("createGoalFromBlueprint", () => {
	it("builds a locked execution decision from the blueprint topology", () => {
		const goal = makeGoal(BLUEPRINT);
		assert.equal(goal.execution.selected, "team");
		assert.equal(goal.execution.preference, "team");
		assert.equal(goal.execution.source, "user");
		assert.deepEqual(goal.execution.reassessOn, []);
		assert.equal(goal.tokenBudget, 500000);
		assert.equal(goal.assurance.reviewRequirement, "required");
		assert.equal(goal.assurance.depth, "deep");
		assert.deepEqual(goal.deviations, []);
		assert.equal(goal.criteria.length, 2);
		assert.equal(goal.criteria[0].id, "c1");
		assert.equal(goal.criteria[1].id, "c2");
		assert.equal(goal.claims[0].id, "parity");
		assert.equal(goal.headless?.logPath.includes("spec.goal.jsonl"), true);
	});

	it("defaults assurance to advisory and budget to null when unspecified", () => {
		const goal = makeGoal({ execution: { topology: "direct" } });
		assert.equal(goal.assurance.reviewRequirement, "advisory");
		assert.equal(goal.tokenBudget, null);
		assert.equal(goal.execution.selected, "direct");
	});
});

describe("buildGoalResultView", () => {
	it("reports criterion statuses from the evidence ledger", () => {
		const goal = makeGoal(BLUEPRINT);
		goal.evidenceLedger.push({
			id: "e1", kind: "artifact", summary: "测试输出", locator: "out.txt", recordedAt: 1001, origin: "tool", verification: "verified",
		});
		goal.criteria[0].evidenceRefs.push("e1");
		const view = buildGoalResultView(goal, 2000);
		assert.equal(view.status, "active");
		const criteria = view.criteria as Array<{ id: string; status: string }>;
		assert.equal(criteria[0].status, "verified");
		assert.equal(criteria[1].status, "pending");
		assert.equal((view.resources as { wallMs: number }).wallMs, 1000);
		assert.equal((view.exit as { code: number }).code, 1);
	});

	it("reports blocked when any evidence is rejected", () => {
		const goal = makeGoal(BLUEPRINT);
		goal.evidenceLedger.push({
			id: "e1", kind: "artifact", summary: "缺失产物", locator: "gone.txt", recordedAt: 1001, origin: "tool", verification: "rejected",
		});
		goal.criteria[0].evidenceRefs.push("e1");
		const view = buildGoalResultView(goal, 2000);
		assert.equal((view.criteria as Array<{ status: string }>)[0].status, "blocked");
	});

	it("uses exit code 0 for a complete goal", () => {
		const goal = makeGoal(BLUEPRINT);
		goal.status = "complete";
		goal.endedAt = 2000;
		const view = buildGoalResultView(goal, 2000);
		assert.equal((view.exit as { code: number }).code, 0);
		assert.equal((view.exit as { message: string }).message, "Goal achieved.");
	});
});

describe("goal log and result files", () => {
	it("appends JSONL entries and a terminal result file", () => {
		const goal = makeGoal(BLUEPRINT);
		appendGoalLog(goal.headless!.logPath, buildGoalLogEntry(goal.id, "goal_started", { objective: goal.objective }, 1000));
		appendGoalLog(goal.headless!.logPath, buildGoalLogEntry(goal.id, "status", { status: "active" }, 1001));
		const terminal = finalizeHeadlessGoal(goal, 2000);

		const lines = fs.readFileSync(goal.headless!.logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 3);
		const started = JSON.parse(lines[0]);
		assert.equal(started.type, "goal_started");
		assert.equal(started.goalId, "goal-h1");
		assert.equal(started.v, 1);
		const status = JSON.parse(lines[1]);
		assert.equal(status.type, "status");
		assert.equal(terminal.type, "terminal");

		const result = JSON.parse(fs.readFileSync(goal.headless!.outputPath, "utf8"));
		assert.equal(result.schemaVersion, 1);
		assert.equal(result.objective, "实现 JWT 迁移");
		assert.equal(result.exit.code, 1);
	});

	it("backs up an existing result file to .prev", () => {
		const goal = makeGoal(BLUEPRINT);
		fs.writeFileSync(goal.headless!.outputPath, "{\"old\":true}\n");
		finalizeHeadlessGoal(goal, 2000);
		assert.equal(fs.existsSync(goal.headless!.outputPath + ".prev"), true);
		const prev = JSON.parse(fs.readFileSync(goal.headless!.outputPath + ".prev", "utf8"));
		assert.equal(prev.old, true);
	});

	it("stops appending after the size cap and writes log_truncated", () => {
		const goal = makeGoal(BLUEPRINT);
		// 预写一个超过上限的日志文件
		fs.writeFileSync(goal.headless!.logPath, "x".repeat(HEADLESS_LOG_MAX_BYTES + 1) + "\n");
		appendGoalLog(goal.headless!.logPath, buildGoalLogEntry(goal.id, "status", { status: "active" }, 1001));
		appendGoalLog(goal.headless!.logPath, buildGoalLogEntry(goal.id, "status", { status: "paused" }, 1002));
		const content = fs.readFileSync(goal.headless!.logPath, "utf8");
		assert.match(content, /log_truncated/);
		// 截断后不再追加第二条
		assert.equal((content.match(/log_truncated/g) ?? []).length, 1);
		assert.equal(content.includes("paused"), false);
	});
});
