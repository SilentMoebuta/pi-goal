import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GoalRuntimeTracker,
	deriveGoalProgress,
	displayWidth,
	outcomeSignature,
	renderCompactGoalProgress,
	renderGoalProgressLines,
} from "../extensions/progress-model";
import { createGoalStateV2, type GoalStateV2 } from "../extensions/state";

function goal(now = 1_000): GoalStateV2 {
	return createGoalStateV2({
		id: "goal-progress",
		objective: "Produce a supported answer for a long CJK objective: 研究结果需要真实可验证",
		criteria: [
			{ id: "c1", description: "Primary outcome exists", level: "blocking" },
			{ id: "c2", description: "Conflicting result is resolved", level: "blocking" },
		],
		constraints: [],
		taskKind: "research",
		execution: {
			preference: "auto",
			selected: "team",
			source: "auto",
			confidence: 0.75,
			reasons: ["Two independent workstreams were identified."],
			reassessOn: ["new_workstream", "conflict", "stalled"],
		},
		assurance: {
			reviewRequirement: "required",
			reviewStatus: "pending",
			independent: true,
			depth: "deep",
			source: "auto",
			reasons: ["A high-risk material claim requires review."],
			decidedAt: now,
		},
		now,
	});
}

function addEvidence(state: GoalStateV2, id: string, recordedAt: number): void {
	state.evidenceLedger.push({
		id,
		kind: "source",
		summary: "Authoritative primary source",
		locator: "https://example.test/primary",
		sourceKind: "primary",
		independenceKey: "example.test",
		origin: "tool",
		recordedAt,
		verification: "verified",
	});
}

describe("Goal progress projection", () => {
	it("separates pending, evidenced, verified, and blocked outcomes without inventing a percentage", () => {
		const state = goal();
		addEvidence(state, "e1", 1_100);
		state.criteria[0].evidenceRefs.push("e1");
		state.claims.push({ id: "claim-1", text: "Material claim", materiality: "material", risk: "ordinary", evidenceRefs: ["e1"] });
		state.completion.lastEvaluation = {
			decision: "revise",
			evaluatedAt: 1_200,
			criterionCoverage: [
				{ criterionId: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Supported." },
				{ criterionId: "c2", status: "blocked", evidenceRefs: [], reason: "Conflict remains." },
			],
			claimCoverage: [{ claimId: "claim-1", status: "insufficient", evidenceRefs: ["e1"], reason: "Needs evaluation." }],
			findings: [{ code: "conflict", subjectId: "c2", reason: "Conflict remains." }],
			advisories: ["A supporting detail could be clearer."],
			evaluator: { kind: "judge" },
			fingerprint: "fp",
		};
		state.progress = { outcomeRevision: 3, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 3 };
		state.updatedAt = 1_200;

		const progress = deriveGoalProgress(state, null, { now: 2_000, activeMs: 600 });
		assert.deepEqual(progress.outcomes.counts, { total: 3, pending: 0, evidenced: 1, verified: 1, blocked: 1 });
		assert.equal(progress.outcomes.revision, 3);
		assert.equal(progress.outcomes.blocking.open, 2);
		assert.equal(progress.evidence.independentSources, 1);
		assert.equal(progress.assurance.completionDecision, "revise");
		assert.equal(progress.assurance.evaluationFresh, true);
		assert.doesNotMatch(renderCompactGoalProgress(progress), /\d+%/);
		assert.doesNotMatch(renderGoalProgressLines(progress).join("\n"), /\d+%/);
	});

	it("does not project stale evaluator coverage as current verified progress", () => {
		const state = goal();
		addEvidence(state, "e1", 1_100);
		state.criteria[0].evidenceRefs.push("e1");
		state.completion.lastEvaluation = {
			decision: "accept", evaluatedAt: 1_100,
			criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Supported." }],
			claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "judge" }, fingerprint: null,
		};
		state.progress = { outcomeRevision: 2, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		state.updatedAt = 1_200;
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		assert.equal(progress.assurance.evaluationFresh, false);
		assert.equal(progress.outcomes.items.find((item) => item.id === "c1")?.status, "evidenced");
		assert.ok(progress.health.issues.some((issue) => issue.code === "reevaluation_needed"));
	});

	it("tracks parallel direct, specialist, and DAG activity by toolCallId", () => {
		const tracker = new GoalRuntimeTracker(100, 100);
		tracker.turnStarted(110);
		tracker.toolStarted("read-1", "read", { path: "src/one.ts" }, 120);
		tracker.toolStarted("role-1", "spawn_role", { role: "researcher" }, 125);
		assert.equal(tracker.snapshot().phase, "specialist");
		assert.equal(tracker.snapshot().tools.length, 2);

		tracker.toolEnded("read-1", { details: { status: "completed" } }, false, 130);
		assert.equal(tracker.snapshot().tools.length, 1);
		assert.equal(tracker.snapshot().label, "role researcher");

		tracker.toolEnded("role-1", { details: { status: "failed", error: "provider stopped" } }, false, 140);
		assert.equal(tracker.snapshot().phase, "thinking");
		assert.equal(tracker.snapshot().failures[0].status, "failed");
		assert.equal(tracker.snapshot().lastOutcomeDeltaAt, 100, "runtime activity cannot advance outcome time");
		tracker.turnEnded(145);
		tracker.turnStarted(146);
		assert.equal(tracker.snapshot().failures.length, 0, "a new turn clears prior runtime-only failures");

		tracker.toolStarted("dag-1", "dag_execute", { spec: { nodes: { A: {}, B: {}, "route::child": {} } } }, 150);
		tracker.toolUpdated("dag-1", "dag_execute", { details: { kind: "not-dag-progress", progress: { nodes: {} } } }, 151);
		assert.equal(tracker.snapshot().dag, null, "malformed streaming details are ignored");
		tracker.toolUpdated("dag-1", "dag_execute", {
			details: {
				kind: "dag-progress",
				progress: {
					dagId: "d1",
					scheduler: "ready",
					frontier: { running: ["A"], ready: ["route::child"], blocked: ["B"], settled: [], failed: [], critical: ["A"] },
					routeDecisions: { A: "branch" },
					generatedNodes: { "route::child": { id: "route::child", key: "child", parentId: "route" } },
					nodes: {
						A: { status: "running", deps: [] },
						B: { status: "queued", deps: ["A"] },
						"route::child": { status: "queued", deps: [] },
					},
				},
			},
		}, 160);
		const dag = tracker.snapshot().dag!;
		assert.deepEqual(dag.running, ["A"]);
		assert.deepEqual(dag.ready, ["route::child"]);
		assert.deepEqual(dag.blocked, ["B"]);
		assert.deepEqual(dag.critical, ["A"]);
		assert.deepEqual(dag.waitingOn, { B: ["A"] });
		assert.equal(dag.generated, 1);
		assert.equal(dag.routes, 1);
		assert.equal(tracker.snapshot().label, "DAG 1 running, 1 ready");
		const detailed = renderGoalProgressLines(deriveGoalProgress(goal(), tracker.snapshot(), { now: 165 })).join("\n");
		assert.match(detailed, /critical frontier: A/);
		assert.match(detailed, /waiting: B <- A/);
		tracker.turnEnded(170);
		assert.equal(tracker.snapshot().tools.length, 0, "turn settlement clears tools whose end event was lost");
		assert.equal(tracker.snapshot().dag?.active, false);
		assert.equal(tracker.snapshot().phase, "waiting");

		tracker.toolStarted("resume-1", "dag_resume", { checkpoint: "opaque" }, 180);
		tracker.toolUpdated("resume-1", "dag_resume", {
			details: {
				kind: "dag-progress",
				progress: {
					scheduler: "ready",
					frontier: { running: [], ready: ["A"], blocked: [], settled: [], failed: [] },
					generatedNodes: {},
					nodes: { A: { status: "queued", deps: [] } },
				},
			},
		}, 190);
		assert.equal(tracker.snapshot().dag?.generated, 0, "resume does not classify every restored node as generated");
	});

	it("isolates sequential and concurrent DAG snapshots by toolCallId", () => {
		const tracker = new GoalRuntimeTracker(0, 0);
		tracker.turnStarted(1);
		tracker.toolStarted("dag-a", "dag_execute", { spec: { nodes: { A: {} } } }, 2);
		tracker.toolUpdated("dag-a", "dag_execute", { details: { kind: "dag-progress", progress: {
			dagId: "A", scheduler: "ready", termination: "aborted",
			frontier: { running: ["A"], ready: [], settled: [], failed: [] },
			routeDecisions: { A: "retry" }, nodes: { A: { status: "running", route: "retry" } },
		} } }, 3);
		tracker.toolEnded("dag-a", { details: {
			status: "aborted", termination: "aborted", metrics: { totalNodes: 1, failed: 1, routeCount: 1 },
			nodeStates: { A: { status: "failed" } },
		} }, false, 4);

		tracker.toolStarted("dag-b", "dag_execute", { spec: { nodes: { B: {} } } }, 5);
		tracker.toolUpdated("dag-b", "dag_execute", { details: { kind: "dag-progress", progress: {
			scheduler: "ready",
			frontier: { running: ["B"], ready: [], settled: [], failed: [] },
			routeDecisions: {}, nodes: { B: { status: "running" } },
		} } }, 6);
		assert.equal(tracker.snapshot().dag?.toolCallId, "dag-b");
		assert.equal(tracker.snapshot().dag?.termination, undefined, "a new DAG cannot inherit the prior termination");
		assert.equal(tracker.snapshot().dag?.routes, 0, "a new DAG cannot inherit prior route decisions");

		tracker.toolStarted("dag-c", "dag_execute", { spec: { nodes: { C: {} } } }, 7);
		tracker.toolUpdated("dag-c", "dag_execute", { details: { kind: "dag-progress", progress: {
			scheduler: "ready",
			frontier: { running: [], ready: ["C"], settled: [], failed: [] },
			nodes: { C: { status: "queued" } },
		} } }, 8);
		assert.equal(tracker.snapshot().dags.length, 2);
		assert.match(tracker.snapshot().label, /2 DAGs/);
		const concurrent = deriveGoalProgress(goal(), tracker.snapshot(), { now: 8 });
		const concurrentLines = renderGoalProgressLines(concurrent).join("\n");
		assert.match(concurrentLines, /dag-b:/);
		assert.match(concurrentLines, /dag-c:/);
		tracker.toolEnded("dag-b", { details: { status: "completed", termination: "all_terminal", nodeStates: { B: { status: "completed" } } } }, false, 9);
		assert.deepEqual(tracker.snapshot().dags.map((dag) => dag.toolCallId), ["dag-c"], "ending one DAG keeps the other frontier visible");
	});

	it("treats partial DAG results as attention and never shows terminal queued nodes as ready", () => {
		const tracker = new GoalRuntimeTracker(1_000, 1_000);
		tracker.turnStarted(1_010);
		tracker.toolStarted("resume", "dag_resume", { checkpoint: "opaque" }, 1_020);
		tracker.toolEnded("resume", { details: {
			status: "partial", termination: "all_terminal",
			metrics: { totalNodes: 2, completed: 1, failed: 1, skipped: 0 },
			nodeStates: { root: { status: "completed" }, child: { status: "failed" } },
		} }, false, 1_030);
		const snapshot = tracker.snapshot();
		assert.deepEqual(snapshot.dag?.ready, []);
		assert.deepEqual(snapshot.dag?.running, []);
		assert.equal(snapshot.dag?.failed, 1);
		const progress = deriveGoalProgress(goal(), snapshot, { now: 1_040 });
		assert.equal(progress.health.state, "attention");
		assert.ok(progress.health.issues.some((issue) => issue.code === "tool_partial"));
		assert.match(renderGoalProgressLines(progress).join("\n"), /1 failed/);

		tracker.turnEnded(1_040);
		tracker.turnStarted(1_050);
		tracker.toolStarted("read", "read", { path: "recovery" }, 1_060);
		tracker.toolEnded("read", { details: { status: "completed" } }, false, 1_070);
		const recovered = deriveGoalProgress(goal(), tracker.snapshot(), { now: 1_080 });
		assert.equal(recovered.activity.dags.length, 0);
		assert.equal(recovered.health.state, "healthy", "a prior turn's terminal DAG cannot pollute recovered health");
	});

	it("does not treat a concurrent same-name tool success as recovery from another call's failure", () => {
		const tracker = new GoalRuntimeTracker(0, 0);
		tracker.turnStarted(1);
		tracker.toolStarted("read-a", "read", { path: "a" }, 2);
		tracker.toolStarted("read-b", "read", { path: "b" }, 3);
		tracker.toolEnded("read-a", { details: { status: "failed", error: "a failed" } }, false, 4);
		tracker.toolEnded("read-b", { details: { status: "completed" } }, false, 5);
		assert.equal(tracker.snapshot().failures.length, 1);
		assert.match(tracker.snapshot().failures[0].message, /a failed/);
	});

	it("clears a stale tool when a new turn starts without the prior end event", () => {
		const tracker = new GoalRuntimeTracker(0, 0);
		tracker.turnStarted(1);
		tracker.toolStarted("stale", "read", { path: "old" }, 2);
		tracker.turnStarted(3);
		assert.equal(tracker.snapshot().tools.length, 0);
		assert.equal(tracker.snapshot().phase, "thinking");
	});

	it("does not let a transient final-turn tool failure make an accepted goal unhealthy", () => {
		const state = goal();
		state.status = "complete";
		state.endedAt = 1_200;
		state.completion.lastEvaluation = {
			decision: "accept", evaluatedAt: 1_200,
			criterionCoverage: [], claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "judge" }, fingerprint: null,
		};
		state.progress = { outcomeRevision: 1, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		const tracker = new GoalRuntimeTracker(1_000, 1_000);
		tracker.turnStarted(1_010);
		tracker.toolStarted("read", "read", { path: "temporary" }, 1_020);
		tracker.toolEnded("read", { details: { status: "failed", error: "temporary" } }, false, 1_030);
		tracker.turnEnded(1_040);
		const progress = deriveGoalProgress(state, tracker.snapshot(), { now: 1_300 });
		assert.equal(progress.health.state, "healthy");
		assert.ok(!progress.health.issues.some((issue) => issue.code.startsWith("tool_")));
	});

	it("keeps advisory outcomes out of the compact completion gate", () => {
		const state = goal();
		state.criteria[1].level = "advisory";
		state.criteria.push({ id: "c3", description: "Optional polish", level: "advisory", evidenceRefs: [], evidence: [] });
		addEvidence(state, "e1", 1_100);
		state.criteria[0].evidenceRefs = ["e1"];
		state.completion.lastEvaluation = {
			decision: "accept", evaluatedAt: 1_200,
			criterionCoverage: [
				{ criterionId: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Covered." },
				{ criterionId: "c2", status: "unsatisfied", evidenceRefs: [], reason: "Optional." },
				{ criterionId: "c3", status: "unsatisfied", evidenceRefs: [], reason: "Optional." },
			],
			claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "judge" }, fingerprint: null,
		};
		state.progress = { outcomeRevision: 1, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		const compact = renderCompactGoalProgress(progress);
		assert.match(compact, /1 blocking verified/);
		assert.doesNotMatch(compact, /2 open/);
		assert.match(renderGoalProgressLines(progress).join("\n"), /advisory criterion c2/);
	});

	it("does not count constraints as open blockers after a fresh accept completion (UX-P2-01)", () => {
		const state = goal();
		state.constraints = ["Only modify outputs/", "Keep changes idempotent"];
		addEvidence(state, "e1", 1_100);
		state.criteria[0].evidenceRefs.push("e1");
		state.criteria[1].evidenceRefs.push("e1");
		state.status = "complete";
		state.completion.lastEvaluation = {
			decision: "accept", evaluatedAt: 1_200,
			criterionCoverage: [
				{ criterionId: "c1", status: "satisfied", evidenceRefs: ["e1"], reason: "Covered." },
				{ criterionId: "c2", status: "satisfied", evidenceRefs: ["e1"], reason: "Covered." },
			],
			claimCoverage: [], findings: [], advisories: [], evaluator: { kind: "judge" }, fingerprint: null,
		};
		state.progress = { outcomeRevision: 1, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		const constraint = progress.outcomes.items.find((item) => item.id === "$constraint:0");
		assert.ok(constraint, "constraint must be projected");
		assert.equal(constraint!.status, "verified", "fresh accept must mark un-failed constraints verified");
		assert.equal(progress.outcomes.blocking.open, 0, "a complete goal must not report open blockers");
		const rendered = renderCompactGoalProgress(progress);
		assert.doesNotMatch(rendered, /open/);
	});

	it("keeps a constraint with a blocking finding blocked even after completion (UX-P2-01)", () => {
		const state = goal();
		state.constraints = ["Only modify outputs/"];
		state.status = "complete";
		state.completion.lastEvaluation = {
			decision: "revise", evaluatedAt: 1_200,
			criterionCoverage: [
				{ criterionId: "c1", status: "satisfied", evidenceRefs: [], reason: "Covered." },
				{ criterionId: "c2", status: "satisfied", evidenceRefs: [], reason: "Covered." },
				{ criterionId: "$constraint:0", status: "unsatisfied", evidenceRefs: [], reason: "No confirmation." },
			],
			claimCoverage: [],
			findings: [{ code: "blocking_requirement_unsatisfied", subjectId: "$constraint:0", reason: "Constraint not verified." }],
			advisories: [], evaluator: { kind: "judge" }, fingerprint: "fp",
		};
		state.progress = { outcomeRevision: 1, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		assert.equal(progress.outcomes.items.find((item) => item.id === "$constraint:0")?.status, "blocked");
		assert.equal(progress.outcomes.blocking.open, 1);
	});

	it("keeps constraints pending in non-terminal states without inventing verified (UX-P2-01)", () => {
		const state = goal();
		state.constraints = ["Only modify outputs/"];
		state.status = "active";
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		assert.equal(progress.outcomes.items.find((item) => item.id === "$constraint:0")?.status, "pending");
		assert.equal(progress.outcomes.blocking.open, 3, "active goal still counts unverified blocking outcomes");
	});

	it("projects explicit constraints as blocking outcomes and renders their subjects", () => {
		const state = goal();
		state.constraints = ["Do not publish the result"];
		state.completion.lastEvaluation = {
			decision: "revise", evaluatedAt: 1_200,
			criterionCoverage: [
				{ criterionId: "c1", status: "satisfied", evidenceRefs: [], reason: "Covered." },
				{ criterionId: "c2", status: "satisfied", evidenceRefs: [], reason: "Covered." },
				{ criterionId: "$constraint:0", status: "unsatisfied", evidenceRefs: [], reason: "No confirmation." },
			],
			claimCoverage: [],
			findings: [{ code: "blocking_requirement_unsatisfied", subjectId: "$constraint:0", reason: "Constraint not verified." }],
			advisories: [], evaluator: { kind: "judge" }, fingerprint: "fp",
		};
		state.progress = { outcomeRevision: 1, lastOutcomeDeltaAt: 1_200, lastEvaluatedOutcomeRevision: 1 };
		const progress = deriveGoalProgress(state, null, { now: 1_300 });
		assert.equal(progress.outcomes.items.find((item) => item.id === "$constraint:0")?.status, "blocked");
		assert.equal(progress.outcomes.blocking.open, 1);
		const rendered = renderGoalProgressLines(progress).join("\n");
		assert.match(rendered, /blocking constraint \$constraint:0/);
		assert.match(rendered, /BLOCK blocking_requirement_unsatisfied \[\$constraint:0\]/);
	});

	it("keeps outcome signatures stable for resource accounting and changes them for semantic evidence", () => {
		const state = goal();
		const before = outcomeSignature(state);
		state.tokensUsed = 999;
		state.timeUsedMs = 5_000;
		state.updatedAt = 6_000;
		assert.equal(outcomeSignature(state), before);
		addEvidence(state, "e2", 6_000);
		assert.notEqual(outcomeSignature(state), before);
	});

	it("bounds compact and detailed CJK output by terminal display width", () => {
		const state = goal();
		const tracker = new GoalRuntimeTracker(1_000, 1_000);
		tracker.turnStarted(1_100);
		tracker.toolStarted("read", "read", { path: "非常长的中文路径/结果文件.ts" }, 1_200);
		const progress = deriveGoalProgress(state, tracker.snapshot(), { now: 2_000 });
		assert.ok(displayWidth(renderCompactGoalProgress(progress, 32)) <= 32);
		for (const line of renderGoalProgressLines(progress, 36)) assert.ok(displayWidth(line) <= 36, line);
	});
});
