import { createHash, randomUUID } from "node:crypto";

import {
	createGoalError,
	type GoalAttemptV3,
	type GoalDigestV3,
	type GoalErrorCode,
	type GoalErrorV3,
	type GoalLineageV3,
	type GoalRunStatus,
	type GoalRunV3,
	type GoalRuntimeMetadataV3,
} from "./goal-contract-v3";

export const GOAL_EVENT_SCHEMA_VERSION = 3 as const;
export const GOAL_RUNTIME_CHECKPOINT_VERSION = 3 as const;

export type GoalRetryAction =
	| "retry_attempt"
	| "repair_schema"
	| "create_revision"
	| "wait_user"
	| "wait_approval"
	| "stop";

export interface GoalRetryPolicyV3 {
	maxInfrastructureAttempts: number;
	maxSchemaRepairs: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_GOAL_RETRY_POLICY_V3: GoalRetryPolicyV3 = {
	maxInfrastructureAttempts: 5,
	maxSchemaRepairs: 2,
	baseDelayMs: 10_000,
	maxDelayMs: 120_000,
};

export interface GoalRetryContextV3 {
	attemptNumber: number;
	schemaRepairCount?: number;
	retryAfterMs?: number;
	policy?: Partial<GoalRetryPolicyV3>;
}

export interface GoalRetryDecisionV3 {
	action: GoalRetryAction;
	nextRunStatus: GoalRunStatus;
	delayMs: number;
	consumesAttempt: boolean;
	reason: string;
}

const INFRASTRUCTURE_ERRORS = new Set<GoalErrorCode>([
	"rate_limit", "capacity", "network", "provider_abort", "worker_crash", "timeout",
]);

export function classifyGoalError(value: unknown): GoalErrorV3 {
	if (isGoalError(value)) return value;
	const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(object.message ?? value);
	const status = typeof object.status === "number" ? object.status
		: typeof object.statusCode === "number" ? object.statusCode : undefined;
	const codeText = String(object.code ?? object.name ?? "").toLowerCase();
	const text = `${codeText} ${message}`.toLowerCase();

	let code: GoalErrorCode = "internal";
	if (status === 429 || /\b429\b|rate.?limit|too many requests/.test(text)) code = "rate_limit";
	else if (status === 503 || /capacity|overload|resource exhausted|no slots?/.test(text)) code = "capacity";
	else if (/timeout|timed out|etimedout/.test(text)) code = "timeout";
	else if (/network|econnreset|econnrefused|enotfound|socket|fetch failed/.test(text)) code = "network";
	else if (/provider.?abort|upstream.?abort/.test(text)) code = "provider_abort";
	else if (/worker.*(?:crash|exit)|child process.*exit|worker_crash/.test(text)) code = "worker_crash";
	else if (/schema|invalid json|structured output/.test(text)) code = "schema_invalid";
	else if (/verification|test failed|check failed/.test(text)) code = "verification_failed";
	else if (/approval.*required|requires approval/.test(text)) code = "approval_required";
	else if (/permission|policy.*denied|not allowed|forbidden/.test(text)) code = "policy_denied";
	else if (/budget|quota exhausted/.test(text)) code = "budget_exhausted";
	else if (/cancelled|canceled/.test(text)) code = "cancelled";
	return createGoalError(code, message || code, {
		details: status === undefined ? undefined : { status },
	});
}

export function decideGoalRetry(errorValue: unknown, context: GoalRetryContextV3): GoalRetryDecisionV3 {
	const error = classifyGoalError(errorValue);
	const policy = { ...DEFAULT_GOAL_RETRY_POLICY_V3, ...(context.policy ?? {}) };
	if (INFRASTRUCTURE_ERRORS.has(error.code)) {
		if (context.attemptNumber >= policy.maxInfrastructureAttempts) {
			return {
				action: "wait_user", nextRunStatus: "waiting_user", delayMs: 0, consumesAttempt: false,
				reason: `Infrastructure retry limit reached after ${context.attemptNumber} attempts.`,
			};
		}
		const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, context.attemptNumber - 1)));
		const retryAfter = context.retryAfterMs === undefined ? 0 : Math.max(0, context.retryAfterMs);
		return {
			action: "retry_attempt", nextRunStatus: "retrying", delayMs: Math.max(exponential, retryAfter), consumesAttempt: true,
			reason: `${error.code} is retryable in a fresh attempt.`,
		};
	}
	if (error.code === "schema_invalid") {
		const repairs = context.schemaRepairCount ?? 0;
		return repairs < policy.maxSchemaRepairs
			? { action: "repair_schema", nextRunStatus: "active", delayMs: 0, consumesAttempt: false, reason: "Apply a bounded structured-output repair in the current attempt." }
			: { action: "create_revision", nextRunStatus: "failed", delayMs: 0, consumesAttempt: false, reason: "Schema repair limit reached; revise the execution contract." };
	}
	if (error.code === "verification_failed" || error.code === "stale_artifact" || error.code === "stale_revision") {
		return { action: "create_revision", nextRunStatus: "failed", delayMs: 0, consumesAttempt: false, reason: `${error.code} requires a new revision, not an infrastructure retry.` };
	}
	if (error.code === "approval_required") {
		return { action: "wait_approval", nextRunStatus: "waiting_approval", delayMs: 0, consumesAttempt: false, reason: "Execution must wait for an approval decision." };
	}
	if (error.code === "waiting_for_user" || error.code === "budget_exhausted") {
		return { action: "wait_user", nextRunStatus: "waiting_user", delayMs: 0, consumesAttempt: false, reason: "Execution requires user input before it can continue." };
	}
	return { action: "stop", nextRunStatus: error.code === "cancelled" ? "cancelled" : "failed", delayMs: 0, consumesAttempt: false, reason: `${error.code} is terminal under the current policy.` };
}

export function rolloverRuntimeAttempt(runtime: GoalRuntimeMetadataV3): GoalRuntimeMetadataV3 {
	const attemptNumber = runtime.attemptNumber + 1;
	return {
		...runtime,
		attemptId: `${runtime.runId}:attempt:${attemptNumber}`,
		attemptNumber,
		previousAttemptId: runtime.attemptId,
	};
}

export function rolloverGoalAttempt(input: {
	run: GoalRunV3;
	attempt: GoalAttemptV3;
	now: number;
	idempotencyKey?: string;
}): { run: GoalRunV3; attempt: GoalAttemptV3 } {
	if (input.run.currentAttemptId !== input.attempt.id || input.attempt.status !== "active") {
		throw new Error("Only the active current attempt can roll over.");
	}
	const number = input.attempt.number + 1;
	const id = `${input.run.id}:attempt:${number}`;
	const attempt: GoalAttemptV3 = {
		id,
		runId: input.run.id,
		revisionId: input.run.revisionId,
		number,
		previousAttemptId: input.attempt.id,
		status: "active",
		idempotencyKey: input.idempotencyKey ?? id,
		startedAt: input.now,
		endedAt: null,
	};
	return {
		run: {
			...input.run,
			status: "active",
			attemptIds: input.run.attemptIds.includes(id) ? [...input.run.attemptIds] : [...input.run.attemptIds, id],
			currentAttemptId: id,
			updatedAt: input.now,
			endedAt: null,
		},
		attempt,
	};
}

export interface GoalEventEnvelopeV3 {
	schemaVersion: typeof GOAL_EVENT_SCHEMA_VERSION;
	eventId: string;
	seq: number;
	goalId: string;
	revisionId: string;
	runId: string;
	attemptId: string;
	nodeId: string | null;
	parentId: string | null;
	causationId: string | null;
	type: string;
	time: number;
	payload: Record<string, unknown>;
}

export function createGoalEventV3(input: {
	lineage: GoalLineageV3;
	seq: number;
	type: string;
	time: number;
	payload?: Record<string, unknown>;
	nodeId?: string | null;
	parentId?: string | null;
	causationId?: string | null;
	eventId?: string;
}): GoalEventEnvelopeV3 {
	if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new Error("event seq must be a positive safe integer");
	if (!input.type.trim()) throw new Error("event type is required");
	if (!Number.isFinite(input.time) || input.time < 0) throw new Error("event time must be a finite non-negative number");
	return {
		schemaVersion: GOAL_EVENT_SCHEMA_VERSION,
		eventId: input.eventId ?? `${input.lineage.runId}:event:${input.seq}`,
		seq: input.seq,
		goalId: input.lineage.goalDefinitionId,
		revisionId: input.lineage.revisionId,
		runId: input.lineage.runId,
		attemptId: input.lineage.attemptId,
		nodeId: input.nodeId ?? null,
		parentId: input.parentId ?? null,
		causationId: input.causationId ?? null,
		type: input.type,
		time: input.time,
		payload: structuredClone(input.payload ?? {}),
	};
}

export function parseGoalEventV3(value: unknown): GoalEventEnvelopeV3 {
	const object = record(value, "event");
	if (object.schemaVersion !== GOAL_EVENT_SCHEMA_VERSION) throw new Error(`event.schemaVersion must be ${GOAL_EVENT_SCHEMA_VERSION}`);
	const lineage: GoalLineageV3 = {
		goalDefinitionId: stringValue(object.goalId, "event.goalId"),
		revisionId: stringValue(object.revisionId, "event.revisionId"),
		runId: stringValue(object.runId, "event.runId"),
		attemptId: stringValue(object.attemptId, "event.attemptId"),
	};
	return createGoalEventV3({
		lineage,
		seq: positiveInteger(object.seq, "event.seq"),
		type: stringValue(object.type, "event.type"),
		time: nonNegativeNumber(object.time, "event.time"),
		payload: record(object.payload, "event.payload"),
		nodeId: nullableString(object.nodeId, "event.nodeId"),
		parentId: nullableString(object.parentId, "event.parentId"),
		causationId: nullableString(object.causationId, "event.causationId"),
		eventId: stringValue(object.eventId, "event.eventId"),
	});
}

export type GoalApprovalDecision = "pending" | "granted" | "denied" | "revoked";

export interface GoalApprovalRecordV3 {
	id: string;
	revisionId: string;
	capability: string;
	scope: string;
	decision: GoalApprovalDecision;
	requestedAt: number;
	decidedAt: number | null;
	decidedBy: string | null;
}

export interface GoalCapabilityGrantV3 {
	capability: string;
	scopes: string[];
	source: "host" | "user" | "repository" | "organization";
}

export type GoalAuthorizationV3 =
	| { allowed: true; capability: GoalCapabilityGrantV3; approval?: GoalApprovalRecordV3 }
	| { allowed: false; error: GoalErrorV3 };

export function authorizeGoalOperation(input: {
	capability: string;
	scope: string;
	revisionId: string;
	grants: GoalCapabilityGrantV3[];
	approvals: GoalApprovalRecordV3[];
	requiresApproval: boolean;
}): GoalAuthorizationV3 {
	const grant = input.grants.find((candidate) => candidate.capability === input.capability
		&& candidate.scopes.some((scope) => scopeMatches(scope, input.scope)));
	if (!grant) {
		return { allowed: false, error: createGoalError("policy_denied", `Capability '${input.capability}' is not granted for '${input.scope}'.`) };
	}
	if (!input.requiresApproval) return { allowed: true, capability: grant };
	const approval = [...input.approvals].reverse().find((candidate) => candidate.revisionId === input.revisionId
		&& candidate.capability === input.capability && scopeMatches(candidate.scope, input.scope));
	if (!approval || approval.decision === "pending") {
		return { allowed: false, error: createGoalError("approval_required", `Approval is required for '${input.capability}' on '${input.scope}'.`) };
	}
	if (approval.decision !== "granted") {
		return { allowed: false, error: createGoalError("policy_denied", `Approval '${approval.id}' is ${approval.decision}.`) };
	}
	return { allowed: true, capability: grant, approval };
}

export type GoalSideEffectStatus = "prepared" | "committed" | "failed";

export interface GoalSideEffectJournalEntryV3 {
	id: string;
	idempotencyKey: string;
	operation: string;
	resource: string;
	requestDigest: GoalDigestV3;
	status: GoalSideEffectStatus;
	attemptId: string;
	preparedAt: number;
	completedAt: number | null;
	responseDigest?: GoalDigestV3;
	error?: GoalErrorV3;
}

export type GoalSideEffectPreflightV3 =
	| { action: "execute"; entry: GoalSideEffectJournalEntryV3 }
	| { action: "replay"; entry: GoalSideEffectJournalEntryV3 }
	| { action: "reconcile"; entry: GoalSideEffectJournalEntryV3 }
	| { action: "conflict"; error: GoalErrorV3 };

export function prepareGoalSideEffect(input: {
	journal: GoalSideEffectJournalEntryV3[];
	idempotencyKey: string;
	operation: string;
	resource: string;
	request: unknown;
	attemptId: string;
	now: number;
}): GoalSideEffectPreflightV3 {
	const requestDigest = digest(input.request);
	const existing = input.journal.find((entry) => entry.idempotencyKey === input.idempotencyKey);
	if (existing) {
		if (existing.operation !== input.operation || existing.resource !== input.resource || existing.requestDigest.value !== requestDigest.value) {
			return { action: "conflict", error: createGoalError("idempotency_conflict", "The side-effect idempotency key was reused with a different request.") };
		}
		if (existing.status === "committed") return { action: "replay", entry: existing };
		if (existing.status === "prepared") return { action: "reconcile", entry: existing };
	}
	const entry: GoalSideEffectJournalEntryV3 = {
		id: `${input.attemptId}:side-effect:${input.journal.length + 1}`,
		idempotencyKey: stringValue(input.idempotencyKey, "idempotencyKey"),
		operation: stringValue(input.operation, "operation"),
		resource: stringValue(input.resource, "resource"),
		requestDigest,
		status: "prepared",
		attemptId: stringValue(input.attemptId, "attemptId"),
		preparedAt: input.now,
		completedAt: null,
	};
	input.journal.push(entry);
	return { action: "execute", entry };
}

export function settleGoalSideEffect(
	entry: GoalSideEffectJournalEntryV3,
	input: { response?: unknown; error?: unknown; now: number },
): GoalSideEffectJournalEntryV3 {
	if (entry.status === "committed") return entry;
	if (input.error !== undefined) {
		return { ...entry, status: "failed", completedAt: input.now, error: classifyGoalError(input.error) };
	}
	return { ...entry, status: "committed", completedAt: input.now, responseDigest: digest(input.response ?? null), error: undefined };
}

export interface GoalRuntimeCheckpointV3<TState = unknown> {
	version: typeof GOAL_RUNTIME_CHECKPOINT_VERSION;
	lineage: GoalLineageV3;
	state: TState;
	artifacts: Array<{ id: string; uri: string; digest: GoalDigestV3; sizeBytes: number; verifiedAt: number }>;
	approvals: GoalApprovalRecordV3[];
	sideEffects: GoalSideEffectJournalEntryV3[];
	lastEventSeq: number;
	createdAt: number;
	checksum: GoalDigestV3;
}

export function createGoalRuntimeCheckpointV3<TState>(input: Omit<GoalRuntimeCheckpointV3<TState>, "version" | "checksum">): GoalRuntimeCheckpointV3<TState> {
	const body = { version: GOAL_RUNTIME_CHECKPOINT_VERSION, ...structuredClone(input) };
	return { ...body, checksum: digest(body) };
}

export function serializeGoalRuntimeCheckpointV3(checkpoint: GoalRuntimeCheckpointV3): string {
	return JSON.stringify(checkpoint);
}

export function deserializeGoalRuntimeCheckpointV3<TState = unknown>(json: string): GoalRuntimeCheckpointV3<TState> {
	const object = record(JSON.parse(json), "checkpoint");
	if (object.version !== GOAL_RUNTIME_CHECKPOINT_VERSION) throw new Error(`checkpoint.version must be ${GOAL_RUNTIME_CHECKPOINT_VERSION}`);
	const checksumObject = record(object.checksum, "checkpoint.checksum");
	const checksum: GoalDigestV3 = {
		algorithm: checksumObject.algorithm === "sha256" ? "sha256" : (() => { throw new Error("checkpoint.checksum.algorithm must be sha256"); })(),
		value: sha256(checksumObject.value, "checkpoint.checksum.value"),
	};
	const { checksum: _ignored, ...body } = object;
	if (digest(body).value !== checksum.value) throw new Error("checkpoint checksum mismatch");
	return structuredClone(object) as unknown as GoalRuntimeCheckpointV3<TState>;
}

export type GoalHookTarget = "goal" | "session" | "tool" | "node" | "evaluation" | "error";
export type GoalHookPhase = "pre" | "post";

export interface GoalHookContextV3 {
	target: GoalHookTarget;
	phase: GoalHookPhase;
	lineage: GoalLineageV3;
	operation: string;
	payload: Readonly<Record<string, unknown>>;
	result?: unknown;
	error?: GoalErrorV3;
}

export interface GoalRuntimeHookV3 {
	id: string;
	target: GoalHookTarget;
	phase: GoalHookPhase;
	order?: number;
	run(context: GoalHookContextV3): void | { deny: true; reason: string };
}

export class GoalRuntimeHooksV3 {
	private readonly hooks: GoalRuntimeHookV3[] = [];

	register(hook: GoalRuntimeHookV3): void {
		if (this.hooks.some((candidate) => candidate.id === hook.id)) throw new Error(`duplicate hook id '${hook.id}'`);
		this.hooks.push(hook);
		this.hooks.sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
	}

	run(context: GoalHookContextV3): { ok: true; executed: string[] } | { ok: false; executed: string[]; error: GoalErrorV3 } {
		const executed: string[] = [];
		for (const hook of this.hooks) {
			if (hook.target !== context.target || hook.phase !== context.phase) continue;
			try {
				const decision = hook.run({ ...context, payload: Object.freeze(structuredClone(context.payload)) });
				executed.push(hook.id);
				if (decision?.deny) {
					return { ok: false, executed, error: createGoalError("policy_denied", decision.reason, { details: { hookId: hook.id } }) };
				}
			} catch (error) {
				return { ok: false, executed, error: createGoalError("internal", `Hook '${hook.id}' failed.`, { cause: classifyGoalError(error), details: { hookId: hook.id } }) };
			}
		}
		return { ok: true, executed };
	}
}

function isGoalError(value: unknown): value is GoalErrorV3 {
	if (!value || typeof value !== "object") return false;
	const object = value as Partial<GoalErrorV3>;
	return typeof object.code === "string" && typeof object.message === "string"
		&& typeof object.retryable === "boolean" && typeof object.recovery === "string";
}

function scopeMatches(granted: string, requested: string): boolean {
	if (granted === "*") return true;
	if (granted.endsWith("/**")) {
		const prefix = granted.slice(0, -3).replace(/\/$/, "");
		return requested === prefix || requested.startsWith(prefix + "/");
	}
	return granted === requested;
}

function digest(value: unknown): GoalDigestV3 {
	return { algorithm: "sha256", value: createHash("sha256").update(stableJson(value)).digest("hex") };
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		// Checkpoints are persisted through JSON. Match JSON's omission of
		// undefined object properties so an in-memory checkpoint and its
		// session-restored representation have the same digest.
		return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function nullableString(value: unknown, path: string): string | null {
	return value === null ? null : stringValue(value, path);
}

function positiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${path} must be a positive safe integer`);
	return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be a finite non-negative number`);
	return value;
}

function sha256(value: unknown, path: string): string {
	const text = stringValue(value, path);
	if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} must be a lowercase sha256 digest`);
	return text;
}
