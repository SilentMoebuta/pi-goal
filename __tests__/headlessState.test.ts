import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createGoalSnapshotV2,
	createGoalStateV2,
	decodeGoalSnapshot,
	type GoalStateV2,
} from "../extensions/state";
import type { HeadlessBlueprint } from "../extensions/spec-doc";

const BLUEPRINT: HeadlessBlueprint = {
	execution: {
		topology: "team",
		roleDefs: [{ name: "migrator", description: "迁移专家", prompt: "负责迁移" }],
		dag: { nodes: [{ id: "research", task: "分析", consumers: ["$result"] }] },
	},
	evidence: { criteria: [{ id: "c1", kinds: ["artifact"], minCount: 1 }] },
	review: { requirement: "required", checklist: ["检查迁移覆盖"] },
	verification: { command: "npm test" },
};

function baseGoal(overrides: Partial<GoalStateV2> = {}): GoalStateV2 {
	const goal = createGoalStateV2({
		id: "goal-1",
		objective: "迁移 auth 模块",
		criteria: [{ id: "c1", description: "测试通过", level: "blocking" }],
		constraints: ["不新增依赖"],
		taskKind: "coding",
		execution: {
			preference: "team",
			selected: "team",
			source: "user",
			confidence: 1,
			reasons: ["headless blueprint"],
			reassessOn: [],
		},
		assurance: {
			reviewRequirement: "required",
			reviewStatus: "pending",
			independent: true,
			depth: "deep",
			source: "user",
			reasons: ["headless blueprint"],
			decidedAt: 1000,
		},
		blueprint: BLUEPRINT,
		headless: { specPath: "spec.md", outputPath: "spec.result.json", logPath: "spec.goal.jsonl", startedAt: 1000 },
		now: 1000,
	});
	return { ...goal, ...overrides };
}

describe("headless goal state codec", () => {
	it("round-trips blueprint, deviations, and headless meta through a snapshot", () => {
		const goal = baseGoal();
		goal.deviations.push({
			id: "d1",
			subjectId: "dag.nodes.research",
			description: "改为串行",
			reason: "无并行空间",
			impact: "无",
			recordedAt: 2000,
			origin: "agent",
		});
		const snapshot = createGoalSnapshotV2({ revision: 1, savedAt: 3000, action: "update", goal });
		const decoded = decodeGoalSnapshot(snapshot);
		assert.equal(decoded.ok, true);
		if (!decoded.ok) return;
		const restored = decoded.snapshot.goal;
		assert.ok(restored);
		assert.deepEqual(restored.blueprint, BLUEPRINT);
		assert.equal(restored.deviations.length, 1);
		assert.deepEqual(restored.deviations[0], goal.deviations[0]);
		assert.equal(restored.headless?.outputPath, "spec.result.json");
	});

	it("defaults deviations to [] and omits blueprint/headless when absent", () => {
		const goal = createGoalStateV2({
			id: "goal-2",
			objective: "普通目标",
			criteria: [{ id: "c1", description: "完成", level: "blocking" }],
			taskKind: "coding",
			execution: { preference: "direct", selected: "direct", source: "auto", confidence: 1, reasons: [], reassessOn: [] },
			assurance: { reviewRequirement: "none", reviewStatus: "not_required", independent: false, depth: "light", source: "auto", reasons: [], decidedAt: 1 },
			now: 1,
		});
		assert.deepEqual(goal.deviations, []);
		assert.equal(goal.blueprint, undefined);
		assert.equal(goal.headless, undefined);
		const snapshot = createGoalSnapshotV2({ revision: 1, savedAt: 2, action: "set", goal });
		const decoded = decodeGoalSnapshot(snapshot);
		assert.equal(decoded.ok, true);
		if (!decoded.ok) return;
		assert.deepEqual(decoded.snapshot.goal?.deviations, []);
	});

	it("fails closed on an invalid stored blueprint", () => {
		const goal = baseGoal();
		const snapshot = createGoalSnapshotV2({ revision: 1, savedAt: 2, action: "update", goal });
		// 篡改 blueprint 使其形状非法
		(snapshot.goal as unknown as { blueprint: unknown }).blueprint = { execution: { topology: "swarm" } };
		const decoded = decodeGoalSnapshot(snapshot);
		assert.equal(decoded.ok, false);
		if (!decoded.ok) {
			assert.equal(decoded.kind, "corrupt");
			assert.match(decoded.message, /blueprint/);
		}
	});

	it("rejects a deviation with missing fields on decode", () => {
		const goal = baseGoal();
		const snapshot = createGoalSnapshotV2({ revision: 1, savedAt: 2, action: "update", goal });
		(snapshot.goal as unknown as { deviations: unknown[] }).deviations = [{ id: "d1" }];
		const decoded = decodeGoalSnapshot(snapshot);
		assert.equal(decoded.ok, false);
	});

	it("migrates a legacy V1 goal with an empty deviations array", () => {
		const legacy = {
			schemaVersion: 1,
			action: "set",
			goal: {
				id: "legacy-1",
				objective: "旧目标",
				status: "active",
				taskType: "coding",
				criteria: [{ id: "c1", description: "完成", evidence: ["证据文本"] }],
				constraints: [],
				tokenBudget: null,
				tokensUsed: 0,
				timeUsedMs: 0,
				createdAt: 1,
				updatedAt: 2,
				noProgressCount: 0,
				autoTurnCount: 0,
				pausedReason: null,
				blocker: null,
				completionEvidence: null,
				executionMode: "single",
			},
		};
		const decoded = decodeGoalSnapshot(legacy, { legacyRevision: 1 });
		assert.equal(decoded.ok, true);
		if (!decoded.ok) return;
		assert.equal(decoded.migratedFrom, 1);
		assert.deepEqual(decoded.snapshot.goal?.deviations, []);
		assert.equal(decoded.snapshot.goal?.blueprint, undefined);
	});
});
