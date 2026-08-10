import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGoalError, createInitialRuntimeMetadataV3, type GoalAttemptV3, type GoalLineageV3, type GoalRunV3 } from "../extensions/goal-contract-v3";
import {
	GoalRuntimeHooksV3,
	authorizeGoalOperation,
	classifyGoalError,
	createGoalEventV3,
	createGoalRuntimeCheckpointV3,
	decideGoalRetry,
	deserializeGoalRuntimeCheckpointV3,
	prepareGoalSideEffect,
	rolloverGoalAttempt,
	rolloverRuntimeAttempt,
	serializeGoalRuntimeCheckpointV3,
	settleGoalSideEffect,
	type GoalApprovalRecordV3,
	type GoalSideEffectJournalEntryV3,
} from "../extensions/runtime-v3";

const lineage: GoalLineageV3 = {
	goalDefinitionId: "goal-1",
	revisionId: "goal-1:revision:1",
	runId: "goal-1:run:1",
	attemptId: "goal-1:run:1:attempt:1",
};

describe("Goal Runtime V3 retry and attempt policy", () => {
	it("classifies 429, provider abort, worker crash, timeout, and content failures", () => {
		assert.equal(classifyGoalError({ status: 429, message: "Too many requests" }).code, "rate_limit");
		assert.equal(classifyGoalError(new Error("provider abort from upstream")).code, "provider_abort");
		assert.equal(classifyGoalError(new Error("worker process crashed")).code, "worker_crash");
		assert.equal(classifyGoalError(new Error("timed out after 2s")).code, "timeout");
		assert.equal(classifyGoalError(new Error("verification check failed")).code, "verification_failed");
	});

	it("retries infrastructure in a fresh attempt but revises content and waits for approval", () => {
		const retry = decideGoalRetry(createGoalError("rate_limit", "429"), { attemptNumber: 1, retryAfterMs: 30_000 });
		assert.deepEqual({ action: retry.action, delayMs: retry.delayMs, consumesAttempt: retry.consumesAttempt }, {
			action: "retry_attempt", delayMs: 30_000, consumesAttempt: true,
		});
		assert.equal(decideGoalRetry(createGoalError("verification_failed", "bad output"), { attemptNumber: 1 }).action, "create_revision");
		assert.equal(decideGoalRetry(createGoalError("approval_required", "approval"), { attemptNumber: 1 }).action, "wait_approval");
		assert.equal(decideGoalRetry(createGoalError("rate_limit", "429"), { attemptNumber: 5 }).action, "wait_user");
	});

	it("bounds schema repair without consuming infrastructure attempts", () => {
		assert.equal(decideGoalRetry(createGoalError("schema_invalid", "bad JSON"), { attemptNumber: 1, schemaRepairCount: 0 }).action, "repair_schema");
		assert.equal(decideGoalRetry(createGoalError("schema_invalid", "bad JSON"), { attemptNumber: 1, schemaRepairCount: 2 }).action, "create_revision");
	});

	it("rolls stable attempt lineage without creating a new revision", () => {
		const runtime = createInitialRuntimeMetadataV3({ goalId: "goal-1", entrypoint: "interactive" });
		const next = rolloverRuntimeAttempt(runtime);
		assert.equal(next.revisionId, runtime.revisionId);
		assert.equal(next.attemptNumber, 2);
		assert.equal(next.previousAttemptId, runtime.attemptId);
		assert.equal(next.attemptId, "goal-1:run:1:attempt:2");

		const run: GoalRunV3 = {
			id: lineage.runId, goalDefinitionId: lineage.goalDefinitionId, revisionId: lineage.revisionId,
			entrypoint: "interactive", status: "active", attemptIds: [lineage.attemptId], currentAttemptId: lineage.attemptId,
			parentRunId: null, previousRunId: null, createdAt: 1, updatedAt: 1, endedAt: null,
		};
		const attempt: GoalAttemptV3 = {
			id: lineage.attemptId, runId: lineage.runId, revisionId: lineage.revisionId, number: 1,
			previousAttemptId: null, status: "active", idempotencyKey: lineage.attemptId, startedAt: 1, endedAt: null,
		};
		const rolled = rolloverGoalAttempt({ run, attempt, now: 2 });
		assert.equal(rolled.run.currentAttemptId, `${lineage.runId}:attempt:2`);
		assert.deepEqual(rolled.run.attemptIds, [lineage.attemptId, `${lineage.runId}:attempt:2`]);
	});
});

describe("Goal Runtime V3 events, checkpoint, and side effects", () => {
	it("creates the standardized causal event envelope", () => {
		const event = createGoalEventV3({ lineage, seq: 7, type: "tool.completed", time: 10, nodeId: "node-a", parentId: "event-6", causationId: "event-2", payload: { ok: true } });
		assert.deepEqual(Object.keys(event), [
			"schemaVersion", "eventId", "seq", "goalId", "revisionId", "runId", "attemptId", "nodeId", "parentId", "causationId", "type", "time", "payload",
		]);
		assert.equal(event.eventId, `${lineage.runId}:event:7`);
	});

	it("checksums checkpoint state, artifact receipts, approvals, and side-effect journal", () => {
		const checkpoint = createGoalRuntimeCheckpointV3({
			lineage,
			state: { frontier: ["node-b"] },
			artifacts: [{ id: "a1", uri: "result.md", digest: { algorithm: "sha256", value: "a".repeat(64) }, sizeBytes: 10, verifiedAt: 5 }],
			approvals: [],
			sideEffects: [],
			lastEventSeq: 7,
			createdAt: 10,
		});
		const restored = deserializeGoalRuntimeCheckpointV3<{ frontier: string[] }>(serializeGoalRuntimeCheckpointV3(checkpoint));
		assert.deepEqual(restored.state.frontier, ["node-b"]);
		const forged = JSON.parse(serializeGoalRuntimeCheckpointV3(checkpoint));
		forged.state.frontier = ["node-c"];
		assert.throws(() => deserializeGoalRuntimeCheckpointV3(JSON.stringify(forged)), /checksum mismatch/);
	});

	it("prevents blind duplicate side effects after a crash and replays committed results", () => {
		const journal: GoalSideEffectJournalEntryV3[] = [];
		const first = prepareGoalSideEffect({ journal, idempotencyKey: "mail-1", operation: "send", resource: "mailbox://ops", request: { body: "x" }, attemptId: lineage.attemptId, now: 1 });
		assert.equal(first.action, "execute");
		const afterCrash = prepareGoalSideEffect({ journal, idempotencyKey: "mail-1", operation: "send", resource: "mailbox://ops", request: { body: "x" }, attemptId: lineage.attemptId, now: 2 });
		assert.equal(afterCrash.action, "reconcile", "prepared state is not blindly executed after resume");
		if (first.action !== "execute") return;
		journal[0] = settleGoalSideEffect(first.entry, { response: { messageId: "m1" }, now: 3 });
		const replay = prepareGoalSideEffect({ journal, idempotencyKey: "mail-1", operation: "send", resource: "mailbox://ops", request: { body: "x" }, attemptId: lineage.attemptId, now: 4 });
		assert.equal(replay.action, "replay");
		const conflict = prepareGoalSideEffect({ journal, idempotencyKey: "mail-1", operation: "send", resource: "mailbox://ops", request: { body: "changed" }, attemptId: lineage.attemptId, now: 5 });
		assert.equal(conflict.action, "conflict");
	});
});

describe("Goal Runtime V3 capability, approval, and deterministic hooks", () => {
	const grants = [{ capability: "filesystem.write", scopes: ["docs/**"], source: "repository" as const }];
	const approval: GoalApprovalRecordV3 = {
		id: "approval-1", revisionId: lineage.revisionId, capability: "filesystem.write", scope: "docs/**",
		decision: "granted", requestedAt: 1, decidedAt: 2, decidedBy: "user-1",
	};

	it("separates capability denial from approval waiting", () => {
		const denied = authorizeGoalOperation({ capability: "network.write", scope: "https://example.test", revisionId: lineage.revisionId, grants, approvals: [], requiresApproval: false });
		assert.equal(denied.allowed, false);
		if (!denied.allowed) assert.equal(denied.error.code, "policy_denied");
		const waiting = authorizeGoalOperation({ capability: "filesystem.write", scope: "docs/a.md", revisionId: lineage.revisionId, grants, approvals: [], requiresApproval: true });
		assert.equal(waiting.allowed, false);
		if (!waiting.allowed) assert.equal(waiting.error.code, "approval_required");
		const allowed = authorizeGoalOperation({ capability: "filesystem.write", scope: "docs/a.md", revisionId: lineage.revisionId, grants, approvals: [approval], requiresApproval: true });
		assert.equal(allowed.allowed, true);
	});

	it("runs pre/post hooks in stable order and fails closed on denial", () => {
		const order: string[] = [];
		const hooks = new GoalRuntimeHooksV3();
		hooks.register({ id: "b", target: "tool", phase: "pre", order: 10, run: () => { order.push("b"); } });
		hooks.register({ id: "a", target: "tool", phase: "pre", order: 10, run: () => { order.push("a"); } });
		hooks.register({ id: "deny", target: "tool", phase: "pre", order: 20, run: () => ({ deny: true, reason: "blocked by policy" }) });
		const result = hooks.run({ target: "tool", phase: "pre", lineage, operation: "write", payload: { path: "docs/a.md" } });
		assert.deepEqual(order, ["a", "b"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "policy_denied");
	});
});
