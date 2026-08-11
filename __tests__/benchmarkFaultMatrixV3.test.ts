import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultBenchmarkFixtures } from "../extensions/benchmark-fixtures-v3";
import { DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3, runBenchmarkFaultScenarioV3 } from "../extensions/benchmark-fault-matrix-v3";

describe("cross-project benchmark fault matrix V3", () => {
	it("covers every supported task family with typed recovery and artifact verification", async () => {
		const fixtures = defaultBenchmarkFixtures();
		assert.deepEqual(
			DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3.map((scenario) => scenario.fixtureKind),
			fixtures.map((fixture) => fixture.kind),
		);
		for (const scenario of DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3) {
			const fixture = fixtures.find((candidate) => candidate.kind === scenario.fixtureKind);
			assert.ok(fixture);
			let attempts = 0;
			const result = await runBenchmarkFaultScenarioV3(
				scenario,
				async () => ({ fixtureId: fixture.id, artifact: `${fixture.kind}:verified`, attempt: ++attempts }),
				async ({ retry }) => ({ recovery: scenario.recovery, output: await retry() }),
				(output) => output.fixtureId === fixture.id && output.artifact === `${fixture.kind}:verified`,
			);
			assert.equal(result.firstErrorCode, scenario.expectedErrorCode, scenario.id);
			assert.equal(result.actualRecovery, scenario.recovery, scenario.id);
			assert.equal(result.recovered, true, scenario.id);
			assert.equal(result.artifactVerified, true, scenario.id);
			assert.equal(result.output?.attempt, 1, "the injected failure must not consume the operation");
		}
	});

	it("keeps a failed recovered artifact visible instead of accepting the scenario", async () => {
		const scenario = DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3[0];
		const result = await runBenchmarkFaultScenarioV3(
			scenario,
			async () => ({ artifact: "wrong" }),
			async ({ retry }) => ({ recovery: scenario.recovery, output: await retry() }),
			() => false,
		);
		assert.equal(result.recovered, true);
		assert.equal(result.artifactVerified, false);
	});

	it("does not accept an adapter that reports the wrong recovery transition", async () => {
		const scenario = DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3[3];
		const result = await runBenchmarkFaultScenarioV3(
			scenario,
			async () => ({ artifact: "verified" }),
			async ({ retry }) => ({ recovery: "retry_attempt", output: await retry() }),
			() => true,
		);
		assert.equal(result.actualRecovery, "retry_attempt");
		assert.equal(result.recovered, false);
	});
});
