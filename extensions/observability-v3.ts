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

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, maxLength = 160): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const normalized = value.trim();
	return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength - 3) + "...";
}

function recordAttribute(target: Record<string, string | number | boolean>, key: string, value: unknown): void {
	const stringValue = boundedString(value);
	if (stringValue !== undefined) target[key] = stringValue;
	else if (typeof value === "boolean") target[key] = value;
	else {
		const numberValue = finiteNumber(value);
		if (numberValue !== undefined) target[key] = numberValue;
	}
}

function eventSpanKind(type: string): OTelTraceSpanV3["kind"] {
	if (type === "tool_started" || type === "tool_ended" || type.startsWith("goal.side_effect_")) return "client";
	if (type.startsWith("subagent_")) return "consumer";
	return "internal";
}

function eventSpanStatus(event: GoalEventEnvelopeV3): TraceStatusV3 {
	if (event.payload.isError === true || event.payload.status === "failed") return "error";
	if (/denied|failure|exhausted|error/.test(event.type)) return "error";
	return "ok";
}

/**
 * Project-neutral, bounded event projection. Large tool arguments, model text,
 * artifact bodies, and checkpoint state intentionally stay in the event log.
 */
export function goalEventTraceAttributes(event: GoalEventEnvelopeV3): Record<string, string | number | boolean> {
	const attributes: Record<string, string | number | boolean> = {
		"goal.id": event.goalId,
		"goal.revision_id": event.revisionId,
		"goal.run_id": event.runId,
		"goal.attempt_id": event.attemptId,
		"goal.event_seq": event.seq,
		"goal.event_type": event.type,
	};
	if (event.nodeId) attributes["goal.node_id"] = event.nodeId;
	if (event.causationId) attributes["goal.causation_id"] = event.causationId;
	const payload = event.payload;

	if (event.type === "tool_started" || event.type === "tool_ended" || event.type.startsWith("tool.")) {
		recordAttribute(attributes, "tool.name", payload.tool);
		recordAttribute(attributes, "tool.call_id", payload.toolCallId);
		recordAttribute(attributes, "tool.duration_ms", payload.durationMs);
		recordAttribute(attributes, "tool.error", payload.isError);
	}
	if (event.type.startsWith("subagent_")) {
		recordAttribute(attributes, "agent.id", payload.agentId);
		recordAttribute(attributes, "agent.role", payload.role);
		recordAttribute(attributes, "agent.phase", payload.phase);
		recordAttribute(attributes, "agent.turn_count", payload.turnCount);
		recordAttribute(attributes, "agent.tool", payload.tool);
	}
	if (event.type === "llm_response") {
		const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
		const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
		recordAttribute(attributes, "gen_ai.usage.input_tokens", usage.input);
		recordAttribute(attributes, "gen_ai.usage.output_tokens", usage.output);
		recordAttribute(attributes, "gen_ai.usage.total_tokens", usage.totalTokens);
		recordAttribute(attributes, "gen_ai.usage.cost_usd", cost.total);
		recordAttribute(attributes, "gen_ai.response.finish_reason", payload.stopReason);
	}
	if (/retry|provider_failure/.test(event.type)) {
		recordAttribute(attributes, "goal.retry.error_code", payload.errorCode);
		recordAttribute(attributes, "goal.retry.attempt", payload.attemptNumber);
		recordAttribute(attributes, "goal.retry.next_attempt", payload.nextAttemptNumber);
		recordAttribute(attributes, "goal.retry.delay_ms", payload.delayMs ?? payload.retryAfterMs);
		recordAttribute(attributes, "http.response.status_code", payload.status);
	}
	if (/approval/.test(event.type)) {
		recordAttribute(attributes, "goal.approval.id", payload.approvalId);
		recordAttribute(attributes, "goal.approval.capability", payload.capability);
		recordAttribute(attributes, "goal.approval.decision", payload.decision);
	}
	if (/steering/.test(event.type)) {
		recordAttribute(attributes, "goal.steering.kind", payload.kind);
		recordAttribute(attributes, "goal.steering.source", payload.source);
	}
	if (/completion|review|evaluation/.test(event.type)) {
		const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
		const completion = result.completion && typeof result.completion === "object" ? result.completion as Record<string, unknown> : {};
		const impliedDecision = event.type === "completion_bundle_committed" ? "accept" : undefined;
		recordAttribute(attributes, "goal.evaluation.decision", payload.decision ?? payload.status ?? completion.decision ?? impliedDecision);
		recordAttribute(attributes, "goal.evaluation.finding_count", Array.isArray(payload.findings) ? payload.findings.length : payload.findings);
		recordAttribute(attributes, "goal.evaluation.advisory_count", Array.isArray(payload.advisories) ? payload.advisories.length : payload.advisories);
	}
	const checkpoint = payload.checkpoint && typeof payload.checkpoint === "object"
		? payload.checkpoint as Record<string, unknown>
		: undefined;
	if (checkpoint) {
		const checksum = checkpoint.checksum && typeof checkpoint.checksum === "object"
			? checkpoint.checksum as Record<string, unknown>
			: {};
		recordAttribute(attributes, "goal.checkpoint.digest", checksum.value);
		recordAttribute(attributes, "goal.checkpoint.last_event_seq", checkpoint.lastEventSeq);
		recordAttribute(attributes, "goal.checkpoint.approval_count", Array.isArray(checkpoint.approvals) ? checkpoint.approvals.length : undefined);
		recordAttribute(attributes, "goal.checkpoint.side_effect_count", Array.isArray(checkpoint.sideEffects) ? checkpoint.sideEffects.length : undefined);
	}
	if (event.type.startsWith("goal.side_effect_")) {
		const entry = payload.entry && typeof payload.entry === "object" ? payload.entry as Record<string, unknown> : {};
		recordAttribute(attributes, "goal.side_effect.id", entry.id);
		recordAttribute(attributes, "goal.side_effect.operation", entry.operation);
		recordAttribute(attributes, "goal.side_effect.status", entry.status);
		recordAttribute(attributes, "goal.side_effect.adapter_id", payload.adapterId ?? entry.adapterId);
	}
	return attributes;
}

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
		const handle = this.startSpan({
			spanId: eventSpanId,
			name: `goal.${event.type}`,
			parentSpanId,
			kind: eventSpanKind(event.type),
			attributes: goalEventTraceAttributes(event),
		});
		const span = handle.end(eventSpanStatus(event));
		return { ...span, events: [{ name: event.type, timeUnixMs: event.time, attributes: { "goal.event_id": event.eventId } }] };
	}
	getSpans(): OTelTraceSpanV3[] { return [...this.spans.values()].map((span) => structuredClone(span)); }
}

export interface OfflineTrajectorySampleV3 {
	schemaVersion: typeof TRACE_SCHEMA_VERSION_V3;
	sampleId: string;
	traceId: string;
	spanNames: string[];
	steps: Array<{
		spanId: string;
		parentSpanId: string | null;
		name: string;
		status: TraceStatusV3;
		attributes: Record<string, string | number | boolean>;
	}>;
	durationMs: number;
	status: TraceStatusV3;
	attributes: Record<string, string | number | boolean>;
	anomalyReasons: string[];
	eligibleForRegression: boolean;
}

export function traceToOfflineDataset(spans: OTelTraceSpanV3[], options: {
	redact?: (value: string) => string;
	sampleId?: (traceId: string) => string;
	anomalyReasons?: (traceId: string, spans: OTelTraceSpanV3[]) => string[];
} = {}): OfflineTrajectorySampleV3[] {
	const byTrace = new Map<string, OTelTraceSpanV3[]>();
	for (const span of spans) byTrace.set(span.traceId, [...(byTrace.get(span.traceId) ?? []), span]);
	return [...byTrace].map(([traceId, traceSpans]) => {
		const ordered = [...traceSpans].sort((left, right) => {
			const leftSeq = finiteNumber(left.attributes["goal.event_seq"]);
			const rightSeq = finiteNumber(right.attributes["goal.event_seq"]);
			if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) return leftSeq - rightSeq;
			return left.startTimeUnixMs - right.startTimeUnixMs || left.spanId.localeCompare(right.spanId);
		});
		const first = Math.min(...ordered.map((span) => span.startTimeUnixMs));
		const last = Math.max(...ordered.map((span) => span.endTimeUnixMs ?? span.startTimeUnixMs));
		const redact = options.redact ?? ((value: string) => value);
		const redactAttributes = (attributes: Record<string, string | number | boolean>) => Object.fromEntries(
			Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]),
		);
		const spanIds = new Set(ordered.map((span) => span.spanId));
		const duplicateSpanIds = ordered.length - spanIds.size;
		const orphanParents = ordered.filter((span) => span.parentSpanId !== null && !spanIds.has(span.parentSpanId));
		const anomalyReasons = [
			...(ordered.some((span) => span.status === "error") ? ["trace contains an error span"] : []),
			...(duplicateSpanIds > 0 ? [`trace contains ${duplicateSpanIds} duplicate span id(s)`] : []),
			...(orphanParents.length > 0 ? [`trace contains ${orphanParents.length} orphan parent reference(s)`] : []),
			...(options.anomalyReasons?.(traceId, ordered) ?? []),
		];
		return {
			schemaVersion: TRACE_SCHEMA_VERSION_V3,
			sampleId: options.sampleId?.(traceId) ?? `trajectory:${traceId}`,
			traceId,
			spanNames: ordered.map((span) => redact(span.name)),
			steps: ordered.map((span) => ({
				spanId: redact(span.spanId),
				parentSpanId: span.parentSpanId === null ? null : redact(span.parentSpanId),
				name: redact(span.name),
				status: span.status,
				attributes: redactAttributes(span.attributes),
			})),
			durationMs: Math.max(0, last - first),
			status: ordered.some((span) => span.status === "error") ? "error" : "ok",
			attributes: redactAttributes(ordered[0]?.attributes ?? {}),
			anomalyReasons: [...new Set(anomalyReasons)],
			eligibleForRegression: anomalyReasons.length === 0,
		};
	});
}

export interface RuntimeMetricsInputV3 {
	status: "complete" | "unmet" | "blocked" | "paused" | "cancelled" | "failed";
	spans: OTelTraceSpanV3[];
	schemaValid: boolean;
	artifactChecks: Array<"correct" | "incorrect" | "unverified">;
	humanAccepted: boolean | null;
	humanInterventions?: number;
	recoveryAttempts: number;
	recoverySucceeded?: boolean | null;
	sideEffectKeys: string[];
	costUsd?: number;
}

export interface RuntimeMetricsV3 {
	success: boolean;
	artifactCorrectness: number | null;
	humanAcceptance: boolean | null;
	humanInterventions: number;
	schemaValidity: boolean;
	recoveryAttempts: number;
	recoveryCorrectness: boolean | null;
	duplicateSideEffects: number;
	costUsd: number | null;
	latencyMs: number;
}

export function calculateRuntimeMetrics(input: RuntimeMetricsInputV3): RuntimeMetricsV3 {
	const checked = input.artifactChecks.filter((value) => value !== "unverified");
	const correct = checked.filter((value) => value === "correct").length;
	const duplicateSideEffects = input.sideEffectKeys.length - new Set(input.sideEffectKeys).size;
	const latencyMs = input.spans.length === 0 ? 0 : Math.max(0, Math.max(...input.spans.map((span) => span.endTimeUnixMs ?? span.startTimeUnixMs)) - Math.min(...input.spans.map((span) => span.startTimeUnixMs)));
	const observedInterventions = input.spans.filter((span) =>
		((span.name === "goal.steering_received" || span.name === "goal.steering.received") && span.attributes["goal.steering.kind"] !== "initial")
		|| span.name === "goal.approval.granted"
		|| span.name === "goal.goal.approval_granted").length;
	return {
		success: input.status === "complete",
		artifactCorrectness: checked.length === 0 ? null : correct / checked.length,
		humanAcceptance: input.humanAccepted,
		humanInterventions: input.humanInterventions ?? observedInterventions,
		schemaValidity: input.schemaValid,
		recoveryAttempts: input.recoveryAttempts,
		recoveryCorrectness: input.recoveryAttempts === 0 ? null : input.recoverySucceeded ?? false,
		duplicateSideEffects,
		costUsd: input.costUsd ?? null,
		latencyMs,
	};
}

export function appendTraceJsonl(span: OTelTraceSpanV3, filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, JSON.stringify(span) + "\n", "utf8");
}

/** Recover the durable event sequence after an interactive session reload. */
export function lastTraceEventSequenceV3(filePath: string, runId: string): number {
	if (!runId.trim() || !fs.existsSync(filePath)) return 0;
	let maximum = 0;
	try {
		for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			const span = JSON.parse(line) as Partial<OTelTraceSpanV3>;
			if (span.attributes?.["goal.run_id"] !== runId) continue;
			const sequence = finiteNumber(span.attributes["goal.event_seq"]);
			if (sequence !== undefined && Number.isSafeInteger(sequence) && sequence > 0) maximum = Math.max(maximum, sequence);
		}
	} catch {
		return maximum;
	}
	return maximum;
}
