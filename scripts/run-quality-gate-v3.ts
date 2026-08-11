#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

import {
	buildRunQualityRegressionReportV3,
	evaluateBenchmarkOutput,
	evaluateRunQualityV3,
	type BenchmarkFixtureV3,
	type DeterministicCheckV3,
	type RunQualityGatePolicyV3,
} from "../extensions/evaluation-v3";
import {
	calculateRuntimeMetrics,
	traceToOfflineDataset,
	type OTelTraceSpanV3,
	type RuntimeMetricsInputV3,
} from "../extensions/observability-v3";

interface GateInputV1 {
	schemaVersion: 1;
	fixture: BenchmarkFixtureV3;
	eventsPath: string;
	tracePath: string;
	resultPath: string;
	deterministicChecks: DeterministicCheckV3[];
	artifactChecks: RuntimeMetricsInputV3["artifactChecks"];
	humanAccepted: boolean | null;
	humanInterventions?: number;
	recoverySucceeded?: boolean | null;
	sideEffectKeys?: string[];
	policy: RunQualityGatePolicyV3;
	evaluatedAt?: number;
}

function fail(message: string): never {
	throw new Error(message);
}

function parseArgs(argv: string[]): { inputPath: string; outputPath: string } {
	if (argv.length !== 4 || argv[0] !== "--input" || argv[2] !== "--output") {
		fail("usage: run-quality-gate-v3 --input <gate-input.json> --output <gate-result.json>");
	}
	return { inputPath: path.resolve(argv[1]), outputPath: path.resolve(argv[3]) };
}

function readJson(file: string): unknown {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file: string): Array<Record<string, unknown>> {
	const content = fs.readFileSync(file, "utf8").trim();
	if (!content) return [];
	return content.split(/\r?\n/).map((line, index) => {
		try { return JSON.parse(line) as Record<string, unknown>; }
		catch (error) { fail(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
	});
}

function resolveEvidencePath(inputPath: string, value: string): string {
	return path.resolve(path.dirname(inputPath), value);
}

function eventPayload(event: Record<string, unknown>): Record<string, unknown> {
	return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
		? event.payload as Record<string, unknown>
		: event;
}

function aggregateCost(events: Array<Record<string, unknown>>): number | undefined {
	let observed = false;
	let total = 0;
	for (const event of events) {
		if (event.type !== "llm_response") continue;
		const payload = eventPayload(event);
		const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
		const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
		if (typeof cost.total === "number" && Number.isFinite(cost.total)) {
			observed = true;
			total += cost.total;
		}
	}
	return observed ? total : undefined;
}

function resultHasV3Shape(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	const lineage = result.lineage && typeof result.lineage === "object" ? result.lineage as Record<string, unknown> : {};
	return result.schemaVersion === 1
		&& result.contractVersion === 3
		&& ["goalDefinitionId", "revisionId", "runId", "attemptId"].every((key) => typeof lineage[key] === "string" && Boolean((lineage[key] as string).trim()));
}

function deriveRecoveryAttempts(spans: OTelTraceSpanV3[]): number {
	const attempts = new Set(spans.map((span) => span.attributes["goal.attempt_id"]).filter((value): value is string => typeof value === "string"));
	return Math.max(0, attempts.size - 1);
}

function deriveSideEffectKeys(events: Array<Record<string, unknown>>): string[] {
	const keys: string[] = [];
	for (const event of events) {
		if (event.type !== "goal.side_effect_settled") continue;
		const payload = eventPayload(event);
		const entry = payload.entry && typeof payload.entry === "object" ? payload.entry as Record<string, unknown> : {};
		if (entry.status === "committed" && typeof entry.id === "string") keys.push(entry.id);
	}
	return keys;
}

const { inputPath, outputPath } = parseArgs(process.argv.slice(2));
const raw = readJson(inputPath);
if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("gate input must be an object");
const input = raw as GateInputV1;
if (input.schemaVersion !== 1) fail("gate input schemaVersion must be 1");
if (!Array.isArray(input.deterministicChecks) || input.deterministicChecks.length === 0) fail("at least one deterministic check is required");
if (!Array.isArray(input.artifactChecks) || input.artifactChecks.length === 0) fail("at least one artifact check is required");

const events = readJsonl(resolveEvidencePath(inputPath, input.eventsPath));
const spans = readJsonl(resolveEvidencePath(inputPath, input.tracePath)) as unknown as OTelTraceSpanV3[];
const result = readJson(resolveEvidencePath(inputPath, input.resultPath));
if (!resultHasV3Shape(result)) fail("result does not have the required Goal Contract V3 shape");
const trajectory = traceToOfflineDataset(spans, { sampleId: () => input.fixture.id });
if (trajectory.length !== 1) fail(`expected one trace, found ${trajectory.length}`);
const finalOutput = await evaluateBenchmarkOutput(input.fixture, result, input.deterministicChecks.map((check) => () => check), {
	evaluatorId: "run-quality-gate-v3",
	evaluatorVersion: "1",
	evaluatedAt: input.evaluatedAt,
});
const recoveryAttempts = deriveRecoveryAttempts(spans);
const metrics = calculateRuntimeMetrics({
	status: result.status === "complete" ? "complete" : "failed",
	spans,
	schemaValid: true,
	artifactChecks: input.artifactChecks,
	humanAccepted: input.humanAccepted,
	...(input.humanInterventions === undefined ? {} : { humanInterventions: input.humanInterventions }),
	recoveryAttempts,
	recoverySucceeded: input.recoverySucceeded ?? (recoveryAttempts > 0 ? result.status === "complete" : null),
	sideEffectKeys: input.sideEffectKeys ?? deriveSideEffectKeys(events),
	costUsd: aggregateCost(events),
});
const evaluation = evaluateRunQualityV3({
	fixtureId: input.fixture.id,
	finalOutput,
	trajectory: trajectory[0],
	metrics,
	policy: input.policy,
	evaluatedAt: input.evaluatedAt,
});
const regression = buildRunQualityRegressionReportV3([
	{ fixtureId: input.fixture.id, fixtureVersion: input.fixture.version, requiredDimensions: input.policy.requiredDimensions },
], [evaluation]);
const output = {
	schemaVersion: 1,
	fixture: { id: input.fixture.id, version: input.fixture.version, kind: input.fixture.kind },
	trajectory: trajectory[0],
	metrics,
	evaluation,
	regression,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ outputPath, decision: evaluation.decision, regression: regression.status }) + "\n");
if (regression.status !== "passed") process.exitCode = 1;
