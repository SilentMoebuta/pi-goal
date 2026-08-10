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
