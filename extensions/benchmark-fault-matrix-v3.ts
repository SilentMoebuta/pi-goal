import type { GoalErrorCode } from "./goal-contract-v3";
import type { BenchmarkKindV3 } from "./evaluation-v3";
import { FaultInjectorV3, type FaultKindV3 } from "./fault-injection-v3";

/**
 * A project-neutral fault exercise for one benchmark family. Profiles choose
 * the scenario mapping; the runtime only records the typed failure, recovery
 * path, and whether the recovered output still passes the profile verifier.
 */
export type BenchmarkRecoveryV3 =
	| "retry_attempt"
	| "wait_approval"
	| "stale_revision"
	| "idempotent_replay";

export interface BenchmarkFaultScenarioV3 {
	id: string;
	fixtureKind: BenchmarkKindV3;
	faultKind: FaultKindV3;
	recovery: BenchmarkRecoveryV3;
	expectedErrorCode: GoalErrorCode;
}

/** Default coverage is deliberately one scenario per supported task family. */
export const DEFAULT_BENCHMARK_FAULT_SCENARIOS_V3: readonly BenchmarkFaultScenarioV3[] = [
	{ id: "coding-provider-abort", fixtureKind: "coding", faultKind: "provider_abort", recovery: "retry_attempt", expectedErrorCode: "provider_abort" },
	{ id: "research-rate-limit", fixtureKind: "research", faultKind: "rate_limit", recovery: "retry_attempt", expectedErrorCode: "rate_limit" },
	{ id: "document-stale-artifact", fixtureKind: "document", faultKind: "stale_artifact", recovery: "stale_revision", expectedErrorCode: "stale_artifact" },
	{ id: "business-approval-wait", fixtureKind: "business", faultKind: "approval_wait", recovery: "wait_approval", expectedErrorCode: "approval_required" },
];

export interface BenchmarkFaultResultV3<TOutput> {
	scenario: BenchmarkFaultScenarioV3;
	firstErrorCode: GoalErrorCode | null;
	actualRecovery: BenchmarkRecoveryV3 | null;
	recovered: boolean;
	artifactVerified: boolean;
	output: TOutput | undefined;
}

export interface BenchmarkRecoveryOutcomeV3<TOutput> {
	recovery: BenchmarkRecoveryV3;
	output: TOutput;
}

/**
 * Injects one typed failure, executes the normal recovery attempt, and runs
 * the caller's deterministic artifact verifier on the recovered output.
 * Provider chaos is intentionally not implied: the injector is a local,
 * deterministic contract test and must be reported as such by callers.
 */
export async function runBenchmarkFaultScenarioV3<TOutput>(
	scenario: BenchmarkFaultScenarioV3,
	operation: () => Promise<TOutput>,
	recover: (context: {
		error: unknown;
		retry: () => Promise<TOutput>;
	}) => Promise<BenchmarkRecoveryOutcomeV3<TOutput>>,
	verifyArtifact: (output: TOutput) => boolean | Promise<boolean>,
): Promise<BenchmarkFaultResultV3<TOutput>> {
	const injector = new FaultInjectorV3(scenario.faultKind);
	let firstErrorCode: GoalErrorCode | null = null;
	let injectedError: unknown;
	try {
		await injector.run(operation);
	} catch (error) {
		injectedError = error;
		firstErrorCode = (error as { goalError?: { code?: GoalErrorCode } }).goalError?.code ?? null;
	}
	let outcome: BenchmarkRecoveryOutcomeV3<TOutput> | undefined;
	try {
		outcome = await recover({ error: injectedError, retry: () => injector.run(operation) });
	} catch {
		return { scenario, firstErrorCode, actualRecovery: null, recovered: false, artifactVerified: false, output: undefined };
	}
	return {
		scenario,
		firstErrorCode,
		actualRecovery: outcome.recovery,
		recovered: firstErrorCode === scenario.expectedErrorCode && outcome.recovery === scenario.recovery,
		artifactVerified: await verifyArtifact(outcome.output),
		output: outcome.output,
	};
}
