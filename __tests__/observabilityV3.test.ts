import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalTraceCollectorV3, calculateRuntimeMetrics, traceToOfflineDataset } from "../extensions/observability-v3";
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
	});

	it("records a Goal event as a lifecycle span and calculates operational metrics", () => {
		const event = createGoalEventV3({ lineage: { goalDefinitionId: "g", revisionId: "r", runId: "run", attemptId: "a" }, seq: 1, type: "approval.requested", time: 1_000 });
		const collector = new GoalTraceCollectorV3("trace-2", () => 1_100);
		const span = collector.recordGoalEvent(event);
		assert.equal(span.attributes["goal.event_seq"], 1);
		const metrics = calculateRuntimeMetrics({ status: "complete", spans: [{ ...span, endTimeUnixMs: 1_250 }], schemaValid: true, artifactChecks: ["correct", "incorrect", "unverified"], humanAccepted: true, recoveryAttempts: 1, sideEffectKeys: ["k", "k"], costUsd: 0.5 });
		assert.equal(metrics.success, true);
		assert.equal(metrics.artifactCorrectness, 0.5);
		assert.equal(metrics.duplicateSideEffects, 1);
		assert.equal(metrics.latencyMs, 150);
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
