import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlueprint, parseGoalSpecMarkdown, proposalToMarkdown, type HeadlessBlueprint } from "../extensions/spec-doc";

const FULL_BLUEPRINT: HeadlessBlueprint = {
	entry: { prompt: "额外启动指令" },
	execution: {
		topology: "team",
		roleDefs: [
			{ name: "migrator", description: "JWT 迁移专家", prompt: "你负责 src/auth 迁移", tools: ["read", "bash", "edit", "write"], maxTurns: 200, model: "deepseek/deepseek-v4-flash", thinkingLevel: "medium" },
		],
		dag: {
			nodes: [
				{ id: "research", task: "分析影响面", roleDef: "migrator", expected_output: "影响面清单", consumers: ["implement"] },
				{ id: "implement", task: "实现迁移", roleDef: "migrator", expected_output: "jwt.ts", consumers: ["$result"] },
			],
			maxConcurrent: 2,
		},
	},
	evidence: {
		criteria: [
			{ id: "c1", kinds: ["artifact", "command"], minCount: 1, verification: "verified", note: "artifact 指向测试输出" },
		],
		nodes: [
			{ id: "research", evidenceKind: "artifact", attachTo: "c1" },
			{ id: "implement", evidenceKind: "command", attachTo: "c1" },
		],
	},
	review: { requirement: "required", model: "anthropic/sonnet", thinkingLevel: "high", tools: ["read", "bash"], checklist: ["运行契约测试", "确认无新依赖"], maxTurns: 120 },
	verification: { command: "npm test", timeoutMs: 120000 },
	budget: { tokens: 500000 },
	retry: { maxInfrastructureAttempts: 4, maxSchemaRepairs: 1, baseDelayMs: 2500, maxDelayMs: 30000 },
	completion: { policy: "v2", maxAutoTurns: 200 },
};

describe("headless blueprint parse", () => {
	it("parses a full blueprint with all fields", () => {
		const result = parseBlueprint(FULL_BLUEPRINT);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.blueprint, FULL_BLUEPRINT);
	});

	it("round-trips through the spec markdown machine block", () => {
		const md = proposalToMarkdown({
			original: "headless 测试",
			objective: "JWT 迁移",
			criteria: [{ description: "测试通过", level: "blocking" }],
			constraints: [],
			claims: [],
			machine: { taskKind: "coding", blueprint: FULL_BLUEPRINT },
		});
		const parsed = parseGoalSpecMarkdown(md);
		assert.equal(parsed.ok, true);
		assert.ok(parsed.doc);
		const roundTripped = parseBlueprint((parsed.doc.machine as { blueprint?: unknown }).blueprint);
		assert.equal(roundTripped.ok, true);
		if (roundTripped.ok) assert.deepEqual(roundTripped.blueprint, FULL_BLUEPRINT);
	});

	it("defaults to direct topology when blueprint is absent", () => {
		const result = parseBlueprint(undefined);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.blueprint, { execution: { topology: "direct" } });
	});

	it("returns errors for invalid topology and review requirement", () => {
		const result = parseBlueprint({ execution: { topology: "swarm" }, review: { requirement: "maybe", checklist: [] } });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.errors.some((error) => error.includes("topology")));
			assert.ok(result.errors.some((error) => error.includes("requirement")));
		}
	});

	it("rejects duplicate roleDef names", () => {
		const result = parseBlueprint({
			execution: {
				topology: "team",
				roleDefs: [
					{ name: "migrator", description: "a", prompt: "p" },
					{ name: "migrator", description: "b", prompt: "q" },
				],
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("duplicates migrator")));
	});

	it("rejects dag nodes referencing unknown roleDefs", () => {
		const result = parseBlueprint({
			execution: {
				topology: "team",
				dag: { nodes: [{ id: "n1", task: "t", roleDef: "ghost" }] },
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("unknown roleDef ghost")));
	});

	it("rejects duplicate dag node ids and unknown consumers", () => {
		const result = parseBlueprint({
			execution: {
				topology: "team",
				dag: { nodes: [
					{ id: "n1", task: "a", consumers: ["n2"] },
					{ id: "n1", task: "b", consumers: ["ghost"] },
				] },
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.errors.some((error) => error.includes("duplicates n1")));
			assert.ok(result.errors.some((error) => error.includes("unknown node ghost")));
			// n2 未定义也报错（consumers 引用必须存在）
			assert.ok(result.errors.some((error) => error.includes("unknown node n2")));
		}
	});

	it("rejects roleDef and role together on a dag node", () => {
		const result = parseBlueprint({
			execution: {
				topology: "team",
				roleDefs: [{ name: "migrator", description: "a", prompt: "p" }],
				dag: { nodes: [{ id: "n1", task: "t", roleDef: "migrator", role: "coder" }] },
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("mutually exclusive")));
	});

	it("rejects missing required roleDef fields", () => {
		const result = parseBlueprint({ execution: { topology: "team", roleDefs: [{ name: "migrator" }] } });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.errors.some((error) => error.includes("description")));
			assert.ok(result.errors.some((error) => error.includes("prompt")));
		}
	});

	it("rejects evidence.node references to unknown nodes/roleDefs", () => {
		const result = parseBlueprint({
			execution: { topology: "team", dag: { nodes: [{ id: "n1", task: "t" }] } },
			evidence: { nodes: [{ id: "ghost", evidenceKind: "artifact", attachTo: "c1" }] },
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("unknown node/roleDef ghost")));
	});

	it("allows evidence.nodes to reference roleDef names when no dag exists", () => {
		const result = parseBlueprint({
			execution: { topology: "specialist", roleDefs: [{ name: "auditor", description: "a", prompt: "p" }] },
			evidence: { nodes: [{ id: "auditor", evidenceKind: "artifact", attachTo: "c1" }] },
		});
		assert.equal(result.ok, true);
	});

	it("rejects invalid verification and budget", () => {
		const result = parseBlueprint({
			verification: { timeoutMs: -1 },
			budget: { tokens: 0 },
			retry: { maxInfrastructureAttempts: 0, maxSchemaRepairs: -1, baseDelayMs: 200, maxDelayMs: 100 },
			completion: { policy: "v9" },
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.errors.some((error) => error.includes("command")));
			assert.ok(result.errors.some((error) => error.includes("timeoutMs")));
			assert.ok(result.errors.some((error) => error.includes("tokens")));
			assert.ok(result.errors.some((error) => error.includes("maxInfrastructureAttempts")));
			assert.ok(result.errors.some((error) => error.includes("maxSchemaRepairs")));
			assert.ok(result.errors.some((error) => error.includes("maxDelayMs")));
			assert.ok(result.errors.some((error) => error.includes("policy")));
		}
	});

	it("accepts minimal specialist blueprint with roleDefs only", () => {
		const result = parseBlueprint({
			execution: {
				topology: "specialist",
				roleDefs: [{ name: "auditor", description: "a", prompt: "p" }],
			},
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.blueprint.execution.topology, "specialist");
	});
});
