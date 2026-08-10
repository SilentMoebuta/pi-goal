import { createGoalError, type GoalErrorCode, type GoalRecoveryAction } from "./goal-contract-v3";

export type FaultKindV3 = "provider_abort" | "rate_limit" | "worker_crash" | "duplicate_resume" | "stale_artifact" | "approval_wait" | "side_effect_replay";

export interface FaultExpectationV3 { errorCode?: GoalErrorCode; recovery: GoalRecoveryAction | "idempotent_replay" | "stale"; }

export const FAULT_EXPECTATIONS_V3: Record<FaultKindV3, FaultExpectationV3> = {
	provider_abort: { errorCode: "provider_abort", recovery: "retry_attempt" },
	rate_limit: { errorCode: "rate_limit", recovery: "retry_attempt" },
	worker_crash: { errorCode: "worker_crash", recovery: "retry_attempt" },
	duplicate_resume: { recovery: "idempotent_replay" },
	stale_artifact: { errorCode: "stale_artifact", recovery: "stale" },
	approval_wait: { errorCode: "approval_required", recovery: "wait_approval" },
	side_effect_replay: { recovery: "idempotent_replay" },
};

export function injectedFaultError(kind: FaultKindV3): Error & { goalError: ReturnType<typeof createGoalError> } {
	const mapping: Record<FaultKindV3, { code: GoalErrorCode; message: string }> = {
		provider_abort: { code: "provider_abort", message: "injected provider abort" },
		rate_limit: { code: "rate_limit", message: "injected 429 rate limit" },
		worker_crash: { code: "worker_crash", message: "injected worker crash" },
		duplicate_resume: { code: "internal", message: "injected duplicate resume" },
		stale_artifact: { code: "stale_artifact", message: "injected stale artifact" },
		approval_wait: { code: "approval_required", message: "injected approval wait" },
		side_effect_replay: { code: "internal", message: "injected side-effect replay" },
	};
	const item = mapping[kind];
	const error = new Error(item.message) as Error & { goalError: ReturnType<typeof createGoalError> };
	error.goalError = createGoalError(item.code, item.message);
	return error;
}

/** Fail the first invocation only; callers can then verify retry/recovery behavior. */
export class FaultInjectorV3 {
	private consumed = false;
	constructor(readonly kind: FaultKindV3) {}
	async run<T>(operation: () => Promise<T>): Promise<T> {
		if (!this.consumed) { this.consumed = true; throw injectedFaultError(this.kind); }
		return operation();
	}
	get injected(): boolean { return this.consumed; }
}

export interface FaultScenarioResultV3 {
	kind: FaultKindV3;
	firstErrorCode: GoalErrorCode | null;
	secondRunSucceeded: boolean;
	expectation: FaultExpectationV3;
}

export async function runFaultScenarioV3<T>(kind: FaultKindV3, operation: () => Promise<T>): Promise<FaultScenarioResultV3> {
	const injector = new FaultInjectorV3(kind);
	let firstErrorCode: GoalErrorCode | null = null;
	try { await injector.run(operation); }
	catch (error) { firstErrorCode = (error as { goalError?: { code?: GoalErrorCode } }).goalError?.code ?? null; }
	let secondRunSucceeded = false;
	try { await injector.run(operation); secondRunSucceeded = true; }
	catch { /* scenario reports the failed retry */ }
	return { kind, firstErrorCode, secondRunSucceeded, expectation: FAULT_EXPECTATIONS_V3[kind] };
}
