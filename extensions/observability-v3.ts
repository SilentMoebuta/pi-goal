import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalEventEnvelopeV3 } from "./runtime-v3";

export const TRACE_SCHEMA_VERSION_V3 = 1 as const;
export type TraceStatusV3 = "unset" | "ok" | "error";

export interface OTelTraceSpanV3 {
	schemaVersion: typeof TRACE_SCHEMA_VERSION_V3;
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: "internal" | "client" | "server" | "producer" | "consumer";
	startTimeUnixMs: number;
	endTimeUnixMs: number | null;
	status: TraceStatusV3;
	attributes: Record<string, string | number | boolean>;
	events: Array<{ name: string; timeUnixMs: number; attributes?: Record<string, string | number | boolean> }>;
}

export interface TraceSpanHandleV3 { spanId: string; end(status?: TraceStatusV3, attributes?: Record<string, string | number | boolean>): OTelTraceSpanV3; }

export class GoalTraceCollectorV3 {
	private sequence = 0;
	private readonly spans = new Map<string, OTelTraceSpanV3>();
	constructor(readonly traceId: string, private readonly clock: () => number = Date.now) {
		if (!traceId.trim()) throw new Error("traceId is required");
	}
	startSpan(input: { name: string; spanId?: string; parentSpanId?: string | null; kind?: OTelTraceSpanV3["kind"]; attributes?: Record<string, string | number | boolean> }): TraceSpanHandleV3 {
		if (!input.name.trim()) throw new Error("span name is required");
		const spanId = input.spanId ?? `${this.traceId}:span:${++this.sequence}`;
		const span: OTelTraceSpanV3 = { schemaVersion: TRACE_SCHEMA_VERSION_V3, traceId: this.traceId, spanId, parentSpanId: input.parentSpanId ?? null, name: input.name, kind: input.kind ?? "internal", startTimeUnixMs: this.clock(), endTimeUnixMs: null, status: "unset", attributes: { ...(input.attributes ?? {}) }, events: [] };
		this.spans.set(spanId, span);
		return {
			spanId,
			end: (status = "ok", attributes = {}) => {
				const current = this.spans.get(spanId);
				if (!current) throw new Error(`unknown span '${spanId}'`);
				if (current.endTimeUnixMs !== null) return structuredClone(current);
				current.endTimeUnixMs = Math.max(current.startTimeUnixMs, this.clock());
				current.status = status;
				Object.assign(current.attributes, attributes);
				return structuredClone(current);
			},
		};
	}
	recordEvent(spanId: string, name: string, attributes?: Record<string, string | number | boolean>): void {
		const span = this.spans.get(spanId);
		if (!span) throw new Error(`unknown span '${spanId}'`);
		span.events.push({ name, timeUnixMs: this.clock(), ...(attributes ? { attributes: { ...attributes } } : {}) });
	}
	recordGoalEvent(event: GoalEventEnvelopeV3): OTelTraceSpanV3 {
		const eventSpanId = `${this.traceId}:event:${event.eventId}`;
		const parentSpanId = event.parentId ? `${this.traceId}:event:${event.parentId}` : null;
		const handle = this.startSpan({ spanId: eventSpanId, name: `goal.${event.type}`, parentSpanId, attributes: { "goal.id": event.goalId, "goal.revision_id": event.revisionId, "goal.run_id": event.runId, "goal.attempt_id": event.attemptId, ...(event.nodeId ? { "goal.node_id": event.nodeId } : {}) } });
		const span = handle.end("ok", { "goal.event_seq": event.seq });
		return { ...span, events: [{ name: event.type, timeUnixMs: event.time, attributes: { "goal.event_id": event.eventId } }] };
	}
	getSpans(): OTelTraceSpanV3[] { return [...this.spans.values()].map((span) => structuredClone(span)); }
}

export interface OfflineTrajectorySampleV3 {
	schemaVersion: typeof TRACE_SCHEMA_VERSION_V3;
	sampleId: string;
	traceId: string;
	spanNames: string[];
	durationMs: number;
	status: TraceStatusV3;
	attributes: Record<string, string | number | boolean>;
}

export function traceToOfflineDataset(spans: OTelTraceSpanV3[], options: { redact?: (value: string) => string } = {}): OfflineTrajectorySampleV3[] {
	const byTrace = new Map<string, OTelTraceSpanV3[]>();
	for (const span of spans) byTrace.set(span.traceId, [...(byTrace.get(span.traceId) ?? []), span]);
	return [...byTrace].map(([traceId, traceSpans]) => {
		const first = Math.min(...traceSpans.map((span) => span.startTimeUnixMs));
		const last = Math.max(...traceSpans.map((span) => span.endTimeUnixMs ?? span.startTimeUnixMs));
		const redact = options.redact ?? ((value: string) => value);
		const attributes = Object.fromEntries(Object.entries(traceSpans[0]?.attributes ?? {}).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]));
		return { schemaVersion: TRACE_SCHEMA_VERSION_V3, sampleId: `trajectory:${traceId}`, traceId, spanNames: traceSpans.map((span) => redact(span.name)), durationMs: Math.max(0, last - first), status: traceSpans.some((span) => span.status === "error") ? "error" : "ok", attributes };
	});
}

export interface RuntimeMetricsInputV3 {
	status: "complete" | "unmet" | "blocked" | "paused" | "failed";
	spans: OTelTraceSpanV3[];
	schemaValid: boolean;
	artifactChecks: Array<"correct" | "incorrect" | "unverified">;
	humanAccepted: boolean | null;
	recoveryAttempts: number;
	sideEffectKeys: string[];
	costUsd?: number;
}

export interface RuntimeMetricsV3 {
	success: boolean;
	artifactCorrectness: number | null;
	humanAcceptance: boolean | null;
	schemaValidity: boolean;
	recoveryAttempts: number;
	duplicateSideEffects: number;
	costUsd: number | null;
	latencyMs: number;
}

export function calculateRuntimeMetrics(input: RuntimeMetricsInputV3): RuntimeMetricsV3 {
	const checked = input.artifactChecks.filter((value) => value !== "unverified");
	const correct = checked.filter((value) => value === "correct").length;
	const duplicateSideEffects = input.sideEffectKeys.length - new Set(input.sideEffectKeys).size;
	const latencyMs = input.spans.length === 0 ? 0 : Math.max(0, Math.max(...input.spans.map((span) => span.endTimeUnixMs ?? span.startTimeUnixMs)) - Math.min(...input.spans.map((span) => span.startTimeUnixMs)));
	return { success: input.status === "complete", artifactCorrectness: checked.length === 0 ? null : correct / checked.length, humanAcceptance: input.humanAccepted, schemaValidity: input.schemaValid, recoveryAttempts: input.recoveryAttempts, duplicateSideEffects, costUsd: input.costUsd ?? null, latencyMs };
}

export function appendTraceJsonl(span: OTelTraceSpanV3, filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, JSON.stringify(span) + "\n", "utf8");
}
