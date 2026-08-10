import type { BenchmarkFixtureV3 } from "./evaluation-v3";

/** Small, project-neutral smoke fixtures for the four supported task families. */
export const DEFAULT_BENCHMARK_FIXTURES_V3: readonly BenchmarkFixtureV3[] = [
	{ schemaVersion: 1, id: "coding:artifact-and-test", version: "1", kind: "coding", objective: "Produce a tested code change", input: { repository: "fixture", task: "change one function" }, expected: { criteria: ["artifact", "tests"], requiredArtifacts: ["patch"] } },
	{ schemaVersion: 1, id: "research:cited-brief", version: "1", kind: "research", objective: "Produce a source-grounded brief", input: { question: "What changed?", sources: ["fixture-source"] }, expected: { criteria: ["claims", "citations"], requiredArtifacts: ["brief"] } },
	{ schemaVersion: 1, id: "document:structured-edit", version: "1", kind: "document", objective: "Produce a structured document revision", input: { document: "fixture.md", finding: "clarify section" }, expected: { criteria: ["structure", "finding-coverage"], requiredArtifacts: ["document"] } },
	{ schemaVersion: 1, id: "business:approval-handoff", version: "1", kind: "business", objective: "Complete an approval handoff", input: { request: "fixture-request", approver: "fixture-approver" }, expected: { criteria: ["decision", "audit"], requiredArtifacts: ["decision-record"] } },
];

export function defaultBenchmarkFixtures(): BenchmarkFixtureV3[] {
	return DEFAULT_BENCHMARK_FIXTURES_V3.map((fixture) => structuredClone(fixture));
}
