import {
	GOAL_CONTRACT_VERSION,
	createInitialRuntimeMetadataV3,
	type GoalAttemptStatus,
	type GoalAttemptV3,
	type GoalCompletionIntegrityV3,
	type GoalDefinitionV3,
	type GoalLineageV3,
	type GoalRevisionV3,
	type GoalRunStatus,
	type GoalRunV3,
	type GoalRuntimeMetadataV3,
} from "./goal-contract-v3";
import type { CompletionFinding, GoalStateV2 } from "./state";

export interface GoalPublicViewV3 {
	schemaVersion: typeof GOAL_CONTRACT_VERSION;
	contractVersion: typeof GOAL_CONTRACT_VERSION;
	lineage: GoalLineageV3;
	definition: GoalDefinitionV3;
	revision: GoalRevisionV3;
	run: GoalRunV3;
	attempt: GoalAttemptV3;
	integrity: GoalCompletionIntegrityV3;
	outcome: {
		status: GoalStateV2["status"];
		summary: string | null;
		decision: "accept" | "revise" | "blocked" | null;
		findings: CompletionFinding[];
	};
}

export function runtimeMetadataForGoalV2(goal: GoalStateV2): GoalRuntimeMetadataV3 {
	return goal.runtime ?? createInitialRuntimeMetadataV3({
		goalId: goal.id,
		entrypoint: goal.headless ? "headless" : "interactive",
	});
}

export function definitionFromGoalV2(goal: GoalStateV2): GoalDefinitionV3 {
	const reviewVerification: GoalDefinitionV3["verification"] = goal.assurance.reviewRequirement === "none"
		? []
		: [{
			id: "goal-v2-review",
			kind: "reviewer",
			required: goal.assurance.reviewRequirement === "required",
			description: "Goal V2 independent review policy.",
		}];
	const verification: GoalDefinitionV3["verification"] = [
		...reviewVerification,
		...(goal.blueprint?.verification?.command ? [{
			id: "goal-v2-verify-command",
			kind: "deterministic" as const,
			required: true,
			description: "The configured Goal V2 verification command must pass.",
		}] : []),
	];
	return {
		contractVersion: GOAL_CONTRACT_VERSION,
		id: runtimeMetadataForGoalV2(goal).goalDefinitionId,
		objective: goal.objective,
		criteria: goal.criteria.map((criterion) => ({
			id: criterion.id,
			description: criterion.description,
			level: criterion.level,
		})),
		constraints: [...goal.constraints],
		verification,
		risk: {
			level: goal.assurance.depth === "deep" ? "high" : goal.assurance.depth === "standard" ? "medium" : "low",
			requiredApprovals: [],
		},
		budget: {
			...(goal.tokenBudget === null ? {} : { tokens: goal.tokenBudget }),
		},
		taskKind: goal.taskKind,
		createdAt: goal.createdAt,
	};
}

export function revisionFromGoalV2(goal: GoalStateV2): GoalRevisionV3 {
	const runtime = runtimeMetadataForGoalV2(goal);
	const definition = definitionFromGoalV2(goal);
	return {
		id: runtime.revisionId,
		goalDefinitionId: runtime.goalDefinitionId,
		number: runtime.revisionNumber,
		previousRevisionId: runtime.revisionNumber > 1 ? `${runtime.goalDefinitionId}:revision:${runtime.revisionNumber - 1}` : null,
		source: goal.migration ? "migration" : "user",
		reason: goal.migration ? "Migrated from Goal V1/V2 state." : "Goal V2 compatibility revision.",
		definition,
		createdAt: goal.createdAt,
	};
}

export function runFromGoalV2(goal: GoalStateV2): GoalRunV3 {
	const runtime = runtimeMetadataForGoalV2(goal);
	return {
		id: runtime.runId,
		goalDefinitionId: runtime.goalDefinitionId,
		revisionId: runtime.revisionId,
		entrypoint: runtime.entrypoint,
		status: runStatus(goal),
		attemptIds: [runtime.attemptId],
		currentAttemptId: runtime.attemptId,
		parentRunId: runtime.parentRunId,
		previousRunId: runtime.previousRunId,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		endedAt: goal.endedAt,
	};
}

export function attemptFromGoalV2(goal: GoalStateV2): GoalAttemptV3 {
	const runtime = runtimeMetadataForGoalV2(goal);
	return {
		id: runtime.attemptId,
		runId: runtime.runId,
		revisionId: runtime.revisionId,
		number: runtime.attemptNumber,
		previousAttemptId: runtime.previousAttemptId,
		status: attemptStatus(goal),
		idempotencyKey: runtime.attemptId,
		startedAt: goal.headless?.startedAt ?? goal.createdAt,
		endedAt: goal.endedAt,
	};
}

export function buildGoalPublicViewV3(goal: GoalStateV2, integrity?: GoalCompletionIntegrityV3): GoalPublicViewV3 {
	const runtime = runtimeMetadataForGoalV2(goal);
	const resolvedIntegrity: GoalCompletionIntegrityV3 = integrity ?? {
		status: goal.completionTransaction ? "unchecked" : "not_applicable",
		checkedAt: null,
		staleArtifacts: [],
	};
	return {
		schemaVersion: GOAL_CONTRACT_VERSION,
		contractVersion: GOAL_CONTRACT_VERSION,
		lineage: {
			goalDefinitionId: runtime.goalDefinitionId,
			revisionId: runtime.revisionId,
			runId: runtime.runId,
			attemptId: runtime.attemptId,
		},
		definition: definitionFromGoalV2(goal),
		revision: revisionFromGoalV2(goal),
		run: runFromGoalV2(goal),
		attempt: attemptFromGoalV2(goal),
		integrity: resolvedIntegrity,
		outcome: {
			status: goal.status,
			summary: goal.completion.summary,
			decision: resolvedIntegrity.status === "stale" ? null : goal.completion.lastEvaluation?.decision ?? null,
			findings: goal.completion.lastEvaluation?.findings ?? [],
		},
	};
}

function runStatus(goal: GoalStateV2): GoalRunStatus {
	switch (goal.status) {
		case "active": return "active";
		case "paused": return "paused";
		case "budget_limited": return "paused";
		case "usage_limited": return "retrying";
		case "blocked": return "failed";
		case "complete": return "completed";
		case "cancelled": return "cancelled";
		case "unmet": return "unmet";
	}
}

function attemptStatus(goal: GoalStateV2): GoalAttemptStatus {
	switch (goal.status) {
		case "active":
		case "paused":
		case "budget_limited":
		case "usage_limited":
			return "active";
		case "complete": return "succeeded";
		case "cancelled": return "cancelled";
		case "blocked":
		case "unmet":
			return "failed";
	}
}
