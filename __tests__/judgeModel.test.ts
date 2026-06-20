import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelSpec, type GoalConfig, DEFAULT_GOAL_CONFIG } from "../extensions/config";

// GG-14: a configurable judge model so the per-turn judge LLM call can use a
// separate small/fast model instead of always burning the session's ctx.model.
// parseModelSpec is the pure resolver that runJudge feeds into
// ctx.modelRegistry.find(provider, modelId); loadGoalConfig surfaces the
// `judgeModel` string from .pi/goal.json (trusted projects only).

describe("parseModelSpec (GG-14 judge model resolution)", () => {
	it("parses a provider/model-id spec", () => {
		assert.deepEqual(parseModelSpec("ksyun/glm-5.2"), { provider: "ksyun", modelId: "glm-5.2" });
		assert.deepEqual(parseModelSpec("anthropic/claude-sonnet-4"), { provider: "anthropic", modelId: "claude-sonnet-4" });
	});

	it("splits on the first slash so a model-id may itself contain slashes", () => {
		assert.deepEqual(parseModelSpec("openai/o3-mini"), { provider: "openai", modelId: "o3-mini" });
		assert.deepEqual(parseModelSpec("a/b/c"), { provider: "a", modelId: "b/c" });
	});

	it("returns null for an empty / whitespace-only / undefined spec", () => {
		assert.equal(parseModelSpec(""), null);
		assert.equal(parseModelSpec("   "), null);
		assert.equal(parseModelSpec(undefined as unknown as string), null);
	});

	it("returns null when there is no slash (cannot resolve a provider)", () => {
		assert.equal(parseModelSpec("noproviderslash"), null);
		assert.equal(parseModelSpec("glm-5.2"), null);
	});

	it("returns null for a spec with an empty provider or model-id", () => {
		assert.equal(parseModelSpec("/glm-5.2"), null);
		assert.equal(parseModelSpec("ksyun/"), null);
		assert.equal(parseModelSpec("ksyun/  "), null);
	});
});

describe("GoalConfig.judgeModel (GG-14 config wiring)", () => {
	it("is undefined by default (judge uses ctx.model — backward compatible)", () => {
		assert.equal(DEFAULT_GOAL_CONFIG.judgeModel, undefined);
	});
	it("is a valid typed field", () => {
		const c: GoalConfig = { superpowersIntegration: true, judgeModel: "ksyun/glm-5.2" };
		assert.equal(c.judgeModel, "ksyun/glm-5.2");
	});
});
