import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GoalTraceCollectorV3, calculateRuntimeMetrics, goalEventTraceAttributes, lastTraceEventSequenceV3, traceToOfflineDataset } from "../extensions/observability-v3";
import { createGoalEventV3 } from "../extensions/runtime-v3";
import { FAULT_EXPECTATIONS_V3, FaultInjectorV3, injectedFaultError, runFaultScenarioV3 } from "../extensions/fault-injection-v3";

describe("runtime observability and fault injection V3", () => {
	it("emits parent-aware OTel-compatible spans and an offline trajectory", () => {
		let now = 100;
		const collector = new GoalTraceCollectorV3("trace-1", () => now);
		const parent = collector.startSpan({ name: "goal.run", attributes: { "agent.id": "main" } });
		now = 120;
		const child = collector.startSpan({ name: "tool.execute", parentSpanId: parent.spanId, kind: "client" });
		now = 140;
		child.end("ok");
		parent.end("ok");
		const dataset = traceToOfflineDataset(collector.getSpans(), { redact: (value) => value.replace("main", "anon") });
		assert.equal(collector.getSpans()[1].parentSpanId, parent.spanId);
		assert.equal(dataset[0].durationMs, 40);
		assert.equal(dataset[0].attributes["agent.id"], "anon");
		assert.equal(dataset[0].steps.length, 2);
		assert.equal(dataset[0].eligibleForRegression, true);
	});

	it("records a Goal event as a lifecycle span and calculates operational metrics", () => {
		const event = createGoalEventV3({ lineage: { goalDefinitionId: "g", revisionId: "r", runId: "run", attemptId: "a" }, seq: 1, type: "approval.requested", time: 1_000 });
		const collector = new GoalTraceCollectorV3("trace-2", () => 1_100);
		const span = collector.recordGoalEvent(event);
		assert.equal(span.attributes["goal.event_seq"], 1);
		const metrics = calculateRuntimeMetrics({ status: "complete", spans: [{ ...span, endTimeUnixMs: 1_250 }], schemaValid: true, artifactChecks: ["correct", "incorrect", "unverified"], humanAccepted: true, recoveryAttempts: 1, recoverySucceeded: true, sideEffectKeys: ["k", "k"], costUsd: 0.5 });
		assert.equal(metrics.success, true);
		assert.equal(metrics.artifactCorrectness, 0.5);
		assert.equal(metrics.duplicateSideEffects, 1);
		assert.equal(metrics.latencyMs, 150);
		assert.equal(metrics.recoveryCorrectness, true);
		const cancelledMetrics = calculateRuntimeMetrics({ status: "cancelled", spans: [span], schemaValid: true, artifactChecks: [], humanAccepted: null, recoveryAttempts: 0, sideEffectKeys: [] });
		assert.equal(cancelledMetrics.success, false, "cancellation is terminal but not successful completion");
		assert.equal(cancelledMetrics.recoveryCorrectness, null);
	});

	it("projects tool, agent, retry, approval, checkpoint, evaluation, and usage fields into bounded span attributes", () => {
		const lineage = { goalDefinitionId: "g", revisionId: "r", runId: "run", attemptId: "a" };
		const tool = createGoalEventV3({ lineage, seq: 1, type: "tool_ended", time: 1, payload: { tool: "bash", durationMs: 25, isError: false } });
		assert.deepEqual(
			Object.fromEntries(Object.entries(goalEventTraceAttributes(tool)).filter(([key]) => key.startsWith("tool."))),
			{ "tool.name": "bash", "tool.duration_ms": 25, "tool.error": false },
		);
		const child = createGoalEventV3({ lineage, seq: 2, type: "subagent_started", time: 2, payload: { agentId: "agent-1", role: "reviewer", phase: "thinking", turnCount: 1 } });
		assert.equal(goalEventTraceAttributes(child)["agent.role"], "reviewer");
		const retry = createGoalEventV3({ lineage, seq: 3, type: "retry_scheduled", time: 3, payload: { errorCode: "rate_limit", attemptNumber: 1, nextAttemptNumber: 2, delayMs: 10_000 } });
		assert.equal(goalEventTraceAttributes(retry)["goal.retry.error_code"], "rate_limit");
		const approval = createGoalEventV3({ lineage, seq: 4, type: "goal.approval_requested", time: 4, payload: { approvalId: "approval-1", capability: "filesystem.write", checkpoint: { checksum: { value: "a".repeat(64) }, lastEventSeq: 4, approvals: [{}], sideEffects: [] } } });
		assert.equal(goalEventTraceAttributes(approval)["goal.approval.capability"], "filesystem.write");
		assert.equal(goalEventTraceAttributes(approval)["goal.checkpoint.approval_count"], 1);
		const evaluation = createGoalEventV3({ lineage, seq: 5, type: "completion_evaluated", time: 5, payload: { decision: "accept", findings: [], advisories: ["note"] } });
		assert.equal(goalEventTraceAttributes(evaluation)["goal.evaluation.advisory_count"], 1);
		const llm = createGoalEventV3({ lineage, seq: 6, type: "llm_response", time: 6, payload: { usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } }, stopReason: "stop" } });
		assert.equal(goalEventTraceAttributes(llm)["gen_ai.usage.cost_usd"], 0.01);
	});

	it("maps causal event ids into parent span ids", () => {
		const collector = new GoalTraceCollectorV3("trace-causal", () => 10);
		const lineage = { goalDefinitionId: "g", revisionId: "r", runId: "run", attemptId: "a" };
		const parent = createGoalEventV3({ lineage, seq: 1, eventId: "event-1", type: "tool.started", time: 1 });
		const child = createGoalEventV3({ lineage, seq: 2, eventId: "event-2", parentId: "event-1", type: "tool.completed", time: 2 });
		const parentSpan = collector.recordGoalEvent(parent);
		const childSpan = collector.recordGoalEvent(child);
		assert.equal(childSpan.parentSpanId, parentSpan.spanId);
	});

	it("orders simultaneous Goal spans by event sequence and restores the last durable sequence", () => {
		const collector = new GoalTraceCollectorV3("trace-sequence", () => 10);
		const lineage = { goalDefinitionId: "g", revisionId: "r", runId: "run-sequence", attemptId: "a" };
		collector.recordGoalEvent(createGoalEventV3({ lineage, seq: 10, type: "tool_ended", time: 10 }));
		collector.recordGoalEvent(createGoalEventV3({ lineage, seq: 2, type: "tool_started", time: 10 }));
		const sample = traceToOfflineDataset(collector.getSpans())[0];
		assert.deepEqual(sample.steps.map((step) => step.attributes["goal.event_seq"]), [2, 10]);
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-trace-seq-")), "trace.jsonl");
		fs.writeFileSync(file, collector.getSpans().map((span) => JSON.stringify(span)).join("\n") + "\n");
		assert.equal(lastTraceEventSequenceV3(file, lineage.runId), 10);
		assert.equal(lastTraceEventSequenceV3(file, "other-run"), 0);
	});

	it("marks error and orphan-parent traces ineligible for offline regression", () => {
		const collector = new GoalTraceCollectorV3("trace-anomaly", () => 10);
		const span = collector.startSpan({ name: "tool.execute", parentSpanId: "missing", kind: "client" });
		span.end("error");
		const sample = traceToOfflineDataset(collector.getSpans(), { sampleId: () => "fixture:trace" })[0];
		assert.equal(sample.sampleId, "fixture:trace");
		assert.equal(sample.eligibleForRegression, false);
		assert.match(sample.anomalyReasons.join(" "), /error span/);
		assert.match(sample.anomalyReasons.join(" "), /orphan parent/);
	});

	it("injects a recoverable provider failure once", async () => {
		const injector = new FaultInjectorV3("provider_abort");
		await assert.rejects(() => injector.run(async () => "ok"), (error: unknown) => {
			assert.equal((error as { goalError: { code: string } }).goalError.code, "provider_abort");
			return true;
		});
		assert.equal(await injector.run(async () => "ok"), "ok");
		assert.equal(injectedFaultError("approval_wait").goalError.recovery, "wait_approval");
	});

	it("covers every planned injected failure mode with a deterministic expectation", async () => {
		for (const kind of Object.keys(FAULT_EXPECTATIONS_V3) as Array<keyof typeof FAULT_EXPECTATIONS_V3>) {
			const result = await runFaultScenarioV3(kind, async () => "recovered");
			assert.equal(result.kind, kind);
			assert.equal(result.secondRunSucceeded, true);
		}
	});
});
