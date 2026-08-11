import type { OfflineTrajectorySampleV3, RuntimeMetricsV3 } from "./observability-v3";

export const EVALUATION_SCHEMA_VERSION = 1 as const;

export type BenchmarkKindV3 = "coding" | "research" | "document" | "business";
export type EvaluationDecisionV3 = "accept" | "revise" | "blocked";

export interface BenchmarkFixtureV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	id: string;
	version: string;
	kind: BenchmarkKindV3;
	objective: string;
	input: Record<string, unknown>;
	expected: {
		criteria: string[];
		requiredArtifacts?: string[];
		referenceOutput?: string;
	};
}

export interface DeterministicCheckV3 {
	id: string;
	status: "passed" | "failed";
	summary: string;
	details?: Record<string, unknown>;
}

export interface DeterministicEvaluationV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	evaluator: { kind: "deterministic"; id: string; version: string };
	fixtureId: string;
	decision: EvaluationDecisionV3;
	score: number;
	checks: DeterministicCheckV3[];
	evaluatedAt: number;
}

export type DeterministicCheckFn<TOutput> = (input: {
	fixture: BenchmarkFixtureV3;
	output: TOutput;
}) => DeterministicCheckV3 | Promise<DeterministicCheckV3>;

export function validateBenchmarkFixture(fixture: BenchmarkFixtureV3): string[] {
	const errors: string[] = [];
	if (fixture.schemaVersion !== EVALUATION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${EVALUATION_SCHEMA_VERSION}`);
	if (!fixture.id.trim() || !fixture.version.trim()) errors.push("fixture id and version are required");
	if (!fixture.objective.trim()) errors.push("fixture objective is required");
	if (!Array.isArray(fixture.expected.criteria) || fixture.expected.criteria.length === 0) errors.push("fixture requires at least one expected criterion");
	if (!fixture.input || typeof fixture.input !== "object" || Array.isArray(fixture.input)) errors.push("fixture input must be an object");
	return errors;
}

export async function evaluateBenchmarkOutput<TOutput>(
	fixture: BenchmarkFixtureV3,
	output: TOutput,
	checks: DeterministicCheckFn<TOutput>[],
	options: { evaluatorId?: string; evaluatorVersion?: string; evaluatedAt?: number } = {},
): Promise<DeterministicEvaluationV3> {
	const fixtureErrors = validateBenchmarkFixture(fixture);
	if (fixtureErrors.length > 0) throw new Error(`invalid benchmark fixture: ${fixtureErrors.join("; ")}`);
	const checkResults: DeterministicCheckV3[] = [];
	for (const check of checks) {
		try {
			const result = await check({ fixture, output });
			if (!result.id.trim() || !result.summary.trim() || !["passed", "failed"].includes(result.status)) throw new Error("invalid deterministic check result");
			checkResults.push(structuredClone(result));
		} catch (error) {
			checkResults.push({ id: `check:${checkResults.length + 1}`, status: "failed", summary: error instanceof Error ? error.message : String(error) });
		}
	}
	const score = checkResults.length === 0 ? 0 : checkResults.filter((check) => check.status === "passed").length / checkResults.length;
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		evaluator: { kind: "deterministic", id: options.evaluatorId ?? "deterministic", version: options.evaluatorVersion ?? "1" },
		fixtureId: fixture.id,
		decision: checkResults.length > 0 && checkResults.every((check) => check.status === "passed") ? "accept" : "revise",
		score,
		checks: checkResults,
		evaluatedAt: options.evaluatedAt ?? Date.now(),
	};
}

export interface LLMJudgeEvaluationV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	evaluator: { kind: "llm_judge"; id: string; model: string; rubricVersion: string };
	fixtureId: string;
	decision: EvaluationDecisionV3;
	criterionScores: Array<{ criterionId: string; score: number; rationale: string }>;
	findings: Array<{ id: string; severity: "major" | "minor" | "advisory"; reason: string }>;
	evaluatedAt: number;
}

export function validateLLMJudgeEvaluation(value: LLMJudgeEvaluationV3, fixture: BenchmarkFixtureV3): string[] {
	const errors: string[] = [];
	if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) errors.push("judge schemaVersion is invalid");
	if (value.fixtureId !== fixture.id) errors.push("judge fixtureId does not match fixture");
	const criterionIds = new Set(fixture.expected.criteria);
	for (const score of value.criterionScores) {
		if (!criterionIds.has(score.criterionId)) errors.push(`judge references unknown criterion '${score.criterionId}'`);
		if (!Number.isFinite(score.score) || score.score < 0 || score.score > 1) errors.push(`judge score for '${score.criterionId}' must be between 0 and 1`);
		if (!score.rationale.trim()) errors.push(`judge rationale for '${score.criterionId}' is required`);
	}
	return errors;
}

export interface PairwiseComparisonV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	fixtureId: string;
	leftArtifactId: string;
	rightArtifactId: string;
	winner: "left" | "right" | "tie";
	dimensions: Record<string, "left" | "right" | "tie">;
	rationale: string;
	evaluatorId: string;
	evaluatedAt: number;
}

export interface HumanAnnotationV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	fixtureId: string;
	annotatorId: string;
	decision: EvaluationDecisionV3;
	labels: Record<string, string | number | boolean>;
	comments: string;
	createdAt: number;
}

export function validatePairwiseComparison(value: PairwiseComparisonV3): string[] {
	const errors: string[] = [];
	if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) errors.push("pairwise schemaVersion is invalid");
	if (!value.fixtureId.trim() || !value.leftArtifactId.trim() || !value.rightArtifactId.trim()) errors.push("pairwise fixture and artifact ids are required");
	if (value.leftArtifactId === value.rightArtifactId) errors.push("pairwise artifacts must be different");
	if (!["left", "right", "tie"].includes(value.winner)) errors.push("pairwise winner is invalid");
	if (!value.dimensions || typeof value.dimensions !== "object" || Array.isArray(value.dimensions) || Object.keys(value.dimensions).length === 0) {
		errors.push("pairwise dimensions are required");
	} else if (Object.entries(value.dimensions).some(([dimension, decision]) => !dimension.trim() || !["left", "right", "tie"].includes(decision))) {
		errors.push("pairwise dimensions contain an invalid decision");
	}
	if (!value.rationale.trim()) errors.push("pairwise rationale is required");
	if (!value.evaluatorId.trim()) errors.push("pairwise evaluatorId is required");
	if (!Number.isFinite(value.evaluatedAt) || value.evaluatedAt <= 0) errors.push("pairwise evaluatedAt must be positive");
	return errors;
}

export function validateHumanAnnotation(value: HumanAnnotationV3): string[] {
	const errors: string[] = [];
	if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) errors.push("annotation schemaVersion is invalid");
	if (!value.fixtureId.trim() || !value.annotatorId.trim()) errors.push("annotation fixture and annotator ids are required");
	if (!["accept", "revise", "blocked"].includes(value.decision)) errors.push("annotation decision is invalid");
	if (!value.labels || typeof value.labels !== "object" || Array.isArray(value.labels) || Object.keys(value.labels).length === 0) {
		errors.push("annotation labels are required");
	} else if (Object.entries(value.labels).some(([label, answer]) =>
		!label.trim()
		|| !["string", "number", "boolean"].includes(typeof answer)
		|| (typeof answer === "number" && !Number.isFinite(answer)))) {
		errors.push("annotation labels must contain named finite scalar values");
	}
	if (!value.comments.trim()) errors.push("annotation comments are required");
	if (!Number.isFinite(value.createdAt) || value.createdAt <= 0) errors.push("annotation createdAt must be positive");
	return errors;
}

export interface RegressionReportV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	fixtureVersions: Record<string, string>;
	passed: string[];
	failed: Array<{ fixtureId: string; reason: string }>;
	status: "passed" | "failed";
}

export const RUN_QUALITY_DIMENSIONS_V3 = [
	"final_output",
	"tool_trajectory",
	"artifact_correctness",
	"human_intervention",
	"recovery_correctness",
	"cost",
	"latency",
] as const;

export type RunQualityDimensionV3 = typeof RUN_QUALITY_DIMENSIONS_V3[number];
export type RunQualityDimensionStatusV3 = "passed" | "failed" | "unverified" | "not_applicable";

export interface RunQualityDimensionResultV3 {
	dimension: RunQualityDimensionV3;
	status: RunQualityDimensionStatusV3;
	summary: string;
	value: string | number | boolean | null;
	threshold: string | number | boolean | null;
}

export interface RunQualityGatePolicyV3 {
	id: string;
	version: string;
	requiredDimensions: RunQualityDimensionV3[];
	requiredTrajectorySpanNames?: string[];
	maxHumanInterventions?: number;
	requireHumanAcceptance?: boolean;
	requireRecoveryExercise?: boolean;
	maxCostUsd?: number;
	maxLatencyMs?: number;
}

export interface RunQualityEvaluationV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	fixtureId: string;
	policy: { id: string; version: string };
	decision: EvaluationDecisionV3;
	dimensions: RunQualityDimensionResultV3[];
	trajectorySampleId: string;
	evaluatedAt: number;
}

function qualityResult(
	dimension: RunQualityDimensionV3,
	status: RunQualityDimensionStatusV3,
	summary: string,
	value: RunQualityDimensionResultV3["value"],
	threshold: RunQualityDimensionResultV3["threshold"] = null,
): RunQualityDimensionResultV3 {
	return { dimension, status, summary, value, threshold };
}

function finiteNonNegative(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
	return value;
}

export function evaluateRunQualityV3(input: {
	fixtureId: string;
	finalOutput: DeterministicEvaluationV3;
	trajectory: OfflineTrajectorySampleV3;
	metrics: RuntimeMetricsV3;
	policy: RunQualityGatePolicyV3;
	evaluatedAt?: number;
}): RunQualityEvaluationV3 {
	if (!input.fixtureId.trim()) throw new Error("fixtureId is required");
	if (input.finalOutput.fixtureId !== input.fixtureId) throw new Error("final output fixtureId does not match run fixtureId");
	if (!input.policy.id.trim() || !input.policy.version.trim()) throw new Error("quality policy id and version are required");
	const required = new Set(input.policy.requiredDimensions);
	if (required.size !== input.policy.requiredDimensions.length) throw new Error("quality policy requiredDimensions contains duplicates");
	for (const dimension of required) {
		if (!RUN_QUALITY_DIMENSIONS_V3.includes(dimension)) throw new Error(`unknown quality dimension '${dimension}'`);
	}
	const maxHumanInterventions = finiteNonNegative(input.policy.maxHumanInterventions, "maxHumanInterventions");
	const maxCostUsd = finiteNonNegative(input.policy.maxCostUsd, "maxCostUsd");
	const maxLatencyMs = finiteNonNegative(input.policy.maxLatencyMs, "maxLatencyMs");
	const requiredSpans = [...new Set(input.policy.requiredTrajectorySpanNames ?? [])];
	const missingSpans = requiredSpans.filter((name) => !input.trajectory.spanNames.includes(name));
	const dimensions: RunQualityDimensionResultV3[] = [];

	dimensions.push(qualityResult(
		"final_output",
		input.finalOutput.decision === "accept" && input.metrics.success && input.metrics.schemaValidity ? "passed" : "failed",
		input.finalOutput.decision === "accept" && input.metrics.success && input.metrics.schemaValidity
			? "The deterministic final-output evaluation, terminal state, and result schema passed."
			: `Final output decision=${input.finalOutput.decision}, success=${input.metrics.success}, schemaValid=${input.metrics.schemaValidity}.`,
		input.finalOutput.decision,
		"accept",
	));
	dimensions.push(qualityResult(
		"tool_trajectory",
		input.trajectory.eligibleForRegression && missingSpans.length === 0 ? "passed" : "failed",
		input.trajectory.eligibleForRegression && missingSpans.length === 0
			? "The trajectory is anomaly-free and contains every required span."
			: [...input.trajectory.anomalyReasons, ...(missingSpans.length > 0 ? [`missing spans: ${missingSpans.join(", ")}`] : [])].join("; "),
		input.trajectory.steps.length,
		requiredSpans.length,
	));
	const artifactStatus: RunQualityDimensionStatusV3 = input.metrics.artifactCorrectness === null
		? "unverified"
		: input.metrics.artifactCorrectness === 1 ? "passed" : "failed";
	dimensions.push(qualityResult(
		"artifact_correctness",
		artifactStatus,
		input.metrics.artifactCorrectness === null
			? "No artifact correctness check was supplied."
			: `${Math.round(input.metrics.artifactCorrectness * 100)}% of verified artifact checks passed.`,
		input.metrics.artifactCorrectness,
		1,
	));
	let humanStatus: RunQualityDimensionStatusV3 = "passed";
	const humanReasons: string[] = [];
	if (input.policy.requireHumanAcceptance && input.metrics.humanAcceptance === null) {
		humanStatus = "unverified";
		humanReasons.push("human acceptance is not submitted");
	} else if (input.metrics.humanAcceptance === false) {
		humanStatus = "failed";
		humanReasons.push("human reviewer rejected the output");
	}
	if (maxHumanInterventions !== undefined && input.metrics.humanInterventions > maxHumanInterventions) {
		humanStatus = "failed";
		humanReasons.push(`human interventions ${input.metrics.humanInterventions} exceed ${maxHumanInterventions}`);
	}
	dimensions.push(qualityResult(
		"human_intervention",
		humanStatus,
		humanReasons.length === 0 ? `Human interventions=${input.metrics.humanInterventions}; acceptance=${input.metrics.humanAcceptance ?? "not_submitted"}.` : humanReasons.join("; "),
		input.metrics.humanInterventions,
		maxHumanInterventions ?? null,
	));
	const recoveryStatus: RunQualityDimensionStatusV3 = input.metrics.recoveryAttempts === 0
		? input.policy.requireRecoveryExercise ? "unverified" : "not_applicable"
		: input.metrics.recoveryCorrectness ? "passed" : "failed";
	dimensions.push(qualityResult(
		"recovery_correctness",
		recoveryStatus,
		input.metrics.recoveryAttempts === 0
			? "This run did not exercise recovery."
			: `Recovery attempts=${input.metrics.recoveryAttempts}; correct=${input.metrics.recoveryCorrectness}.`,
		input.metrics.recoveryCorrectness,
		input.policy.requireRecoveryExercise,
	));
	const costStatus: RunQualityDimensionStatusV3 = input.metrics.costUsd === null || maxCostUsd === undefined
		? "unverified"
		: input.metrics.costUsd <= maxCostUsd ? "passed" : "failed";
	dimensions.push(qualityResult(
		"cost",
		costStatus,
		input.metrics.costUsd === null ? "Provider cost was not recorded."
			: maxCostUsd === undefined ? "No cost threshold was supplied."
				: `Cost USD=${input.metrics.costUsd}; maximum=${maxCostUsd}.`,
		input.metrics.costUsd,
		maxCostUsd ?? null,
	));
	const latencyStatus: RunQualityDimensionStatusV3 = maxLatencyMs === undefined
		? "unverified"
		: input.metrics.latencyMs <= maxLatencyMs ? "passed" : "failed";
	dimensions.push(qualityResult(
		"latency",
		latencyStatus,
		maxLatencyMs === undefined ? "No latency threshold was supplied." : `Latency ms=${input.metrics.latencyMs}; maximum=${maxLatencyMs}.`,
		input.metrics.latencyMs,
		maxLatencyMs ?? null,
	));

	const requiredResults = dimensions.filter((dimension) => required.has(dimension.dimension));
	const decision: EvaluationDecisionV3 = requiredResults.some((dimension) => dimension.status === "failed")
		? "revise"
		: requiredResults.some((dimension) => dimension.status === "unverified")
			? "blocked"
			: "accept";
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		fixtureId: input.fixtureId,
		policy: { id: input.policy.id, version: input.policy.version },
		decision,
		dimensions,
		trajectorySampleId: input.trajectory.sampleId,
		evaluatedAt: input.evaluatedAt ?? Date.now(),
	};
}

export interface RunQualityRegressionCaseV3 {
	fixtureId: string;
	fixtureVersion: string;
	requiredDimensions: RunQualityDimensionV3[];
}

export interface RunQualityRegressionReportV3 {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	fixtureVersions: Record<string, string>;
	passed: string[];
	failed: Array<{ fixtureId: string; reason: string }>;
	status: "passed" | "failed";
}

/** A no-average release gate: one missing or non-passing required dimension fails the fixture. */
export function buildRunQualityRegressionReportV3(
	cases: RunQualityRegressionCaseV3[],
	evaluations: RunQualityEvaluationV3[],
): RunQualityRegressionReportV3 {
	const byFixture = new Map(evaluations.map((evaluation) => [evaluation.fixtureId, evaluation]));
	const passed: string[] = [];
	const failed: Array<{ fixtureId: string; reason: string }> = [];
	for (const regressionCase of cases) {
		const evaluation = byFixture.get(regressionCase.fixtureId);
		if (!evaluation) {
			failed.push({ fixtureId: regressionCase.fixtureId, reason: "missing run-quality evaluation" });
			continue;
		}
		const dimensions = new Map(evaluation.dimensions.map((dimension) => [dimension.dimension, dimension]));
		const failing = regressionCase.requiredDimensions.filter((name) => dimensions.get(name)?.status !== "passed");
		if (evaluation.decision !== "accept" || failing.length > 0) {
			failed.push({ fixtureId: regressionCase.fixtureId, reason: failing.length > 0 ? `non-passing dimensions: ${failing.join(", ")}` : `decision=${evaluation.decision}` });
			continue;
		}
		passed.push(regressionCase.fixtureId);
	}
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		fixtureVersions: Object.fromEntries(cases.map((regressionCase) => [regressionCase.fixtureId, regressionCase.fixtureVersion])),
		passed,
		failed,
		status: failed.length === 0 ? "passed" : "failed",
	};
}

export function buildRegressionReport(
	fixtures: BenchmarkFixtureV3[],
	evaluations: DeterministicEvaluationV3[],
	baseline: Record<string, "accept" | "revise" | "blocked"> = {},
): RegressionReportV3 {
	const byId = new Map(evaluations.map((evaluation) => [evaluation.fixtureId, evaluation]));
	const passed: string[] = [];
	const failed: Array<{ fixtureId: string; reason: string }> = [];
	for (const fixture of fixtures) {
		const evaluation = byId.get(fixture.id);
		if (!evaluation) { failed.push({ fixtureId: fixture.id, reason: "missing evaluation" }); continue; }
		if (evaluation.decision !== "accept") { failed.push({ fixtureId: fixture.id, reason: `decision=${evaluation.decision}` }); continue; }
		if (baseline[fixture.id] === "accept" && evaluation.decision !== "accept") { failed.push({ fixtureId: fixture.id, reason: "regressed from accepted baseline" }); continue; }
		passed.push(fixture.id);
	}
	return {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		fixtureVersions: Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture.version])),
		passed,
		failed,
		status: failed.length === 0 ? "passed" : "failed",
	};
}
