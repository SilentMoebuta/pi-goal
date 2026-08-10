import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRegressionReport, evaluateBenchmarkOutput, validateHumanAnnotation, validateLLMJudgeEvaluation, validatePairwiseComparison } from "../extensions/evaluation-v3";
import { defaultBenchmarkFixtures } from "../extensions/benchmark-fixtures-v3";

describe("cross-project evaluation V3", () => {
	it("ships coding, research, document, and business fixtures", () => {
		assert.deepEqual(defaultBenchmarkFixtures().map((fixture) => fixture.kind), ["coding", "research", "document", "business"]);
	});
	it("runs deterministic checks and historical regression without an average score", async () => {
		const fixture = defaultBenchmarkFixtures()[0];
		const evaluation = await evaluateBenchmarkOutput(fixture, { artifact: true, tests: true }, [
			({ output }) => ({ id: "artifact", status: output.artifact ? "passed" : "failed", summary: "artifact" }),
			({ output }) => ({ id: "tests", status: output.tests ? "passed" : "failed", summary: "tests" }),
		]);
		assert.equal(evaluation.decision, "accept");
		assert.equal(buildRegressionReport([fixture], [evaluation], { [fixture.id]: "accept" }).status, "passed");
	});
	it("runs a no-average regression over all four cross-project fixture kinds", async () => {
		const fixtures = defaultBenchmarkFixtures();
		const evaluations = await Promise.all(fixtures.map((fixture) => evaluateBenchmarkOutput(fixture, { artifact: true, criteria: true }, [
			() => ({ id: "artifact", status: "passed", summary: `${fixture.kind} artifact is present` }),
			() => ({ id: "criteria", status: "passed", summary: `${fixture.kind} criteria are covered` }),
		])));
		const report = buildRegressionReport(fixtures, evaluations, Object.fromEntries(fixtures.map((fixture) => [fixture.id, "accept" as const])));
		assert.equal(report.status, "passed");
		assert.equal(report.passed.length, 4);
		assert.deepEqual(report.failed, []);
	});
	it("validates LLM judge criterion references and score bounds", () => {
		const fixture = defaultBenchmarkFixtures()[1];
		const errors = validateLLMJudgeEvaluation({ schemaVersion: 1, evaluator: { kind: "llm_judge", id: "judge", model: "model", rubricVersion: "1" }, fixtureId: fixture.id, decision: "accept", criterionScores: [{ criterionId: "unknown", score: 2, rationale: "x" }], findings: [], evaluatedAt: 1 }, fixture);
		assert.equal(errors.length, 2);
	});
	it("keeps pairwise and human annotation contracts explicit", () => {
		assert.deepEqual(validatePairwiseComparison({ schemaVersion: 1, fixtureId: "f", leftArtifactId: "a", rightArtifactId: "b", winner: "tie", dimensions: { clarity: "tie" }, rationale: "same", evaluatorId: "judge", evaluatedAt: 1 }), []);
		assert.deepEqual(validateHumanAnnotation({ schemaVersion: 1, fixtureId: "f", annotatorId: "human", decision: "accept", labels: { useful: true }, comments: "usable", createdAt: 1 }), []);
	});
	it("rejects malformed pairwise and human records at the runtime boundary", () => {
		const pairwise = validatePairwiseComparison({
			schemaVersion: 1,
			fixtureId: "f",
			leftArtifactId: "same",
			rightArtifactId: "same",
			winner: "left",
			dimensions: {},
			rationale: "",
			evaluatorId: "",
			evaluatedAt: 0,
		});
		assert.deepEqual(pairwise, [
			"pairwise artifacts must be different",
			"pairwise dimensions are required",
			"pairwise rationale is required",
			"pairwise evaluatorId is required",
			"pairwise evaluatedAt must be positive",
		]);
		const annotation = validateHumanAnnotation({
			schemaVersion: 1,
			fixtureId: "f",
			annotatorId: "human",
			decision: "invalid" as "accept",
			labels: {},
			comments: "",
			createdAt: Number.NaN,
		});
		assert.deepEqual(annotation, [
			"annotation decision is invalid",
			"annotation labels are required",
			"annotation comments are required",
			"annotation createdAt must be positive",
		]);
	});
});
