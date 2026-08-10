import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoalConfig, downgradeEnvironmentStateGates } from "../extensions/config";

describe("goal config v2", () => {
	it("uses the V2 policy defaults", () => {
		const { config, warnings } = parseGoalConfig({ schemaVersion: 2 });
		assert.equal(config.reviewPolicy, "risk_based");
		assert.equal(config.defaultExecution, "auto");
		assert.equal(config.completionPolicy, "v2");
		assert.equal(config.retryPolicy, undefined);
		assert.deepEqual(warnings, []);
	});

	it("parses bounded retryPolicy for interactive goals", () => {
		const { config, warnings } = parseGoalConfig({ retryPolicy: { maxInfrastructureAttempts: 3, maxSchemaRepairs: 1, baseDelayMs: 100, maxDelayMs: 1000 } });
		assert.deepEqual(config.retryPolicy, { maxInfrastructureAttempts: 3, maxSchemaRepairs: 1, baseDelayMs: 100, maxDelayMs: 1000 });
		assert.deepEqual(warnings, []);
	});

	it("rejects malformed retryPolicy fields without disabling other config", () => {
		const { config, warnings } = parseGoalConfig({ completionPolicy: "legacy", retryPolicy: { maxInfrastructureAttempts: 0, maxDelayMs: 1, baseDelayMs: 10 } });
		assert.equal(config.completionPolicy, "legacy");
		assert.deepEqual(config.retryPolicy, { baseDelayMs: 10 });
		assert.ok(warnings.some((warning) => warning.includes("maxInfrastructureAttempts")));
		assert.ok(warnings.some((warning) => warning.includes("maxDelayMs")));
	});

	it("accepts legacy flat keys for one compatibility cycle", () => {
		const { config } = parseGoalConfig({ judgeModel: "openai/evaluator", verifyTimeoutMs: 5000 });
		assert.equal(config.evaluatorModel, "openai/evaluator");
		assert.equal(config.judgeModel, "openai/evaluator");
		assert.equal(config.verifyTimeoutMs, 5000);
	});

	it("prefers evaluatorModel over judgeModel and warns", () => {
		const { config, warnings } = parseGoalConfig({
			evaluatorModel: "openai/new",
			judgeModel: "openai/old",
		});
		assert.equal(config.judgeModel, "openai/new");
		assert.ok(warnings.some((warning) => warning.includes("overrides")));
	});

	it("warns and falls back for invalid enums, empty models, and non-positive timeout", () => {
		const { config, warnings } = parseGoalConfig({
			reviewPolicy: "sometimes",
			defaultExecution: "squad",
			completionPolicy: "latest",
			forceTaskType: "unknown",
			evaluatorModel: "   ",
			verifyTimeoutMs: 0,
		});
		assert.equal(config.reviewPolicy, "risk_based");
		assert.equal(config.defaultExecution, "auto");
		assert.equal(config.completionPolicy, "v2");
		assert.equal(config.forceTaskType, undefined);
		assert.equal(config.evaluatorModel, undefined);
		assert.equal(config.verifyTimeoutMs, undefined);
		assert.ok(warnings.length >= 6);
	});

	it("fails closed to defaults for a future schema", () => {
		const { config, warnings } = parseGoalConfig({ schemaVersion: 99, reviewPolicy: "never" });
		assert.equal(config.reviewPolicy, "risk_based");
		assert.match(warnings[0], /newer|supported/i);
	});
});

describe("environment-state gate downgrade (UX finding)", () => {
	it("downgrades git-status cleanliness gates to advisory", () => {
		const { criteria, downgraded } = downgradeEnvironmentStateGates(
			[
				{ description: "git status --porcelain must be empty", level: "blocking" },
				{ description: "Both repos must show zero tracked changes", level: "blocking" },
				{ description: "The slugify function passes npm test", level: "blocking" },
			],
			"Implement a slugify function",
		);
		assert.deepEqual(downgraded, [
			"git status --porcelain must be empty",
			"Both repos must show zero tracked changes",
		]);
		assert.equal(criteria[0].level, "advisory");
		assert.equal(criteria[1].level, "advisory");
		assert.equal(criteria[2].level, "blocking");
	});

	it("keeps the gate blocking when the objective itself targets repo state", () => {
		const { downgraded } = downgradeEnvironmentStateGates(
			[{ description: "The worktree is clean with no untracked files", level: "blocking" }],
			"Clean up the git worktree and remove untracked files",
		);
		assert.deepEqual(downgraded, []);
	});

	it("handles Chinese gates and already-advisory criteria", () => {
		const { criteria, downgraded } = downgradeEnvironmentStateGates(
			[
				{ description: "两个仓库必须没有未提交改动", level: "blocking" },
				{ description: "工作区无修改", level: "advisory" },
			],
			"对比两个仓库的协议差异",
		);
		assert.deepEqual(downgraded, ["两个仓库必须没有未提交改动"]);
		assert.equal(criteria[0].level, "advisory");
		assert.equal(criteria[1].level, "advisory"); // untouched
	});

	it("does not downgrade unrelated environment assertions", () => {
		const { criteria, downgraded } = downgradeEnvironmentStateGates(
			[{ description: "No debug files remain in the repository", level: "blocking" }],
			"Remove debug prints from the codebase",
		);
		assert.deepEqual(downgraded, []);
		assert.equal(criteria[0].level, "blocking");
	});
});
