/**
 * pi-goal — Persistent autonomous goals for Pi Agent
 *
 * Inspired by Claude Code /goal and Codex /goal.
 * Features:
 *   - LLM Judge evaluation after each turn
 *   - Criteria-based completion with per-criterion evidence
 *   - No-progress detection with auto-pause
 *   - Goal draft review flow (propose → review → start/edit/cancel)
 *   - Token budget tracking
 *   - Session entry persistence (survives compaction, reload, /tree)
 *   - Status bar footer
 *   - User-input auto-suspension
 *
 * Install: pi install git:github.com/<user>/pi-goal
 * Or local: pi install .
 */

import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
// 0.83: the legacy `complete` moved to the official compat entrypoint.
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { loadGoalConfig, DEFAULT_GOAL_CONFIG, parseModelSpec, buildEscalationPrompt, isSubagentSession, canResumeGoal, taskRoutingBlock, injectSuperpowersCoding, canComplete, taskGovernanceBlock, executionDecisionBlock, validateGoalProposal, assessEvidence, extractReviewerFindings, verifyReviewerSource, downgradeEnvironmentStateGates, type GoalConfig } from "./config";
import { runVerifyCommand, type VerifyResult } from "./verify-command";
import {
	createGoalSnapshotV2,
	createGoalStateV2,
	decodeGoalSnapshot,
	SHADOW_COMPLETION_ADVISORY,
	type AssuranceDecision,
	type CompletionEvaluation,
	type CompletionFinding,
	type DeviationRecord,
	type EvidenceRef,
	type ExecutionDecision,
	type ExecutionPreference,
	type GateLevel,
	type GoalSnapshotActionV2,
	type GoalSnapshotV2,
	type GoalStateV2,
	type ResearchClaim,
	type StoredGoalCriterionV2,
	type TaskKind,
	TASK_KINDS,
} from "./state";
import { ExactTurnAccounting, type TurnIdentity } from "./turn-accounting";
import { routeExecution, type ExecutionRoutingSignals } from "./execution-router-v2";
import { computeBlueprintEvidenceDiagnostics, rejectionFingerprint, selectReviewerPolicy, validateCompletionPolicy } from "./completion-policy-v2";
import { buildBoundedEvidencePacket, completionDecisionToEvaluation } from "./goal-integration-v2";
import {
	applyAuthoritativeCompletionEvaluation,
	applyShadowCompletionEvaluation,
	buildV2JudgePrompt,
	hasPendingCompletionRequest,
	parseV2JudgeResponse,
	V2_JUDGE_SYSTEM_PROMPT,
} from "./completion-runtime-v2";
import { normalizeUpdateGoalAction } from "./update-goal-action-v2";
import { GOAL_HEADLESS_EVENT_TYPE, appendGoalEventLog, appendGoalLog, createGoalFromBlueprint, finalizeHeadlessGoal, snapshotActiveHeadlessGoal, summarizeValue, validateBlueprint } from "./headless";
import { inspectCommittedArtifactsV3, prepareCompletionBundleV3, preflightCompletionSubmissionV3 } from "./completion-bundle-v3-runtime";
import { completionBundleDigest, type GoalErrorV3 } from "./goal-contract-v3";
import { resolveRoleResultFromBranch, type RoleResultRefV1 } from "./role-result-v1";
import { proposalToMarkdown, parseGoalSpecMarkdown, parseBlueprint, slugifyTitle, type SpecCriterion } from "./spec-doc";
import { runJudge, runV2CompletionJudge, type JudgeVerdict } from "./judge";
import { formatTokens, formatDuration, escapeXml, extractOutputTokens, extractTextContent, isAssistantMessage, GOAL_STORAGE_TYPE, GOAL_EVENT_TYPE, GOAL_CONTINUATION_TYPE, GOAL_JUDGE_TYPE } from "./util";
import { buildCriteriaBlock, completionFeedbackBlock, reviewerTranscriptDecision, transcriptBindsFinding, assuranceAfterOutcomeMutation, isTerminalGoalStatus, legacyAcceptedEvaluation, reviewerTranscriptContractBlock, superpowersAdaptationBlock, superpowersDisciplineBlock, continuationPrompt, budgetLimitPrompt, goalSystemPrompt, requiresAtomicCompletionV3 } from "./prompt-blocks";
import { proposalToSpecInput, specDocToProposal, writeGoalSpecDoc, showGoalReview, type GoalCriterionDraft, type GoalProposal, type ReviewResult } from "./draft-review-ui";
import { mechanicallyVerifyEvidence } from "./evidence-verify";
import { appendGoalTelemetry, buildGoalTelemetryEntry, readGoalTelemetry } from "./telemetry";
import { appendTraceJsonl, GoalTraceCollectorV3, lastTraceEventSequenceV3 } from "./observability-v3";
import { createInitialRuntimeMetadataV3 } from "./goal-contract-v3";
import {
	classifyGoalError,
	createGoalEventV3,
	decideGoalRetry,
	authorizeGoalOperation,
	prepareGoalSideEffect,
	settleGoalSideEffect,
	GoalRuntimeHooksV3,
	createGoalRuntimeCheckpointV3,
	deserializeGoalRuntimeCheckpointV3,
	digestGoalValueV3,
	rolloverRuntimeAttempt,
	type GoalEventEnvelopeV3,
	type GoalApprovalRecordV3,
	type GoalSideEffectJournalEntryV3,
	type GoalCapabilityGrantV3,
	type GoalSideEffectAdapterV3,
} from "./runtime-v3";
import { buildGoalPublicViewV3 } from "./goal-contract-v3-adapter";
import {
	GoalRuntimeTracker,
	compactGoalProgress,
	deriveGoalProgress,
	outcomeSignature,
	renderCompactGoalProgress,
	renderGoalProgressLines,
	truncateDisplay,
	type GoalProgressSnapshot,
} from "./progress-model";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

type GoalState = GoalStateV2;
type Criterion = StoredGoalCriterionV2;
type GoalSnapshot = GoalSnapshotV2;
const GOAL_RUNTIME_EVENT_TYPE = "pi-goal:runtime-event-v3";

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
	// Per-resume-cycle auto-continuation cap. A goal that stalls (no progress)
	// for maxNoProgressTurns is paused; maxAutoTurns bounds a single run cycle.
	// Override per-environment via GOAL_MAX_AUTO_TURNS (large goals need more).
	maxAutoTurns: Number(process.env.GOAL_MAX_AUTO_TURNS) || 200,
	noProgressTokenThreshold: 50,
	maxNoProgressTurns: 2,
	minContinueIntervalMs: 3_000,
	// Goal-drift check cadence (auto turns). 0 disables.
	driftCheckIntervalTurns: Number(process.env.GOAL_DRIFT_CHECK_TURNS) || 6,
	// H1: cap a stuck-escalation model call so a hanging provider can't strand
	// the goal in 'active' forever (escalateStuck falls back to pause on timeout).
	escalateTimeoutMs: 30_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Utility Helpers
// ═══════════════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════════════
// Judge Service
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Goal Draft Review UI
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Main Extension
// ═══════════════════════════════════════════════════════════════════════

interface PiGoalRuntimeDependencies {
	complete: typeof complete;
	minContinueIntervalMs: number;
	now: () => number;
	setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
	setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
	runtimeHooks?: GoalRuntimeHooksV3;
	sideEffectAdapter?: GoalSideEffectAdapterV3;
}

function registerPiGoalExtension(pi: ExtensionAPI, dependencies: PiGoalRuntimeDependencies) {
	// 测试桩/最小宿主可能没有 registerFlag；headless 启动仅靠 flag 存在时生效。
	if (typeof pi.registerFlag === "function") {
		pi.registerFlag("goal-run", {
			description: "Headless: run a goal blueprint spec to completion (see docs/design/2026-08-06-headless-goal-blueprint.md)",
			type: "string",
		});
		pi.registerFlag("goal-output", {
			description: "Headless: result JSON path (default <spec>.result.json)",
			type: "string",
		});
		pi.registerFlag("goal-log", {
			description: "Headless: real-time JSONL log path (default <spec>.goal.jsonl)",
			type: "string",
		});
	}
	const nowMs = dependencies.now;
	const runtimeHooks = dependencies.runtimeHooks ?? new GoalRuntimeHooksV3();
	const sideEffectAdapter = dependencies.sideEffectAdapter;
	let goal: GoalState | null = null;
	let goalConfig: GoalConfig = DEFAULT_GOAL_CONFIG;
	let judgeParseFailures = 0;
	let userSuspended = false;
	let continuationQueued = false;
	// Set by session_shutdown so the queued sendContinuation microtask can
	// short-circuit before calling pi.sendMessage on a torn-down session.
	let shuttingDown = false;
	let snapshotRevision = 0;
	let reconstructionError: string | null = null;
	const turnAccounting = new ExactTurnAccounting();
	const progressRuntime = new GoalRuntimeTracker();
	let currentTurn: TurnIdentity | null = null;
	let lastOutcomeSignature: string | null = null;
	let lastAssistantText = "";
	// turn_end and agent_end can arrive in either order across PI host versions.
	// Keep legacy completion evaluation idempotent within one model turn.
	let legacyEvaluationHandledThisTurn = false;
	// Last judge verdict, surfaced in the goal card / /goal status so the user
	// can see why the goal is still running (CONTINUE) or was deemed done.
	let lastJudgeVerdict: JudgeVerdict | null = null;
	let wasGoalDriven = false;
	let runtimeCwd = process.cwd();
	let goalTrace: GoalTraceCollectorV3 | null = null;
	// GG-3: a fresh next-step suggestion from a stronger model, injected into the
	// next continuation when the goal stalled. Set by escalateStuck, consumed +
	// cleared by sendContinuation.
	let stuckSuggestion: string | null = null;
	// M2: module-level — runJudge sets it via onVerifyFail; sendContinuation
	// (closure) reads+clears it.
	let verifyFailNote: string | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	let footerTicker: ReturnType<typeof setInterval> | null = null;
	let observedRoleCatalog: string[] | null = null;
	let activeMaxAutoTurns = CONFIG.maxAutoTurns;
	let runtimeEventSeq = 0;
	let providerFailure: { error: GoalErrorV3; retryAfterMs?: number } | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let approvals: GoalApprovalRecordV3[] = [];
	let sideEffectJournal: GoalSideEffectJournalEntryV3[] = [];
	const sideEffectInFlight = new Set<string>();

	type ActiveGoalOperationFence = Readonly<{
		goalId: string;
		runId: string | null;
		attemptId: string | null;
		snapshotRevision: number;
	}>;

	function captureActiveGoalOperation(): ActiveGoalOperationFence | null {
		if (!goal || goal.status !== "active") return null;
		return {
			goalId: goal.id,
			runId: goal.runtime?.runId ?? null,
			attemptId: goal.runtime?.attemptId ?? null,
			snapshotRevision,
		};
	}

	function isActiveGoalOperation(fence: ActiveGoalOperationFence | null): boolean {
		return fence !== null
			&& goal?.status === "active"
			&& goal.id === fence.goalId
			&& (goal.runtime?.runId ?? null) === fence.runId
			&& (goal.runtime?.attemptId ?? null) === fence.attemptId
			&& snapshotRevision === fence.snapshotRevision;
	}

	function clearTimer() {
		if (continuationTimer) { clearTimeout(continuationTimer); continuationTimer = null; }
	}

	function clearRetryTimer() {
		if (retryTimer) { dependencies.clearTimeout(retryTimer); retryTimer = null; }
	}

	function clearFooterTicker() {
		if (footerTicker) { dependencies.clearInterval(footerTicker); footerTicker = null; }
	}

	function isTrusted(ctx: ExtensionContext): boolean {
		const fn = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
		// H2: fail CLOSED when isProjectTrusted is absent — verifyCommand (GG-1)
		// is arbitrary shell exec, so the trust gate must not degrade to 'trusted'
		// on older/custom pi builds lacking the isProjectTrusted surface.
		return typeof fn === "function" ? fn.call(ctx) : false;
	}

	/** Emit a display:false diagnostic entry so loop stalls are traceable
	 * across reload/compaction (console.error is lost on reload). */
	function diag(ctx: ExtensionContext, reason: string) {
		pi.sendMessage(
			{ customType: "pi-goal:diag", content: "[pi-goal] " + reason, display: false, details: { reason, autoTurnCount: goal?.autoTurnCount, noProgressCount: goal?.noProgressCount, status: goal?.status, userSuspended, hasPending: ctx.hasPendingMessages?.() } },
			{ triggerTurn: false },
		);
	}

	/** Persist one observed Goal event. Headless also writes the canonical JSONL projection. */
	function goalLog(
		ctx: ExtensionContext,
		type: string,
		payload: Record<string, unknown>,
		options: { nodeId?: string | null; parentId?: string | null; causationId?: string | null } = {},
	): GoalEventEnvelopeV3 | undefined {
		if (!goal) return;
		if (!goal.headless) return traceRuntimeEvent(type, payload, options);
		const entry = appendGoalEventLog(goal, type, payload, nowMs(), options);
		traceGoalEvent(entry);
		pi.sendMessage(
			{ customType: GOAL_HEADLESS_EVENT_TYPE, content: type, display: false, details: { event: entry } },
			{ triggerTurn: false },
		);
		return entry;
	}

	function traceGoalEvent(entry: GoalEventEnvelopeV3): void {
		if (!goal) return;
		runtimeEventSeq = Math.max(runtimeEventSeq, entry.seq);
		try {
			if (!goalTrace || goalTrace.traceId !== entry.goalId) goalTrace = new GoalTraceCollectorV3(entry.goalId, nowMs);
			const span = goalTrace.recordGoalEvent(entry);
			const tracePath = goal.headless?.logPath
				? goal.headless.logPath + ".trace.jsonl"
				: path.join(runtimeCwd, goalConfig.goalSpecDir ?? "docs/goals", "trace.jsonl");
			appendTraceJsonl(span, tracePath);
		} catch (error) {
			console.warn("[pi-goal] trace write failed:", error);
		}
	}

	function isGoalEventEnvelope(entry: unknown): entry is GoalEventEnvelopeV3 {
		if (!entry || typeof entry !== "object") return false;
		const candidate = entry as Partial<GoalEventEnvelopeV3>;
		return candidate.schemaVersion === 3
			&& typeof candidate.eventId === "string"
			&& typeof candidate.seq === "number"
			&& typeof candidate.runId === "string";
	}

	function traceRuntimeEvent(type: string, payload: Record<string, unknown>, options: { nodeId?: string | null; parentId?: string | null; causationId?: string | null } = {}): GoalEventEnvelopeV3 | undefined {
		if (!goal) return;
		const runtime = goal.runtime ?? createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: goal.headless ? "headless" : "interactive" });
		const entry = createGoalEventV3({
			lineage: {
				goalDefinitionId: runtime.goalDefinitionId,
				revisionId: runtime.revisionId,
				runId: runtime.runId,
				attemptId: runtime.attemptId,
			},
			seq: ++runtimeEventSeq,
			type,
			time: nowMs(),
			payload,
			nodeId: options.nodeId,
			parentId: options.parentId,
			causationId: options.causationId,
		});
		traceGoalEvent(entry);
		return entry;
	}

	function recordRuntimeEvent(type: string, payload: Record<string, unknown>, options: { nodeId?: string | null; parentId?: string | null; causationId?: string | null } = {}): GoalEventEnvelopeV3 | undefined {
		if (!goal) return;
		const entry = traceRuntimeEvent(type, payload, options);
		if (entry) {
			pi.appendEntry(GOAL_RUNTIME_EVENT_TYPE, entry);
			// Headless consumers must see the same runtime-control envelope that
			// produced the trace span. Keeping it in the canonical JSONL stream
			// prevents a control event from colliding with the following tool event.
			if (goal.headless?.logPath) {
				appendGoalLog(goal.headless.logPath, { v: 1, ts: entry.time, ...entry, ...entry.payload });
			}
		}
		return entry;
	}

	function currentRuntimeLineage() {
		if (!goal) return null;
		const runtime = goal.runtime ?? createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: goal.headless ? "headless" : "interactive" });
		return {
			goalDefinitionId: runtime.goalDefinitionId,
			revisionId: runtime.revisionId,
			runId: runtime.runId,
			attemptId: runtime.attemptId,
		};
	}

	function recordRuntimeControlEvent(type: string, payload: Record<string, unknown>): void {
		if (!goal) return;
		const lineage = currentRuntimeLineage();
		if (!lineage) return;
		const checkpoint = createGoalRuntimeCheckpointV3({
			lineage,
			state: { goalId: goal.id, status: goal.status, objective: goal.objective },
			artifacts: [],
			approvals: structuredClone(approvals),
			sideEffects: structuredClone(sideEffectJournal),
			lastEventSeq: runtimeEventSeq + 1,
			createdAt: nowMs(),
		});
		recordRuntimeEvent(type, { ...payload, checkpoint });
	}

	function runRuntimeHook(input: {
		target: "goal" | "session" | "tool" | "node" | "evaluation" | "error";
		phase: "pre" | "post";
		operation: string;
		payload: Record<string, unknown>;
		result?: unknown;
		error?: GoalErrorV3;
	}): GoalErrorV3 | null {
		const lineage = currentRuntimeLineage();
		if (!lineage) return null;
		const result = runtimeHooks.run({ ...input, lineage });
		if (result.ok) return null;
		return result.error;
	}

	function toolCapability(toolName: string, input: Record<string, unknown>): { capability: string; scope: string } | null {
		const normalizePathScope = (value: unknown): string => {
			if (typeof value !== "string" || !value.trim()) return "<unspecified>";
			const absolute = path.isAbsolute(value) ? value : path.resolve(runtimeCwd, value);
			const relative = path.relative(runtimeCwd, absolute).replaceAll(path.sep, "/");
			return relative && !relative.startsWith("..") ? relative : "external:" + absolute;
		};
		if (toolName === "write" || toolName === "edit") return { capability: "filesystem.write", scope: normalizePathScope(input.path ?? input.filePath) };
		if (toolName === "bash") return { capability: "process.exec", scope: typeof input.command === "string" ? input.command : "<unspecified>" };
		if (toolName === "spawn_role") return { capability: "agent.spawn", scope: typeof input.role === "string" ? input.role : "<unspecified>" };
		if (toolName === "dag_execute" || toolName === "workflow_execute") return { capability: "workflow.execute", scope: typeof input.workflowId === "string" ? input.workflowId : "<unspecified>" };
		return null;
	}

	function addApproval(input: { capability: string; scope: string; decidedBy: string }): GoalApprovalRecordV3 | null {
		if (!goal || !goal.runtime) return null;
		const approval: GoalApprovalRecordV3 = {
			id: `${goal.runtime.runId}:approval:${approvals.length + 1}`,
			revisionId: goal.runtime.revisionId,
			capability: input.capability,
			scope: input.scope,
			decision: "granted",
			requestedAt: nowMs(),
			decidedAt: nowMs(),
			decidedBy: input.decidedBy,
		};
		approvals.push(approval);
		recordRuntimeControlEvent("goal.approval_decided", { approval });
		return approval;
	}

	async function authorizeToolCall(event: { toolName: string; toolCallId: string; input: Record<string, unknown> }, ctx: ExtensionContext): Promise<{ block: boolean; reason?: string; terminate?: boolean }> {
		if (!goal || goal.status !== "active") return { block: false };
		const hookError = runRuntimeHook({ target: "tool", phase: "pre", operation: event.toolName, payload: { toolCallId: event.toolCallId, input: event.input } });
		if (hookError) {
			recordRuntimeEvent("tool.authorization_denied", { tool: event.toolName, toolCallId: event.toolCallId, error: hookError });
			return { block: true, reason: hookError.message, terminate: Boolean(goal.headless) };
		}
		const access = toolCapability(event.toolName, event.input);
		const grants = goalConfig.capabilityGrants;
		if (!access || !grants || grants.length === 0) return { block: false };
		const requiresApproval = goalConfig.approvalRequiredCapabilities?.includes(access.capability) === true;
		let authorization = authorizeGoalOperation({
			capability: access.capability,
			scope: access.scope,
			revisionId: goal.runtime?.revisionId ?? "legacy",
			grants,
			approvals,
			requiresApproval,
		});
		if (!authorization.allowed && authorization.error.code === "approval_required" && ctx.hasUI && ctx.ui?.confirm) {
			const approved = await ctx.ui.confirm("Approve Goal capability?", `${access.capability}\n${access.scope}`);
			if (approved) {
				addApproval({ capability: access.capability, scope: access.scope, decidedBy: "user" });
				authorization = authorizeGoalOperation({
					capability: access.capability,
					scope: access.scope,
					revisionId: goal.runtime?.revisionId ?? "legacy",
					grants,
					approvals,
					requiresApproval,
				});
			}
		}
		if (authorization.allowed) return { block: false };
		recordRuntimeEvent("tool.authorization_denied", { tool: event.toolName, toolCallId: event.toolCallId, capability: access.capability, scope: access.scope, error: authorization.error });
		if (authorization.error.code === "approval_required" && goal.status === "active") {
			updateState({ status: "paused", pausedReason: authorization.error.message }, ctx);
		}
		return { block: true, reason: authorization.error.message, terminate: Boolean(goal.headless) };
	}

	function withBlueprintEvidenceDiagnostics(evaluation: CompletionEvaluation): CompletionEvaluation {
		if (!goal?.blueprint?.evidence) return evaluation;
		const evidence = goal.blueprint.evidence;
		const diagnostics = computeBlueprintEvidenceDiagnostics({
			criteria: goal.criteria,
			claims: goal.claims,
			evidenceLedger: goal.evidenceLedger,
			evidenceSpecs: evidence.criteria ?? [],
			nodeSpecs: (evidence.nodes ?? []) as Parameters<typeof computeBlueprintEvidenceDiagnostics>[0]["nodeSpecs"],
		});
		return diagnostics.length === 0
			? evaluation
			: { ...evaluation, advisories: [...new Set([...evaluation.advisories, ...diagnostics])].sort() };
	}

	// ── runtime 活动日志（turn 内黑盒透明化）─────────────────────────────
	// 外部 agent 需要区分"卡死"与"大任务进行中"：tool_started/tool_ended 记录
	// 每次工具调用，llm_response 记录每轮模型响应，heartbeat 保证最长 30s 必有
	// 信号（含当前 phase 与距上次活动时间）。
	const headlessToolStarts = new Map<string, { name: string; startedAt: number; eventId?: string }>();
	const headlessSubagents = new Map<string, {
		parentToolCallId: string;
		startEventId?: string;
		role?: string;
		sessionFile?: string;
		phase: string;
		turnCount: number;
		tool?: string;
		lastActivityAt: number;
	}>();
	let headlessHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

	function syncHeadlessHeartbeat(ctx: ExtensionContext): void {
		if (headlessHeartbeatTimer) {
			dependencies.clearInterval(headlessHeartbeatTimer);
			headlessHeartbeatTimer = null;
		}
		if (!goal?.headless || goal.status !== "active") return;
		headlessHeartbeatTimer = dependencies.setInterval(() => {
			if (!goal?.headless || goal.status !== "active") { syncHeadlessHeartbeat(ctx); return; }
			const now = nowMs();
			const runtime = progressRuntime.snapshot();
			const progress = progressFor(goal, now);
			goalLog(ctx, "heartbeat", {
				phase: runtime.phase,
				label: runtime.label,
				thinkingMs: runtime.turnStartedAt ? Math.max(0, now - runtime.turnStartedAt) : null,
				lastActivityMsAgo: runtime.lastActivityAt ? Math.max(0, now - runtime.lastActivityAt) : null,
				tokensUsed: goal.tokensUsed,
				activeMs: progress.resources.activeMs,
				subagents: [...headlessSubagents.entries()].map(([agentId, child]) => ({ agentId, ...child })),
			});
		}, 30_000);
		// unref 兜底：测试/无宿主场景下定时器不阻止进程退出（真实 pi 进程由
		// session_shutdown 显式清理，unref 只保证事件循环不被心跳卡住）。
		(headlessHeartbeatTimer as unknown as { unref?: () => void })?.unref?.();
	}

	const budgetWarnedThresholds = new Map<string, Set<number>>();
	/** 预算渐进提醒：50%/80%/90% 各一次（抄 Codex rollout_budget 的 reminder 思路）。 */
	function checkBudgetWarnings(ctx: ExtensionContext): void {
		if (!goal || !goal.headless || goal.tokenBudget == null || goal.tokensUsed <= 0) return;
		const percent = Math.floor((goal.tokensUsed / goal.tokenBudget) * 100);
		const warned = budgetWarnedThresholds.get(goal.id) ?? new Set<number>();
		for (const threshold of [50, 80, 90]) {
			if (percent >= threshold && !warned.has(threshold)) {
				warned.add(threshold);
				goalLog(ctx, "budget_warning", { tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget, percent: threshold });
			}
		}
		budgetWarnedThresholds.set(goal.id, warned);
	}

	/** Start a blueprint goal from a spec; the caller selects interactive or headless lifecycle semantics. */
	async function startGoalFromSpecPath(
		ctx: ExtensionContext,
		absolutePath: string,
		options: { confirmIfUI?: boolean; outputPath?: string; logPath?: string; entrypoint?: "headless" | "interactive" } = {},
	): Promise<{ ok: boolean; error?: string }> {
		let text: string;
		try {
			text = fs.readFileSync(absolutePath, "utf8");
		} catch {
			return { ok: false, error: "Cannot read spec file: " + absolutePath };
		}
		const parsed = parseGoalSpecMarkdown(text);
		if (!parsed.ok || !parsed.doc) return { ok: false, error: "Spec parse failed: " + (parsed.error ?? "unknown") };
		const rawBlueprint = (parsed.doc.machine as { blueprint?: unknown }).blueprint;
		const blueprintResult = parseBlueprint(rawBlueprint);
		if (!blueprintResult.ok) return { ok: false, error: "Blueprint invalid: " + blueprintResult.errors.join("; ") };
		const validation = validateBlueprint(blueprintResult.blueprint, parsed.doc, { trusted: isTrusted(ctx) });
		if (!validation.ok) return { ok: false, error: validation.errors.join("; ") };
		// Blueprint runtime settings are authoritative for this run regardless of entrypoint.
		goalConfig = {
			...goalConfig,
			...(blueprintResult.blueprint.completion?.policy ? { completionPolicy: blueprintResult.blueprint.completion.policy } : {}),
			...(blueprintResult.blueprint.verification?.command ? { verifyCommand: blueprintResult.blueprint.verification.command } : {}),
			...(blueprintResult.blueprint.verification?.timeoutMs ? { verifyTimeoutMs: blueprintResult.blueprint.verification.timeoutMs } : {}),
		};
		activeMaxAutoTurns = blueprintResult.blueprint.completion?.maxAutoTurns ?? CONFIG.maxAutoTurns;
		if (options.confirmIfUI && ctx.hasUI && goal) {
			const okConfirm = await ctx.ui.confirm(
				"Replace current goal?",
				"Starting a blueprint goal will replace the current goal (status: " + goal.status + ").",
			);
			if (!okConfirm) return { ok: false, error: "Cancelled by user." };
		}
		if (goal?.status === "active") {
			updateState({ status: "blocked", blocker: "Replaced by new goal" }, ctx);
		}
		const now = nowMs();
		const specBase = absolutePath.replace(/\.md$/i, "");
		const entrypoint = options.entrypoint ?? "headless";
		const newGoal = createGoalFromBlueprint({
			id: randomUUID(),
			doc: parsed.doc,
			blueprint: blueprintResult.blueprint,
			specPath: absolutePath,
			outputPath: options.outputPath ?? specBase + ".result.json",
			logPath: options.logPath ?? specBase + ".goal.jsonl",
			entrypoint,
			now,
		});
		goal = newGoal;
		providerFailure = null;
		clearRetryTimer();
		progressRuntime.reset(now, newGoal.progress.lastOutcomeDeltaAt);
		lastOutcomeSignature = outcomeSignature(newGoal);
		currentTurn = null;
		userSuspended = false;
		continuationQueued = false;
		persist("set");
		updateFooter(ctx);
		syncFooterTicker(ctx);
		syncHeadlessHeartbeat(ctx);
		syncTools();
		const startPayload = {
			objective: newGoal.objective,
			topology: newGoal.execution.selected,
			criteriaCount: newGoal.criteria.length,
			tokenBudget: newGoal.tokenBudget,
			entrypoint,
		};
		if (entrypoint === "headless") goalLog(ctx, "goal_started", startPayload);
		else recordRuntimeEvent("goal.started", startPayload);
		// 不立即 sendContinuation：headless print 模式下初始 prompt 的 run 可能已在
		// 处理中，此时 followUp 会被拒（"Agent is already processing"）。初始 turn
		// 结束后的 agent_end → scheduleContinuation 会自然启动续跑循环。
		// 交互式 /goal run 并没有正在执行的初始 prompt，必须主动排入首个 turn。
		if (entrypoint === "interactive") sendContinuation(ctx);
		return { ok: true };
	}

	/** headless 进程退出路径的收尾：不 pauseGoal（不是用户中断），如实写 result。幂等。 */
	const finalizedHeadlessGoals = new Set<string>();
	function isHeadlessPrintProcess(): boolean {
		const args = process.argv.slice(2);
		if (!args.includes("--goal-run")) return false;
		if (args.includes("-p") || args.includes("--print")) return true;
		const modeIndex = args.indexOf("--mode");
		return args.includes("--mode=json") || (modeIndex >= 0 && args[modeIndex + 1] === "json");
	}

	function requestHeadlessShutdown(ctx: ExtensionContext): void {
		ctx.shutdown();
		// The current pi print-mode host does not bind ExtensionContext.shutdown,
		// so a completed goal can otherwise leave the process alive after writing
		// its terminal result. Keep the fallback limited to explicit headless print
		// invocations; RPC has a real shutdown handler and interactive sessions must
		// remain open.
		if (!ctx.hasUI && isHeadlessPrintProcess()) {
			const exitCode = goal?.status === "complete" ? 0 : 1;
			setImmediate(() => process.exit(exitCode));
		}
	}

	function finalizeHeadless(ctx: ExtensionContext): void {
		if (!goal?.headless || finalizedHeadlessGoals.has(goal.id)) return;
		finalizedHeadlessGoals.add(goal.id);
		clearTimer();
		const entry = finalizeHeadlessGoal(goal, nowMs(), ctx.cwd);
		if (isGoalEventEnvelope(entry)) traceGoalEvent(entry);
	}

	function snapshotActiveHeadless(ctx: ExtensionContext): void {
		if (!goal?.headless || goal.status !== "active") return;
		clearTimer();
		const entry = snapshotActiveHeadlessGoal(goal, nowMs(), ctx.cwd);
		if (isGoalEventEnvelope(entry)) traceGoalEvent(entry);
		pi.sendMessage(
			{ customType: GOAL_HEADLESS_EVENT_TYPE, content: "snapshot", display: false, details: { event: entry } },
			{ triggerTurn: false },
		);
	}

	function persist(action: GoalSnapshotActionV2, state: GoalState | null = goal, savedAt = nowMs()) {
		const nextRevision = snapshotRevision + 1;
		const snapshot = createGoalSnapshotV2({
			revision: nextRevision,
			savedAt,
			action,
			goal: state,
		});
		pi.appendEntry<GoalSnapshot>(GOAL_STORAGE_TYPE, snapshot);
		snapshotRevision = nextRevision;
	}

	const GOAL_TOOLS = ["get_goal", "update_goal", "propose_goal_draft"];

	function syncTools() {
		// ponytail: always-add, never-remove. The tools' execute() functions
		// handle the "no goal" case internally. This eliminates a timing
		// source: _refreshToolRegistry resets activeTools to built-ins,
		// and if syncTools removes get_goal/update_goal before the handler
		// can re-add them, the tools become permanently unavailable.
		// By only adding (never removing), the tools always stay active.
		const active = new Set(pi.getActiveTools());
		let changed = false;
		for (const name of GOAL_TOOLS) {
			if (!active.has(name)) { active.add(name); changed = true; }
		}
		if (changed) pi.setActiveTools(Array.from(active));
	}

	function liveActiveMs(state: GoalState, now: number): number {
		return state === goal && state.status === "active" && currentTurn
			? turnAccounting.effectiveElapsedMs(state.timeUsedMs, currentTurn, now)
			: state.timeUsedMs;
	}

	function progressFor(state: GoalState, now = nowMs()): GoalProgressSnapshot {
		return deriveGoalProgress(
			state,
			state === goal ? progressRuntime.snapshot() : null,
			{ now, activeMs: liveActiveMs(state, now) },
		);
	}

	function refreshOutcomeProgress(
		state: GoalState,
		now: number,
		evaluationChanged: boolean,
		preserveFreshEvaluation = false,
	): { state: GoalState; outcomeChanged: boolean; signature: string } {
		const nextSignature = outcomeSignature(state);
		let outcomeChanged = false;
		if (lastOutcomeSignature !== null && nextSignature !== lastOutcomeSignature) {
			outcomeChanged = true;
			const evaluationWasFresh = state.progress.lastEvaluatedOutcomeRevision === state.progress.outcomeRevision;
			const nextRevision = state.progress.outcomeRevision + 1;
			state = { ...state, progress: {
				outcomeRevision: nextRevision,
				lastOutcomeDeltaAt: now,
				lastEvaluatedOutcomeRevision: evaluationChanged || (preserveFreshEvaluation && evaluationWasFresh)
					? nextRevision
					: state.progress.lastEvaluatedOutcomeRevision,
			} };
		} else if (evaluationChanged) {
			state = { ...state, progress: {
				...state.progress,
				lastEvaluatedOutcomeRevision: state.progress.outcomeRevision,
			} };
		}
		return { state, outcomeChanged, signature: outcomeSignature(state) };
	}

	function updateFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!goal) {
			ctx.ui.setStatus("pi-goal", undefined);
			return;
		}
		const now = nowMs();
		ctx.ui.setStatus("pi-goal", renderCompactGoalProgress(progressFor(goal, now), 120));
	}

	function syncFooterTicker(ctx: ExtensionContext) {
		if (!ctx.hasUI || !goal || goal.status !== "active") {
			clearFooterTicker();
			return;
		}
		if (!footerTicker) footerTicker = dependencies.setInterval(() => updateFooter(ctx), 1_000);
	}

	function settleCurrentTurnTime(now = nowMs()): boolean {
		if (!goal || !currentTurn || currentTurn.goalId !== goal.id) return false;
		const settled = turnAccounting.settleTime(currentTurn, now);
		if (!settled.applied) return false;
		goal.timeUsedMs += settled.elapsedMs;
		goal.updatedAt = now;
		return true;
	}

	const telemetryWritten = new Set<string>();
	function updateState(patch: Partial<GoalState>, ctx: ExtensionContext, options: { preserveFreshEvaluation?: boolean } = {}): boolean {
		let shutdownHeadless = false;
		if (!goal || isTerminalGoalStatus(goal.status)) return false;
		const now = nowMs();
		const previousEvaluation = JSON.stringify(goal.completion.lastEvaluation);
		const previousStatus = goal.status;
		const settlesCurrentTurn = Boolean(patch.status && patch.status !== "active" && currentTurn?.goalId === goal.id);
		const unsettledElapsedMs = settlesCurrentTurn && currentTurn
			? turnAccounting.activeElapsedMs(currentTurn, now)
			: 0;
		let candidate: GoalState = {
			...goal,
			...patch,
			updatedAt: now,
			...(unsettledElapsedMs === 0 ? {} : { timeUsedMs: goal.timeUsedMs + unsettledElapsedMs }),
		};
		if (patch.status) {
			candidate.endedAt = patch.status === "complete" || patch.status === "unmet" || patch.status === "blocked" || patch.status === "cancelled" ? now : null;
		}
		const progressUpdate = refreshOutcomeProgress(
			candidate,
			now,
			previousEvaluation !== JSON.stringify(candidate.completion.lastEvaluation),
			options.preserveFreshEvaluation === true,
		);
		candidate = progressUpdate.state;

		// Validate and append the complete candidate snapshot before making it the
		// live state. A rejected patch must not leak an uncommitted transaction or
		// consume an idempotency key in memory.
		persist("update", candidate, now);
		goal = candidate;
		lastOutcomeSignature = progressUpdate.signature;
		if (progressUpdate.outcomeChanged) progressRuntime.markOutcomeDelta(now);
		if (settlesCurrentTurn && currentTurn) {
			turnAccounting.settleTime(currentTurn, now);
			progressRuntime.turnEnded(now);
		}
		// Goal telemetry: 终态时记录一次（同 goalId 幂等），供策略校准。
		if (patch.status && (patch.status === "complete" || patch.status === "unmet" || patch.status === "blocked" || patch.status === "cancelled") && !telemetryWritten.has(goal.id)) {
			telemetryWritten.add(goal.id);
			const entry = buildGoalTelemetryEntry(goal, now);
			appendGoalTelemetry(entry, goalConfig.goalSpecDir ?? "docs/goals", ctx.cwd);
		}
		// Headless：状态变更日志 + 非 active 状态收尾（写 result + terminal 日志 + 退出码）。
		if (goal.headless && patch.status && patch.status !== previousStatus) {
			if (patch.status === "paused") goalLog(ctx, "paused", { reason: goal.pausedReason ?? "unknown" });
			else if (patch.status === "active" && previousStatus === "paused") goalLog(ctx, "resumed", {});
			else goalLog(ctx, "status", { status: goal.status, pausedReason: goal.pausedReason, blocker: goal.blocker });
			if (patch.status !== "active") {
				finalizeHeadless(ctx);
				if (goal.status !== "complete") process.exitCode = 1;
				shutdownHeadless = !ctx.hasUI;
			}
		}
		updateFooter(ctx);
		syncFooterTicker(ctx);
		syncHeadlessHeartbeat(ctx);
		syncTools();
		// Headless print/json sessions do not exit merely because a terminal
		// result was written. Request shutdown only after all terminal state and
		// timer cleanup has completed; interactive /goal run stays open.
		if (shutdownHeadless) requestHeadlessShutdown(ctx);
		return true;
	}

	function reassessGoalExecution(
		signals: ExecutionRoutingSignals,
		trigger: "scope_expanded" | "new_workstream" | "conflict" | "stalled",
	): { execution: ExecutionDecision | null; blockedReason: string | null } {
		if (!goal || !goal.execution.reassessOn.includes(trigger)) return { execution: null, blockedReason: null };
		const activeTools = new Set(pi.getActiveTools());
		const availableModes: Array<"direct" | "specialist" | "team"> = ["direct"];
		if (goal.execution.role && activeTools.has("spawn_role")) availableModes.push("specialist");
		if (activeTools.has("dag_execute")) availableModes.push("team");
		const routed = routeExecution({
			signals,
			availableModes,
			currentDecision: {
				mode: goal.execution.selected,
				status: "ready",
				source: goal.execution.source === "user" ? "user" : "auto",
				locked: goal.execution.source === "user",
				reasons: goal.execution.reasons,
				shouldReassess: goal.execution.source !== "user",
			},
		});
		if (routed.status === "blocked") return { execution: null, blockedReason: routed.reasons.join(" ") };
		if (routed.mode === goal.execution.selected) return { execution: null, blockedReason: null };
		return {
			execution: {
				...goal.execution,
				selected: routed.mode,
				...(routed.mode === "specialist" && goal.execution.role ? { role: goal.execution.role } : { role: undefined }),
				source: goal.execution.source === "user" ? "user" : "auto",
				confidence: Math.max(0.5, Math.min(0.9, goal.execution.confidence)),
				reasons: ["Runtime reassessment trigger: " + trigger + ".", ...routed.reasons],
			},
			blockedReason: null,
		};
	}

	function reconstruct(ctx: ExtensionContext) {
		goal = null;
		progressRuntime.reset(nowMs());
		lastOutcomeSignature = null;
		clearTimer();
		clearFooterTicker();
		currentTurn = null;
		snapshotRevision = 0;
		reconstructionError = null;
		lastAssistantText = "";
		legacyEvaluationHandledThisTurn = false;
		wasGoalDriven = false;
		continuationQueued = false;
		userSuspended = false;
		judgeParseFailures = 0;
		lastJudgeVerdict = null;
		runtimeEventSeq = 0;
		approvals = [];
		sideEffectJournal = [];
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== GOAL_STORAGE_TYPE) continue;
			const entryTimestampValue = (entry as unknown as { timestamp?: unknown }).timestamp;
			const entryTimestamp = typeof entryTimestampValue === "number"
				? entryTimestampValue
				: typeof entryTimestampValue === "string" ? Date.parse(entryTimestampValue) : undefined;
			const decoded = decodeGoalSnapshot((entry as { data?: unknown }).data, {
				entryTimestamp: entryTimestamp !== undefined && Number.isFinite(entryTimestamp) ? entryTimestamp : undefined,
				legacyRevision: index + 1,
			});
			if (!decoded.ok) {
				reconstructionError = decoded.message;
				ctx.ui?.notify?.("Goal state could not be restored safely: " + decoded.message, "error");
				return;
			}
				snapshotRevision = decoded.snapshot.revision;
				goal = decoded.snapshot.goal;
					if (goal) {
						progressRuntime.reset(nowMs(), goal.progress.lastOutcomeDeltaAt);
						lastOutcomeSignature = outcomeSignature(goal);
						for (const candidate of branch) {
			if (candidate.type !== "custom" || candidate.customType !== GOAL_RUNTIME_EVENT_TYPE) continue;
			const data = (candidate as { data?: Partial<GoalEventEnvelopeV3> }).data;
			if (!data) continue;
							const seq = data?.seq;
							if (data?.runId === goal.runtime?.runId && typeof seq === "number" && Number.isSafeInteger(seq)) {
								runtimeEventSeq = Math.max(runtimeEventSeq, seq);
								if (data.type === "goal.approval_decided" || data.type === "goal.side_effect_prepared" || data.type === "goal.side_effect_settled") {
									const rawCheckpoint = data.payload?.checkpoint;
									if (!rawCheckpoint || typeof rawCheckpoint !== "object") {
										reconstructionError = "Runtime control event is missing its checkpoint.";
									goal = null;
									return;
									}
									try {
										const checkpoint = deserializeGoalRuntimeCheckpointV3(JSON.stringify(rawCheckpoint));
										const runtimeLineage = currentRuntimeLineage();
										if (!runtimeLineage
											|| checkpoint.lineage.goalDefinitionId !== runtimeLineage.goalDefinitionId
											|| checkpoint.lineage.revisionId !== runtimeLineage.revisionId
											|| checkpoint.lineage.runId !== runtimeLineage.runId
											|| checkpoint.lineage.attemptId !== runtimeLineage.attemptId) throw new Error("checkpoint lineage does not match the active Goal run");
										if (checkpoint.lastEventSeq !== data.seq) throw new Error("checkpoint sequence does not match its runtime event");
										approvals = structuredClone(checkpoint.approvals);
										sideEffectJournal = structuredClone(checkpoint.sideEffects);
									} catch (error) {
										reconstructionError = "Runtime control checkpoint rejected: " + (error instanceof Error ? error.message : String(error));
										goal = null;
										return;
									}
								}
								// The verified checkpoint contains the complete control state for
								// this event. Do not replay the event payload a second time;
								// doing so would duplicate approvals and prepared entries.
							}
						}
						const tracePath = goal.headless?.logPath
							? goal.headless.logPath + ".trace.jsonl"
							: path.join(ctx.cwd, goalConfig.goalSpecDir ?? "docs/goals", "trace.jsonl");
						runtimeEventSeq = Math.max(runtimeEventSeq, lastTraceEventSequenceV3(tracePath, goal.runtime?.runId ?? ""));
					}
				return;
		}
	}

	function setGoal(
		proposal: GoalProposal,
		opts: { tokenBudget?: number | null }, ctx: ExtensionContext,
	): GoalState {
		const now = nowMs();
		if (goal?.status === "active") {
			updateState({ status: "blocked", blocker: "Replaced by new goal" }, ctx);
		}
		const goalId = randomUUID();
		const newGoal = createGoalStateV2({
			id: goalId,
			objective: proposal.objective,
			criteria: proposal.criteria.map((criterion) => ({ id: "c" + randomUUID().slice(0, 6), ...criterion })),
			constraints: proposal.constraints,
			taskKind: proposal.taskKind,
			execution: proposal.execution,
			assurance: proposal.assurance,
			tokenBudget: opts.tokenBudget,
			runtime: createInitialRuntimeMetadataV3({ goalId, entrypoint: "interactive" }),
			now,
		});
		newGoal.claims = proposal.claims.map((claim) => ({ ...claim, evidenceRefs: [...claim.evidenceRefs] }));
		goal = newGoal;
		providerFailure = null;
		approvals = [];
		sideEffectJournal = [];
		clearRetryTimer();
		runtimeEventSeq = 0;
		recordRuntimeEvent("goal.started", { objective: newGoal.objective, entrypoint: "interactive" });
		progressRuntime.reset(now, newGoal.progress.lastOutcomeDeltaAt);
		lastOutcomeSignature = outcomeSignature(newGoal);
		currentTurn = null;
		userSuspended = false;
		continuationQueued = false;
		persist("set");
		updateFooter(ctx);
		syncFooterTicker(ctx);
		syncTools();
		sendContinuation(ctx);
		return newGoal;
	}

	function pauseGoal(reason: string, ctx: ExtensionContext): boolean {
		if (!goal || goal.status !== "active") return false;
		clearRetryTimer();
		updateState({ status: "paused", pausedReason: reason }, ctx);
		if (!goal.headless) recordRuntimeEvent("goal.paused", { reason });
		clearTimer();
		userSuspended = true;
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal paused: " + reason + "\n\nObjective: " + goal.objective, display: true, details: { kind: "paused", goal: { ...goal }, progress: progressFor(goal) } },
			{ triggerTurn: false },
		);
		return true;
	}

	function resumeGoal(ctx: ExtensionContext): boolean {
		if (!goal || !canResumeGoal(goal.status)) return false;
		const previousStatus = goal.status;
		clearRetryTimer();
		providerFailure = null;
		userSuspended = false;
		continuationQueued = false;
		// reset autoTurnCount: resume = user-granted new quota cycle (mirrors
		// setGoal). Without this, maxAutoTurns would re-trip immediately after
		// resume (autoTurnCount still >= cap) and the loop could never recover.
		// maxAutoTurns is now per-resume-cycle; no-progress remains the lifetime backstop.
		const resumedRuntime = previousStatus === "usage_limited"
			? rolloverRuntimeAttempt(goal.runtime ?? createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: goal.headless ? "headless" : "interactive" }))
			: goal.runtime;
		updateState({
			status: "active",
			noProgressCount: 0,
			autoTurnCount: 0,
			pausedReason: null,
			...(resumedRuntime ? { runtime: resumedRuntime } : {}),
		}, ctx);
		if (!goal.headless) recordRuntimeEvent("goal.resumed", {});
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal resumed.\n\nObjective: " + goal.objective, display: true, details: { kind: "resumed", goal: { ...goal }, progress: progressFor(goal) } },
			{ triggerTurn: false },
		);
		sendContinuation(ctx);
		return true;
	}

	function cancelGoal(reason: string, ctx: ExtensionContext): boolean {
		if (!goal || isTerminalGoalStatus(goal.status)) return false;
		clearTimer();
		clearRetryTimer();
		providerFailure = null;
		clearFooterTicker();
		userSuspended = true;
		continuationQueued = false;
		updateState({ status: "cancelled", pausedReason: reason, blocker: null }, ctx);
		if (!goal.headless) recordRuntimeEvent("goal.cancelled", { reason });
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal cancelled: " + reason + "\n\nObjective: " + goal.objective, display: true, details: { kind: "cancelled", goal: { ...goal }, progress: progressFor(goal) } },
			{ triggerTurn: false },
		);
		return true;
	}

	function clearGoal(ctx: ExtensionContext): boolean {
		if (!goal) return false;
		settleCurrentTurnTime();
		clearTimer();
		clearRetryTimer();
		providerFailure = null;
		clearFooterTicker();
		const oldGoal = goal;
		recordRuntimeEvent("goal.cleared", { runId: oldGoal.runtime?.runId ?? null });
		const oldProgress = progressFor(oldGoal);
		goal = null;
		progressRuntime.reset(nowMs());
		lastOutcomeSignature = null;
		currentTurn = null;
		userSuspended = false;
		continuationQueued = false;
		persist("clear");
		updateFooter(ctx);
		syncTools();
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal cleared.", display: true, details: { kind: "cleared", goal: oldGoal, progress: oldProgress } },
			{ triggerTurn: false },
		);
		return true;
	}

	function forkGoal(ctx: ExtensionContext): boolean {
		if (!goal) return false;
		settleCurrentTurnTime();
		clearTimer();
		const source = goal;
		const now = nowMs();
		const sourceApprovals = structuredClone(approvals);
		clearRetryTimer();
		providerFailure = null;
		const sourceRuntime = source.runtime ?? createInitialRuntimeMetadataV3({ goalId: source.id, entrypoint: "interactive" });
		const runId = `${sourceRuntime.runId}:fork:${randomUUID().slice(0, 8)}`;
		const forked = structuredClone(source);
		forked.status = "active";
		forked.tokensUsed = 0;
		forked.timeUsedMs = 0;
		forked.createdAt = now;
		forked.updatedAt = now;
		forked.endedAt = null;
		forked.noProgressCount = 0;
		forked.autoTurnCount = 0;
		forked.pausedReason = null;
		forked.blocker = null;
		forked.completion = { summary: null, requestedAt: null, lastEvaluation: null, rejectionHistory: [], rejectionCount: 0 };
		forked.progress = {
			outcomeRevision: source.progress.outcomeRevision + 1,
			lastOutcomeDeltaAt: now,
			lastEvaluatedOutcomeRevision: null,
		};
		forked.assurance = {
			...source.assurance,
			reviewStatus: source.assurance.reviewRequirement === "none" ? "not_required" : "pending",
			decidedAt: now,
		};
		forked.runtime = {
			...sourceRuntime,
			runId,
			attemptId: `${runId}:attempt:1`,
			attemptNumber: 1,
			entrypoint: "interactive",
			parentRunId: sourceRuntime.runId,
			previousRunId: sourceRuntime.runId,
			previousAttemptId: sourceRuntime.attemptId,
		};
		delete forked.completionTransaction;
		// An interactive fork must not overwrite the source headless result/log files.
		delete forked.headless;
		goal = forked;
		approvals = sourceApprovals;
		sideEffectJournal = [];
		runtimeEventSeq = 0;
		recordRuntimeEvent("goal.forked", { parentRunId: sourceRuntime.runId, previousAttemptId: sourceRuntime.attemptId });
		progressRuntime.reset(now, forked.progress.lastOutcomeDeltaAt);
		lastOutcomeSignature = outcomeSignature(forked);
		currentTurn = null;
		userSuspended = false;
		continuationQueued = false;
		persist("set");
		updateFooter(ctx);
		syncFooterTicker(ctx);
		syncTools();
		sendContinuation(ctx);
		return true;
	}

	async function editGoal(ctx: ExtensionContext): Promise<boolean> {
		if (!goal || !ctx.hasUI) return false;
		const source = goal;
		const proposal: GoalProposal = {
			objective: source.objective,
			criteria: source.criteria.map(({ description, level }) => ({ description, level })),
			constraints: [...source.constraints],
			claims: source.claims.map((claim) => ({ ...claim, evidenceRefs: [] })),
			taskKind: source.taskKind,
			executionPreference: source.execution.preference,
			execution: structuredClone(source.execution),
			assurance: structuredClone(source.assurance),
		};
		const markdown = proposalToMarkdown({ ...proposalToSpecInput(proposal), createdAt: nowMs() });
		const edited = await ctx.ui.editor("Edit active goal (creates a new revision):", markdown);
		if (!edited?.trim()) return false;
		const parsed = parseGoalSpecMarkdown(edited);
		if (!parsed.ok || !parsed.doc) {
			ctx.ui.notify("Goal edit rejected: " + (parsed.error ?? "parse failed"), "warning");
			return false;
		}
		const nextProposal = specDocToProposal(parsed.doc, proposal);
		if (nextProposal.criteria.length === 0) {
			ctx.ui.notify("Goal edit rejected: at least one criterion is required.", "warning");
			return false;
		}
		settleCurrentTurnTime();
		clearTimer();
		const now = nowMs();
		const previousRuntime = source.runtime ?? createInitialRuntimeMetadataV3({ goalId: source.id, entrypoint: "interactive" });
		const revisionNumber = previousRuntime.revisionNumber + 1;
		const revisionId = `${previousRuntime.goalDefinitionId}:revision:${revisionNumber}`;
		const runId = `${previousRuntime.goalDefinitionId}:run:${revisionNumber}`;
		const next = createGoalStateV2({
			id: source.id,
			objective: nextProposal.objective,
			criteria: nextProposal.criteria.map((criterion, index) => ({ id: `c${index + 1}`, ...criterion })),
			constraints: nextProposal.constraints,
			taskKind: nextProposal.taskKind,
			execution: nextProposal.execution,
			assurance: {
				...nextProposal.assurance,
				reviewStatus: nextProposal.assurance.reviewRequirement === "none" ? "not_required" : "pending",
				decidedAt: now,
			},
			tokenBudget: parsed.doc.machine.tokenBudget ?? source.tokenBudget,
			runtime: {
				...previousRuntime,
				revisionId,
				revisionNumber,
				runId,
				attemptId: `${runId}:attempt:1`,
				attemptNumber: 1,
				entrypoint: "interactive",
				parentRunId: previousRuntime.runId,
				previousRunId: previousRuntime.runId,
				previousAttemptId: previousRuntime.attemptId,
			},
			now,
		});
		next.claims = nextProposal.claims.map((claim) => ({ ...claim, evidenceRefs: [] }));
		goal = next;
		runtimeEventSeq = 0;
		recordRuntimeEvent("goal.revised", { previousRevisionId: previousRuntime.revisionId, previousRunId: previousRuntime.runId });
		progressRuntime.reset(now, next.progress.lastOutcomeDeltaAt);
		lastOutcomeSignature = outcomeSignature(next);
		currentTurn = null;
		userSuspended = false;
		continuationQueued = false;
		persist("set");
		updateFooter(ctx);
		syncFooterTicker(ctx);
		syncTools();
		sendContinuation(ctx);
		return true;
	}

	/** 构造续跑消息体（sendContinuation 与 headless 同步版共用）。
	 *  捕获并清空一次性注记（stuckSuggestion / verifyFailNote）。 */
	function buildContinuationBody(goal: GoalState, config: GoalConfig): string {
		let body = continuationPrompt(goal, config, activeMaxAutoTurns);
		const verifyFail = verifyFailNote;
		const suggestion = stuckSuggestion;
		verifyFailNote = null;
		stuckSuggestion = null;
		// Goal-drift check (audit P0): every DRIFT_CHECK_INTERVAL auto-turns, ask
		// the agent to compare recent work with the objective direction.
		if (goal.autoTurnCount > 0 && goal.autoTurnCount % CONFIG.driftCheckIntervalTurns === 0) {
			body = "<DRIFT-CHECK>\nCompare your recent work (last actions and recorded evidence) with the objective below. If the work has drifted off-target (wrong direction, wrong scope, solving a different problem), do NOT keep going: call update_goal({ action: \"pause\", reason: \"<what drifted and why>\" }) to report to the user. Otherwise continue; do not mention this check.\n</DRIFT-CHECK>\n\n" + body;
		}
		// M2: feed the verify-command failure back so the agent can see WHY
		// its tests failed (prevents a re-claim-completion loop).
		if (verifyFail) {
			body = "⚠ Verify command failed last turn — fix this before claiming completion:\n" + verifyFail + "\n\n---\n\n" + body;
		}
		// GG-3: if escalateStuck produced a fresh suggestion, prepend it.
		if (suggestion) {
			body = "💡 Stuck-escalation suggestion (from a stronger model — try this fresh approach next):\n" + suggestion + "\n\n---\n\n" + body;
		}
		return body;
	}

	/**
	 * Headless 同步续跑（print-mode 修复，2026-08-06）：
	 * print-mode 的 session.prompt() 只等当前 agent run 完成，run 结束后立即
	 * dispose——3s 定时器路径（scheduleContinuation）永远来不及触发，长 goal 会在
	 * agent 中途停止时被 dispose-abort 误判为 interrupted。
	 * 机制：agent_end 的 extension emit 窗口内 _isAgentRunActive 仍为 true
	 * （isStreaming=true），此时同步 pi.sendMessage(followUp) 会直接进入 agent
	 * 队列；agent loop 的 _handlePostAgentRun 在 emit 后检查 hasQueuedMessages，
	 * 队列非空 → agent.continue() → print-mode 继续等待。
	 * 不能走 queueMicrotask：微任务在 emit resolve 之后才执行，会错过检查窗口。
	 */
	function sendContinuationNow(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") return;
		if (userSuspended) return;
		if (continuationQueued) return;
		clearTimer();
		continuationQueued = true;
		// 注记捕获/清空由 buildContinuationBody 负责。
		// 护栏：与 scheduleContinuation 相同的 no-progress / maxAutoTurns 限制。
		if (goal.noProgressCount >= CONFIG.maxNoProgressTurns) {
			continuationQueued = false;
			pauseGoal("no progress for " + CONFIG.maxNoProgressTurns + " turns", ctx);
			return;
		}
		const maxAutoTurns = activeMaxAutoTurns;
		if (goal.autoTurnCount >= maxAutoTurns) {
			continuationQueued = false;
			pauseGoal("reached max auto-turns (" + maxAutoTurns + ")", ctx);
			return;
		}
		wasGoalDriven = true;
		pi.sendMessage(
			{ customType: GOAL_CONTINUATION_TYPE, content: buildContinuationBody(goal, goalConfig), display: false, details: { goalId: goal.id } },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		continuationQueued = false;
	}

	/** agent_end 尾部：headless 走同步续跑（print-mode 不退出），否则走定时器。 */
	function resumeGoalLoop(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") return;
		if (goal.headless) { sendContinuationNow(ctx); return; }
		scheduleContinuation(ctx);
	}

	type LegacyEvaluationOutcome = "active" | "complete" | "paused" | "aborted";

	/**
	 * Run the authoritative legacy judge exactly once for the current turn.
	 * This remains the compatibility path: deterministic verification first,
	 * then runJudge, then the persisted-evidence/reviewer canComplete gate.
	 */
	async function evaluateLegacyCompletion(
		responseText: string,
		ctx: ExtensionContext,
		precomputedVerification?: VerifyResult,
	): Promise<LegacyEvaluationOutcome> {
		const operation = captureActiveGoalOperation();
		if (!operation || !goal) return "aborted";
		legacyEvaluationHandledThisTurn = true;
		const completionPolicy = goalConfig.completionPolicy ?? "v2";
		const verification = precomputedVerification ?? (goalConfig.verifyCommand
			? await runVerifyCommand(goalConfig.verifyCommand, goalConfig.verifyTimeoutMs ?? 120_000)
			: undefined);
		if (!isActiveGoalOperation(operation) || !goal) return "aborted";

		progressRuntime.evaluationStarted(nowMs());
		updateFooter(ctx);
		const verdict = await runJudge(
			goal,
			responseText,
			ctx,
			pi,
			goalConfig,
			verification,
			dependencies.complete,
			(note) => { verifyFailNote = note; },
		);
		if (!isActiveGoalOperation(operation) || !goal) return "aborted";
		progressRuntime.evaluationEnded(nowMs());
		updateFooter(ctx);
		lastJudgeVerdict = verdict;

		if (ctx.signal?.aborted) {
			if (goal.headless) {
				snapshotActiveHeadless(ctx);
				process.exitCode = 1;
				return "aborted";
			}
			pauseGoal("interrupted", ctx);
			return "paused";
		}

		if (verdict.parseFailed) {
			judgeParseFailures += 1;
			if (judgeParseFailures >= 3) {
				pauseGoal("judge parse failures (3 consecutive)", ctx);
				ctx.ui.notify("\u23F8 Goal paused (judge parse failures).", "warning");
				return "paused";
			}
		} else {
			judgeParseFailures = 0;
		}

		if (completionPolicy === "legacy" && !verdict.done) {
			const findings = [{
				code: "external_blocker" as const,
				subjectId: "$goal",
				reason: verdict.reason,
			}];
			const evaluation: CompletionEvaluation = {
				decision: "revise",
				evaluatedAt: nowMs(),
				criterionCoverage: [],
				claimCoverage: [],
				findings,
				advisories: [],
				evaluator: { kind: "judge" },
				fingerprint: rejectionFingerprint(findings),
			};
			updateState({ completion: { ...goal.completion, lastEvaluation: evaluation } }, ctx);
			goalLog(ctx, "completion_evaluated", { decision: "revise", findings, advisories: [] });
		}

		if (!verdict.done) return "active";

		const gate = canComplete({
			criteria: goal.criteria
				.filter((criterion) => criterion.level === "blocking")
				.map((criterion) => ({ evidence: criterion.evidence.map((item) => item.summary) })),
			reviewRequired: goal.assurance.reviewRequirement === "required",
			reviewerPassed: goal.assurance.reviewStatus === "passed",
			reviewerVerdict: goal.assurance.reviewStatus === "passed" ? {} : undefined,
		});
		if (!gate.ok) {
			ctx.ui.notify("\u26A0\uFE0F Judge says done, but " + gate.reason + ". Continuing...", "warning");
			const uncovered = goal.criteria.filter((criterion) => criterion.level === "blocking" && criterion.evidenceRefs.length === 0);
			const findings = uncovered.length > 0
				? uncovered.map((criterion) => ({
					code: "blocking_requirement_unsatisfied" as const,
					subjectId: criterion.id,
					reason: "The legacy completion gate has no persisted evidence for this blocking criterion.",
					missingEvidenceKind: "observation" as const,
				}))
				: [{ code: "external_blocker" as const, subjectId: "$goal", reason: gate.reason ?? "Legacy completion gate rejected the goal." }];
			const evaluation: CompletionEvaluation = {
				decision: "revise",
				evaluatedAt: nowMs(),
				criterionCoverage: [],
				claimCoverage: [],
				findings,
				advisories: [],
				evaluator: { kind: "judge" },
				fingerprint: rejectionFingerprint(findings),
			};
			updateState({ completion: { ...goal.completion, lastEvaluation: evaluation } }, ctx);
			goalLog(ctx, "completion_evaluated", { decision: "revise", findings, advisories: [] });
			return "active";
		}

		const requestedAt = goal.completion.requestedAt ?? nowMs();
		const evaluatedAt = Math.max(nowMs(), requestedAt, (goal.completion.lastEvaluation?.evaluatedAt ?? -1) + 1);
		const keepShadowAudit = completionPolicy === "shadow"
			&& goal.completion.lastEvaluation?.advisories.includes(SHADOW_COMPLETION_ADVISORY);
		const lastEvaluation = keepShadowAudit
			? goal.completion.lastEvaluation
			: legacyAcceptedEvaluation(goal, verdict.reason, evaluatedAt);
		if (!updateState({
			status: "complete",
			completion: { ...goal.completion, summary: verdict.reason, requestedAt, lastEvaluation },
			noProgressCount: 0,
		}, ctx, { preserveFreshEvaluation: keepShadowAudit })) return "aborted";
		pi.sendMessage(
			{
				customType: GOAL_EVENT_TYPE,
				content: "Goal achieved! \u2705\n\nObjective: " + goal.objective + "\nJudge: " + verdict.reason + "\nTokens: " + formatTokens(goal.tokensUsed) + "\nTime: " + formatDuration(goal.timeUsedMs),
				display: true,
				details: { kind: "complete", goal: { ...goal, status: "complete" }, progress: progressFor(goal) },
			},
			{ triggerTurn: false },
		);
		return "complete";
	}

	function sendContinuation(ctx: ExtensionContext) {
		if (!goal || goal.status !== "active") { diag(ctx, "sendContinuation: skip (goal=" + (goal ? goal.status : "null") + ")"); return; }
		if (userSuspended) { diag(ctx, "sendContinuation: skip (userSuspended)"); return; }
		// M6: guard against two rapid sendContinuation calls (e.g. resumeGoal + an
		// async escalateStuck completion) queueing two continuation turns back-to-back.
		if (continuationQueued) { diag(ctx, "sendContinuation: skip (already queued)"); return; }
		clearTimer();
		continuationQueued = true;
		queueMicrotask(() => {
			// M6: consumed。注记捕获/清空由 buildContinuationBody 负责。
			continuationQueued = false;
			// session_shutdown sets this and clears the timer, but a microtask
			// already queued before shutdown still runs — without this guard it
			// would call pi.sendMessage on a torn-down session.
			if (shuttingDown) { wasGoalDriven = false; return; }
			if (!goal || goal.status !== "active") return;
			if (userSuspended) return;
			wasGoalDriven = true;
			// Re-check right before sending: a pause may have landed between
			// the guard above and this sendMessage.
			if (!goal || goal.status !== "active" || userSuspended) {
				wasGoalDriven = false;
				return;
			}
			pi.sendMessage(
				{ customType: GOAL_CONTINUATION_TYPE, content: buildContinuationBody(goal, goalConfig), display: false, details: { goalId: goal.id } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	/** GG-3: when the goal stalls and a stuckEscalateModel is configured (trusted
	 *  projects), ask that stronger model for ONE concrete next step and inject it
	 *  into the next continuation (via stuckSuggestion), resetting no-progress so
	 *  the goal gets another chance. Falls back to pause on any failure. */
	async function escalateStuck(ctx: ExtensionContext): Promise<void> {
		// H1+M4: the whole body is try-wrapped so any throw (find/getApiKey/
		// complete) falls back to pauseGoal instead of an unhandled rejection +
		// silent stall (scheduleContinuation returned without scheduling). The
		// complete() call passes timeoutMs so a hanging escalate model can't
		// strand the goal in 'active' forever.
		const operation = captureActiveGoalOperation();
		if (!operation) return;
		try {
			if (!goal || !goalConfig.stuckEscalateModel) {
				pauseGoal("no progress for " + CONFIG.maxNoProgressTurns + " turns", ctx);
				ctx.ui.notify("⏸ Goal paused (no progress). Use /goal resume to continue.", "warning");
				return;
			}
			const spec = parseModelSpec(goalConfig.stuckEscalateModel);
			const model = spec ? ctx.modelRegistry?.find?.(spec.provider, spec.modelId) : undefined;
			if (!model) {
				pauseGoal("stuck-escalation model not found: " + goalConfig.stuckEscalateModel, ctx);
				ctx.ui.notify("⏸ Goal paused (no progress; escalation model unavailable).", "warning");
				return;
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!isActiveGoalOperation(operation) || !goal) return;
			if (!auth.ok) {
				pauseGoal("stuck-escalation auth failed: " + auth.error, ctx);
				return;
			}
			const criteriaSummary = goal.criteria.map((c) => "  " + (c.evidence.length > 0 ? "✅" : "⏳") + " [" + c.id + "] " + c.description).join("\n");
			const result = await dependencies.complete(model, {
				systemPrompt: "You are a senior engineer unblocking a stalled autonomous agent. Reply with ONE concrete next step.",
				messages: [{ role: "user", content: [{ type: "text", text: buildEscalationPrompt({ objective: goal.objective, criteriaSummary }) }], timestamp: nowMs() }],
			}, { apiKey: auth.apiKey, headers: auth.headers, temperature: 0.4, maxTokens: 512, timeoutMs: CONFIG.escalateTimeoutMs });
			if (!isActiveGoalOperation(operation)) return;
			const suggestion = extractTextContent(result).trim();
			if (!suggestion) {
				pauseGoal("stuck-escalation returned no suggestion", ctx);
				return;
			}
			stuckSuggestion = suggestion;
			updateState({ noProgressCount: 0 }, ctx);
			ctx.ui.notify("🔁 Goal stuck — escalated to " + goalConfig.stuckEscalateModel + " for a fresh approach.", "info");
			sendContinuation(ctx);
		} catch (err) {
			if (!isActiveGoalOperation(operation)) return;
			pauseGoal("stuck-escalation failed: " + (err instanceof Error ? err.message : String(err)), ctx);
		}
	}

	function scheduleContinuation(ctx: ExtensionContext) {
		clearTimer();
		if (userSuspended) { diag(ctx, "scheduleContinuation: skip (userSuspended)"); return; }
		if (!goal || goal.status !== "active") { diag(ctx, "scheduleContinuation: skip (goal=" + (goal ? goal.status : "null") + ")"); return; }
		if (!ctx.isIdle() || ctx.hasPendingMessages()) { diag(ctx, "scheduleContinuation: skip (not idle / pending messages)"); return; }
		if (goal.noProgressCount >= CONFIG.maxNoProgressTurns) {
			const reroute = reassessGoalExecution({
				uncertainty: "high",
				coupling: "medium",
				risk: "low",
				specialistNeed: goal.execution.role ? "helpful" : "none",
				independentWorkstreams: goal.execution.selected === "team" ? 2 : 1,
				heterogeneousSkills: goal.execution.selected === "team",
				effort: "medium",
				repeatedFailureCount: goal.noProgressCount,
				remainingWorkstreams: goal.execution.selected === "team" ? 2 : 1,
			}, "stalled");
			if (reroute.execution) {
				updateState({ execution: reroute.execution, noProgressCount: 0 }, ctx);
				ctx.ui?.notify?.("Goal route changed to " + reroute.execution.selected + " after repeated stalled turns.", "info");
				sendContinuation(ctx);
				return;
			}
			// GG-3: if a stuckEscalateModel is configured, escalate to it for a fresh
			// next step instead of pausing (fire-and-forget; it pauses on failure).
			if (goalConfig.stuckEscalateModel) {
				diag(ctx, "scheduleContinuation: escalate (no progress " + goal.noProgressCount + ")");
				void escalateStuck(ctx);
				return;
			}
			diag(ctx, "scheduleContinuation: pause (no progress " + goal.noProgressCount + ")");
			pauseGoal("no progress for " + CONFIG.maxNoProgressTurns + " turns", ctx);
			ctx.ui.notify("\u23F8 Goal paused (no progress). Use /goal resume to continue.", "warning");
			return;
		}
		if (goal.autoTurnCount >= activeMaxAutoTurns) {
			diag(ctx, "scheduleContinuation: pause (max turns " + goal.autoTurnCount + "/" + activeMaxAutoTurns + ")");
			pauseGoal("reached max auto-turns (" + activeMaxAutoTurns + ")", ctx);
			ctx.ui.notify("\u23F8 Goal paused (max turns reached).", "info");
			return;
		}
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			if (!goal || goal.status !== "active") return;
			if (userSuspended) return;
			sendContinuation(ctx);
		}, dependencies.minContinueIntervalMs);
	}

	function retryAfterMilliseconds(headers: Record<string, string>): number | undefined {
		const raw = headers["retry-after"] ?? headers["Retry-After"];
		if (!raw) return undefined;
		const seconds = Number(raw);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
		const date = Date.parse(raw);
		return Number.isFinite(date) ? Math.max(0, date - nowMs()) : undefined;
	}

	/**
	 * PI's host owns the provider-level retry loop. The response hook can fire
	 * for an intermediate 429/5xx while that loop is still alive, so it only
	 * records the latest typed failure. This handler runs at agent_settled, when
	 * the host has exhausted its own retries, and applies Goal Runtime policy.
	 */
	function handleSettledProviderFailure(ctx: ExtensionContext): void {
		const failure = providerFailure;
		providerFailure = null;
		if (!failure || !goal || goal.status !== "active") return;
		const goalId = goal.id;
		const runId = goal.runtime?.runId ?? null;
		const attemptNumber = goal.runtime?.attemptNumber ?? 1;
		const decision = decideGoalRetry(failure.error, {
			attemptNumber,
			retryAfterMs: failure.retryAfterMs,
			policy: { ...(goalConfig.retryPolicy ?? {}), ...(goal.blueprint?.retry ?? {}) },
		});
		const reason = `${failure.error.code}: ${failure.error.message}`;
		if (decision.action === "retry_attempt") {
			clearTimer();
			clearRetryTimer();
			userSuspended = true;
			updateState({ pausedReason: `retrying attempt ${attemptNumber + 1}: ${reason}` }, ctx);
			const payload = {
				errorCode: failure.error.code,
				attemptNumber,
				nextAttemptNumber: attemptNumber + 1,
				delayMs: decision.delayMs,
				reason: decision.reason,
			};
			if (goal.headless) goalLog(ctx, "retry_scheduled", payload);
			else recordRuntimeEvent("goal.retry_scheduled", payload);
			retryTimer = dependencies.setTimeout(() => {
				retryTimer = null;
				if (!goal || goal.status !== "active" || goal.id !== goalId || (goal.runtime?.runId ?? null) !== runId) return;
				const runtime = goal.runtime ?? createInitialRuntimeMetadataV3({ goalId: goal.id, entrypoint: goal.headless ? "headless" : "interactive" });
				const nextRuntime = rolloverRuntimeAttempt(runtime);
				userSuspended = false;
				updateState({ runtime: nextRuntime, pausedReason: null }, ctx);
				if (!goal || goal.status !== "active") return;
				if (goal.headless) goalLog(ctx, "retry_attempt_started", {
					attemptNumber: nextRuntime.attemptNumber,
					attemptId: nextRuntime.attemptId,
				});
				else recordRuntimeEvent("goal.retry_attempt_started", {
					attemptNumber: nextRuntime.attemptNumber,
					attemptId: nextRuntime.attemptId,
				});
				sendContinuation(ctx);
			}, decision.delayMs);
			return;
		}

		clearTimer();
		clearRetryTimer();
		userSuspended = true;
		const payload = { errorCode: failure.error.code, attemptNumber, reason: decision.reason };
		if (goal?.headless) goalLog(ctx, "retry_exhausted", payload);
		else if (goal) recordRuntimeEvent("goal.retry_exhausted", payload);
		updateState({ status: "usage_limited", pausedReason: reason, noProgressCount: 0 }, ctx);
		if (ctx.hasUI) ctx.ui.notify("Goal retry limit reached: " + reason + ". Use /goal resume or revise the goal.", "warning");
	}

	// ═══════════════════════════════════════════════════════════════════
	// Events
	// ═══════════════════════════════════════════════════════════════════

	pi.on("session_start", async (_event, ctx) => {
		// Subagent sessions (in-process, spawned by @gotgenes/pi-subagents) reuse
		// this extension instance with a fresh SessionManager. Their empty branch
		// would make reconstruct() null out the parent's live `goal` closure
		// (held only here, not re-read from disk until the next reconstruct).
		// Short-circuit: leave the parent's closure untouched. The subagent runs
		// its own goal-less context.
		if (isSubagentSession(ctx)) return;
		shuttingDown = false;
		runtimeCwd = ctx.cwd;
		goalTrace = null;
		observedRoleCatalog = null;
		// Load project-local config (opt out of superpowers integration).
		goalConfig = loadGoalConfig(ctx.cwd, isTrusted(ctx));
		activeMaxAutoTurns = CONFIG.maxAutoTurns;
	reconstruct(ctx);
	syncTools();
	const goalRunFlag = typeof pi.getFlag === "function" ? pi.getFlag("goal-run") : undefined;
	let goalStartedFromFlag = false;
	if (typeof goalRunFlag === "string" && goalRunFlag.trim() && !goal) {
		const goalRunPath = goalRunFlag.trim();
		const absolutePath = path.isAbsolute(goalRunPath) ? goalRunPath : path.join(ctx.cwd, goalRunPath);
		const outputFlag = typeof pi.getFlag === "function" ? pi.getFlag("goal-output") : undefined;
		const logFlag = typeof pi.getFlag === "function" ? pi.getFlag("goal-log") : undefined;
		const resolvePath = (value: unknown): string | undefined => {
			if (typeof value !== "string" || !value.trim()) return undefined;
			const trimmed = value.trim();
			return path.isAbsolute(trimmed) ? trimmed : path.join(ctx.cwd, trimmed);
		};
		const started = await startGoalFromSpecPath(ctx, absolutePath, {
			confirmIfUI: false,
			outputPath: resolvePath(outputFlag),
			logPath: resolvePath(logFlag),
		});
		if (!started.ok) {
			console.error("[pi-goal] " + started.error);
			ctx.ui?.notify?.("Headless goal failed to start: " + started.error, "error");
			process.exitCode = 1;
		}
		goalStartedFromFlag = started.ok;
	}
	if (goal?.status === "active" && !goalStartedFromFlag) {
			updateState({ status: "paused", pausedReason: "session reload" }, ctx);
			ctx.ui.notify("\u23F8 Goal paused (session reload): " + goal.objective.slice(0, 80) + "\u2026\nUse /goal resume to continue.", "info");
		} else if (goal) {
			ctx.ui.notify("\uD83C\uDFAF Goal restored: " + goal.objective.slice(0, 80) + "\u2026 (" + goal.status + ")", "info");
		}
		updateFooter(ctx);
		syncFooterTicker(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => { if (isSubagentSession(ctx)) return; reconstruct(ctx); syncTools(); updateFooter(ctx); syncFooterTicker(ctx); });
	pi.on("session_shutdown", async (_event, ctx) => {
		if (isSubagentSession(ctx)) return;
		shuttingDown = true;
		clearTimer();
		clearRetryTimer();
		providerFailure = null;
		clearFooterTicker();
		if (headlessHeartbeatTimer) { dependencies.clearInterval(headlessHeartbeatTimer); headlessHeartbeatTimer = null; }
		if (settleCurrentTurnTime() && goal) persist("usage");
		if (goal?.headless && goal.status === "active") {
			// Active is an interim process snapshot, never a terminal result. A later
			// resumed/continued run may still produce the authoritative terminal file.
			snapshotActiveHeadless(ctx);
			process.exitCode = 1;
		}
		currentTurn = null;
		progressRuntime.turnEnded(nowMs());
		updateFooter(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (!goal || goal.status !== "active") return;
		if (event.status !== 429 && event.status < 500) {
			if (event.status >= 200 && event.status < 400) providerFailure = null;
			return;
		}
		const reason = event.status === 429 ? "provider rate limited (429)" : "provider error (" + event.status + ")";
		providerFailure = {
			error: classifyGoalError({ status: event.status, message: reason }),
			retryAfterMs: retryAfterMilliseconds(event.headers ?? {}),
		};
		if (goal.headless) goalLog(ctx, "provider_failure_observed", {
			status: event.status,
			retryAfterMs: providerFailure.retryAfterMs ?? null,
		});
		else recordRuntimeEvent("provider.failure_observed", {
			status: event.status,
			retryAfterMs: providerFailure.retryAfterMs ?? null,
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (isSubagentSession(ctx)) return;
		handleSettledProviderFailure(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isSubagentSession(ctx) || !goal || goal.status !== "active") return;
		const input = (event as unknown as { input?: Record<string, unknown> }).input ?? {};
		return authorizeToolCall({ toolName: event.toolName, toolCallId: event.toolCallId, input }, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (goal && goal.status === "active") {
			const hookError = runRuntimeHook({
				target: "tool",
				phase: "post",
				operation: event.toolName,
				payload: { toolCallId: event.toolCallId, input: event.input, isError: event.isError },
				result: event.details,
				error: event.isError ? classifyGoalError(event.content.map((item) => item.type === "text" ? item.text : "").join("\n")) : undefined,
			});
			if (hookError) recordRuntimeEvent("tool.post_hook_denied", { tool: event.toolName, toolCallId: event.toolCallId, error: hookError });
		}
		if (event.toolName !== "list_roles" || event.isError) return;
		const details = event.details && typeof event.details === "object"
			? event.details as { roles?: unknown }
			: null;
		let roles = details?.roles;
		if (!Array.isArray(roles)) {
			const text = event.content.find((item) => item.type === "text")?.text;
			if (text) {
				try { roles = (JSON.parse(text) as { roles?: unknown }).roles; } catch { roles = undefined; }
			}
		}
		if (!Array.isArray(roles)) return;
		const names = roles
			.map((item) => item && typeof item === "object" ? (item as { name?: unknown }).name : undefined)
			.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
			.map((name) => name.trim());
		observedRoleCatalog = [...new Set(names)].sort();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!goal || goal.status !== "active" || isSubagentSession(ctx)) return;
		// Reading the projection must not make the projection report itself as work.
		if (event.toolName === "get_goal") return;
		progressRuntime.toolStarted(event.toolCallId, event.toolName, event.args, nowMs());
		const startedAt = nowMs();
		const observed = goalLog(ctx, "tool_started", { tool: event.toolName, toolCallId: event.toolCallId, args: summarizeValue(event.args, 300) });
		headlessToolStarts.set(event.toolCallId, { name: event.toolName, startedAt, ...(observed ? { eventId: observed.eventId } : {}) });
		updateFooter(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (!goal || goal.status !== "active" || isSubagentSession(ctx)) return;
		progressRuntime.toolUpdated(event.toolCallId, event.toolName, event.partialResult, nowMs());
		const partial = event.partialResult && typeof event.partialResult === "object"
			? event.partialResult as { details?: unknown }
			: null;
		const details = partial?.details && typeof partial.details === "object"
			? partial.details as Record<string, unknown>
			: null;
		if (details?.kind === "subagent-progress" && typeof details.id === "string") {
			const agentId = details.id;
			const previous = headlessSubagents.get(agentId);
			const child = {
				parentToolCallId: event.toolCallId,
				...(previous?.startEventId ? { startEventId: previous.startEventId } : {}),
				...(typeof details.role === "string" ? { role: details.role } : {}),
				...(typeof details.sessionFile === "string" ? { sessionFile: details.sessionFile } : {}),
				phase: typeof details.phase === "string" ? details.phase : "thinking",
				turnCount: typeof details.turnCount === "number" ? details.turnCount : 0,
				...(typeof details.tool === "string" ? { tool: details.tool } : {}),
				lastActivityAt: typeof details.lastActivityAt === "number" ? details.lastActivityAt : nowMs(),
			};
			const terminal = child.phase === "completed" || child.phase === "error";
			const changed = !previous
				|| previous.role !== child.role
				|| previous.sessionFile !== child.sessionFile
				|| previous.phase !== child.phase
				|| previous.turnCount !== child.turnCount
				|| previous.tool !== child.tool;
			// pi-roles may emit the same sanitized state repeatedly while a child
			// is thinking. Persist only semantic transitions; heartbeats retain the
			// latest activity for observers without inflating the JSONL log.
			if (changed || terminal) {
				const observed = goalLog(ctx, !previous ? "subagent_started" : terminal ? "subagent_completed" : "subagent_progress", {
					agentId,
					role: child.role ?? null,
					sessionFile: child.sessionFile ?? null,
					phase: child.phase,
					turnCount: child.turnCount,
					tool: child.tool ?? null,
					lastActivityAt: child.lastActivityAt,
				}, { parentId: previous?.startEventId ?? headlessToolStarts.get(event.toolCallId)?.eventId ?? null });
				if (!previous && observed) child.startEventId = observed.eventId;
			}
			headlessSubagents.set(agentId, child);
			if (terminal) headlessSubagents.delete(agentId);
		}
		updateFooter(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (event.toolName === "get_goal") return;
		const resultRejected = typeof event.result === "object"
			&& event.result !== null
			&& !Array.isArray(event.result)
			&& (event.result as { isError?: unknown }).isError === true;
		const effectiveError = Boolean(event.isError) || resultRejected;
		progressRuntime.toolEnded(event.toolCallId, event.result, effectiveError, nowMs());
		if (goal) {
			const started = headlessToolStarts.get(event.toolCallId);
			headlessToolStarts.delete(event.toolCallId);
			goalLog(ctx, "tool_ended", {
				tool: event.toolName,
				toolCallId: event.toolCallId,
				isError: effectiveError,
				durationMs: started ? Math.max(0, nowMs() - started.startedAt) : null,
				result: summarizeValue(event.result, 500),
			}, { parentId: started?.eventId ?? null });
			for (const [agentId, child] of headlessSubagents) {
				if (child.parentToolCallId !== event.toolCallId) continue;
				goalLog(ctx, "subagent_completed", { agentId, role: child.role ?? null, sessionFile: child.sessionFile ?? null, phase: effectiveError ? "error" : "completed", turnCount: child.turnCount, tool: child.tool ?? null }, { parentId: child.startEventId ?? started?.eventId ?? null });
				headlessSubagents.delete(agentId);
			}
		}
		if (goal) updateFooter(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (!goal || goal.status !== "active") return;
		return { systemPrompt: event.systemPrompt + "\n\n" + goalSystemPrompt(goal, goalConfig) };
	});

	pi.on("context", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (!goal) return;
		let lastContinuationIdx = -1;
		const messages = event.messages as Array<{ customType?: string; details?: { goalId?: string } }>;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].customType === GOAL_CONTINUATION_TYPE && messages[i].details?.goalId === goal.id) lastContinuationIdx = i;
		}
		return {
			messages: messages.filter((msg, idx) => {
				if (msg.customType === GOAL_JUDGE_TYPE) return false;
				if (msg.customType === "pi-goal:diag") return false;
				if (msg.customType === GOAL_CONTINUATION_TYPE) {
					return goal?.status === "active" && msg.details?.goalId === goal?.id && idx === lastContinuationIdx;
				}
				return true;
			}) as typeof event.messages,
		};
	});

	pi.on("turn_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (!goal || goal.status !== "active") return;
		const turnId = goal.id + ":" + event.turnIndex + ":" + event.timestamp;
		legacyEvaluationHandledThisTurn = false;
		currentTurn = { turnId, goalId: goal.id };
		turnAccounting.beginTurn({ ...currentTurn, startedAtMs: event.timestamp });
		progressRuntime.turnStarted(event.timestamp);
		if (goal.headless) {
			goalLog(ctx, "turn_started", { turnIndex: event.turnIndex });
			syncHeadlessHeartbeat(ctx);
		}
		updateFooter(ctx);
		syncFooterTicker(ctx);
	});

	// 每轮 LLM 响应完成：记录 usage 与 stopReason（外部 agent 可据此判断推理轮次与异常终止）。
	pi.on("message_end", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		const msg = event.message as { role?: string; usage?: unknown; stopReason?: string; errorMessage?: string };
		if (msg.role !== "assistant") return;
		if (msg.stopReason !== "error") providerFailure = null;
		else if (!providerFailure && msg.errorMessage) {
			const error = classifyGoalError(msg.errorMessage);
			if (error.retryable) providerFailure = { error };
		}
		if (!goal) return;
		goalLog(ctx, "llm_response", {
			...(msg.usage === undefined ? {} : { usage: msg.usage }),
			...(msg.stopReason === undefined ? {} : { stopReason: msg.stopReason }),
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		if (!goal || !currentTurn || currentTurn.goalId !== goal.id) return;
		const identity = currentTurn;
		const outputTokens = extractOutputTokens(event);
		const settlement = turnAccounting.settleTurn(identity, nowMs(), outputTokens);
		currentTurn = null;
		progressRuntime.turnEnded(nowMs());
		if (settlement.time.applied) goal.timeUsedMs += settlement.time.elapsedMs;
		if (settlement.tokens.applied) goal.tokensUsed += settlement.tokens.outputTokens;
		turnAccounting.release(identity.turnId);
		// Only count no-progress on goal-driven turns. A user-driven turn (an
		// interrupt with guidance) is engagement, not stagnation — it must not
		// trip the no-progress auto-pause.
		// In print/headless sessions the host may emit agent_end before turn_end.
		// agent_end clears wasGoalDriven while queueing the next continuation, so
		// relying on that flag makes every continuation look user-driven and leaves
		// autoTurnCount/noProgressCount at zero indefinitely. Headless turns have
		// no user interaction source; count them directly.
		if ((wasGoalDriven || goal.headless) && goal.status === "active") {
			// A turn that executed tool calls made forward progress even when the
			// final assistant message had <threshold output tokens (e.g. a turn
			// that ended on a tool-result message). Reset no-progress in that
			// case so active tool work is never miscounted as stagnation.
			const didToolWork = event.toolResults.length > 0;
			if (outputTokens < CONFIG.noProgressTokenThreshold && !didToolWork) goal.noProgressCount += 1;
			else goal.noProgressCount = 0;
			goal.autoTurnCount += 1;
		}
		if (isAssistantMessage(event.message)) lastAssistantText = extractTextContent(event.message);
		// Headless 模式：run 内的每轮 turn 都评估 pending 的完成请求。print 模式下
		// agent_end 只在整个 run 结束时触发，若无此路径，agent 请求完成评估后永远
		// 得不到 judge 反馈，会在初始 run 里无限循环。
		if (goal.headless && goal.status === "active") {
			const headlessPolicy = goalConfig.completionPolicy ?? "v2";
			const headlessPending = hasPendingCompletionRequest(goal);
			if (headlessPolicy === "legacy" && headlessPending && !legacyEvaluationHandledThisTurn) {
				const legacyOutcome = await evaluateLegacyCompletion(
					lastAssistantText.trim() || "(No assistant text this turn; evaluating from the persisted evidence packet.)",
					ctx,
				);
				if (legacyOutcome !== "active") return;
			} else if (headlessPolicy !== "legacy" && headlessPending) {
				const operation = captureActiveGoalOperation();
				if (!operation) return;
				const verification = goalConfig.verifyCommand
					? await runVerifyCommand(goalConfig.verifyCommand, goalConfig.verifyTimeoutMs ?? 120_000)
					: undefined;
				if (!isActiveGoalOperation(operation) || !goal) return;
				progressRuntime.evaluationStarted(nowMs());
				const v2Run = await runV2CompletionJudge(goal, lastAssistantText.trim() || "(No assistant text this turn; evaluating from the persisted evidence packet.)", ctx, pi, goalConfig, verification, dependencies.complete);
				if (!isActiveGoalOperation(operation) || !goal) return;
				progressRuntime.evaluationEnded(nowMs());
				updateFooter(ctx);
				const transition = applyAuthoritativeCompletionEvaluation(goal, v2Run.evaluation);
				goalLog(ctx, "completion_evaluated", {
					decision: transition.completion.lastEvaluation?.decision ?? null,
					findings: transition.completion.lastEvaluation?.findings ?? [],
					advisories: transition.completion.lastEvaluation?.advisories ?? [],
				});
				if (transition.status === "complete") {
					updateState({ status: "complete", completion: transition.completion, noProgressCount: 0 }, ctx);
					pi.sendMessage({
						customType: GOAL_EVENT_TYPE,
						content: "Goal achieved! \u2705\n\nObjective: " + goal.objective +
							"\nEvaluator: Goal V2 accepted the persisted evidence packet (evaluated at turn end)." +
							"\nTokens: " + formatTokens(goal.tokensUsed) + "\nTime: " + formatDuration(goal.timeUsedMs),
						display: true,
						details: { kind: "complete", goal: { ...goal, status: "complete" }, progress: progressFor(goal) },
					}, { triggerTurn: false });
					return;
				}
				if (transition.status === "paused") {
					updateState({
						status: "paused",
						completion: transition.completion,
						pausedReason: transition.pausedReason,
						noProgressCount: 0,
					}, ctx);
					clearTimer();
					userSuspended = true;
					return;
				}
				updateState({ completion: transition.completion, noProgressCount: 0 }, ctx);
			}
		}
		// The print host can emit agent_end before this turn_end. In that order
		// the continuation has already been queued using the previous counters,
		// so checking only in sendContinuationNow lets a headless goal overshoot
		// its configured cap (especially when completion is repeatedly revised).
		// Enforce the guard after completion evaluation so a successful final
		// evaluation still wins on the cap-boundary turn.
		if (goal.headless && goal.status === "active") {
			if (goal.noProgressCount >= CONFIG.maxNoProgressTurns) {
				pauseGoal("no progress for " + CONFIG.maxNoProgressTurns + " turns", ctx);
				return;
			}
			if (goal.autoTurnCount >= activeMaxAutoTurns) {
				pauseGoal("reached max auto-turns (" + activeMaxAutoTurns + ")", ctx);
				return;
			}
		}
		if (goal.status === "active" && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
				const completionPolicy = goalConfig.completionPolicy ?? "v2";
				const pendingV2Request = completionPolicy === "v2" && hasPendingCompletionRequest(goal);
				if (pendingV2Request) {
					// UX finding: the reviewer accepted, the agent requested completion,
					// then the budget gate fired before the authoritative judge ran —
					// finished work was stranded at budget_limited. Evaluate once before
					// closing the goal; a revise still falls through to budget_limited.
					// A pure tool-call turn has no text: judge from the evidence packet.
					const operation = captureActiveGoalOperation();
					if (!operation) return;
					const verification = goalConfig.verifyCommand
						? await runVerifyCommand(goalConfig.verifyCommand, goalConfig.verifyTimeoutMs ?? 120_000)
						: undefined;
					if (!isActiveGoalOperation(operation) || !goal) return;
					progressRuntime.evaluationStarted(nowMs());
					const v2Run = await runV2CompletionJudge(goal, lastAssistantText.trim() || "(No assistant text this turn; evaluating from the persisted evidence packet.)", ctx, pi, goalConfig, verification, dependencies.complete);
					if (!isActiveGoalOperation(operation) || !goal) return;
					progressRuntime.evaluationEnded(nowMs());
					updateFooter(ctx);
					const transition = applyAuthoritativeCompletionEvaluation(goal, v2Run.evaluation);
					if (transition.status === "complete") {
						updateState({ status: "complete", completion: transition.completion, noProgressCount: 0 }, ctx);
						pi.sendMessage({
							customType: GOAL_EVENT_TYPE,
							content: "Goal achieved! \u2705\n\nObjective: " + goal.objective +
								"\nEvaluator: Goal V2 accepted the persisted evidence packet (evaluated at budget limit)." +
								"\nTokens: " + formatTokens(goal.tokensUsed) + "\nTime: " + formatDuration(goal.timeUsedMs),
							display: true,
							details: { kind: "complete", goal: { ...goal, status: "complete" }, progress: progressFor(goal) },
						}, { triggerTurn: false });
						return;
					}
					if (transition.status === "paused") {
						updateState({
							status: "paused",
							completion: transition.completion,
							pausedReason: transition.pausedReason,
							noProgressCount: 0,
						}, ctx);
						clearTimer();
						userSuspended = true;
						ctx.ui?.notify?.("Goal paused after the same completion rejection repeated three times.", "warning");
						return;
					}
					updateState({ completion: transition.completion, noProgressCount: 0 }, ctx);
				}
				updateState({ status: "budget_limited", noProgressCount: 0 }, ctx);
				clearTimer();
				userSuspended = true;
			pi.sendMessage(
				{ customType: GOAL_EVENT_TYPE, content: budgetLimitPrompt(goal), display: true, details: { kind: "budget_limited", goal: { ...goal }, progress: progressFor(goal) } },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		}
		if (settlement.time.applied || settlement.tokens.applied) persist("usage");
		if (goal.headless) {
			goalLog(ctx, "turn_settled", { tokensUsed: goal.tokensUsed, activeMs: goal.timeUsedMs, noProgressCount: goal.noProgressCount, autoTurnCount: goal.autoTurnCount });
			checkBudgetWarnings(ctx);
		}
		updateFooter(ctx);
		syncFooterTicker(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		// A user typed something. Cancel any pending auto-continuation so the
		// user's message is processed first — but do NOT permanently suspend the
		// goal. An interrupt (steer/followUp) injects guidance; the user expects
		// the goal to RESUME afterward, not pause. After the user-driven turn,
		// agent_end schedules the next continuation automatically. Use /goal pause
		// for an explicit stop.
		//
		// Skip our own extension-injected messages (e.g. /goal <objective> drafts
		// the goal via sendUserMessage) — those are not user interrupts.
		if (goal?.status === "active" && event.source !== "extension") {
			clearRetryTimer();
			providerFailure = null;
			userSuspended = false;
			const initial = Boolean(goal.headless && currentTurn === null && goal.autoTurnCount === 0);
			const payload = { source: event.source, kind: initial ? "initial" : "steering", input: summarizeValue(event, 500) };
			if (goal.headless) goalLog(ctx, "steering_received", payload);
			else recordRuntimeEvent("steering.received", payload);
			clearTimer();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;
		const goalDriven = wasGoalDriven;
		wasGoalDriven = false;
		if (!goal || goal.status !== "active") return;
		if (ctx.signal?.aborted) {
			if (goal.headless) {
				// print-mode 进程退出路径的 dispose-abort：不是用户中断，不 pauseGoal。
				// 正常 headless 续跑由 sendContinuationNow 在 emit 窗口内同步入队 followUp
				// 让 agent loop 继续，根本不会走到 dispose；此分支只接真正的中止。
				snapshotActiveHeadless(ctx);
				process.exitCode = 1;
				return;
			}
			pauseGoal("interrupted", ctx);
			return;
		}
		// Let agent_settled apply typed retry after PI has exhausted its own
		// provider retry loop. Scheduling a continuation here would race the host
		// retry and create a duplicate attempt.
		if (providerFailure) return;
		if (ctx.hasPendingMessages()) return;

		// Completion checks only consume goal-driven turns. V2 evaluates exactly
		// once per explicit request; legacy remains turn-based for compatibility.
		// A pending request must be judged even when the turn ended on a pure
		// tool call with no assistant text (UX finding: lastAssistantText stayed
		// empty, so neither the judge nor scheduleContinuation ever ran).
		const responseText = lastAssistantText.trim() || "(No assistant text this turn; evaluating from the persisted evidence packet.)";
		const completionPolicy = goalConfig.completionPolicy ?? "v2";
		const pendingHeadlessLegacy = goal.headless
			&& completionPolicy === "legacy"
			&& hasPendingCompletionRequest(goal);
		if (goalDriven || pendingHeadlessLegacy) {
			const pendingV2Request = completionPolicy !== "legacy"
				&& hasPendingCompletionRequest(goal)
				&& !requiresAtomicCompletionV3(goal);
			const operation = pendingV2Request ? captureActiveGoalOperation() : null;
			if (pendingV2Request) {
				if (!operation) return;
				progressRuntime.evaluationStarted(nowMs());
				updateFooter(ctx);
			}
			const verification = pendingV2Request && goalConfig.verifyCommand
				? await runVerifyCommand(goalConfig.verifyCommand, goalConfig.verifyTimeoutMs ?? 120_000)
				: undefined;
			if (pendingV2Request && (!isActiveGoalOperation(operation) || !goal)) return;

			if (pendingV2Request) {
				const v2Run = await runV2CompletionJudge(goal, responseText, ctx, pi, goalConfig, verification, dependencies.complete);
				if (!isActiveGoalOperation(operation) || !goal) return;
				const evaluated = withBlueprintEvidenceDiagnostics(v2Run.evaluation);
				progressRuntime.evaluationEnded(nowMs());
				updateFooter(ctx);
				if (ctx.signal?.aborted) {
					if (goal.headless) { snapshotActiveHeadless(ctx); process.exitCode = 1; return; }
					pauseGoal("interrupted", ctx); return;
				}
				if (completionPolicy === "shadow") {
					updateState({ completion: applyShadowCompletionEvaluation(goal, evaluated) }, ctx);
					goalLog(ctx, "completion_evaluated", { decision: goal.completion.lastEvaluation?.decision ?? null, findings: goal.completion.lastEvaluation?.findings ?? [], advisories: goal.completion.lastEvaluation?.advisories ?? [] });
				} else {
					const transition = applyAuthoritativeCompletionEvaluation(goal, evaluated);
					if (transition.status === "complete") {
						updateState({ status: "complete", completion: transition.completion, noProgressCount: 0 }, ctx);
						pi.sendMessage({
							customType: GOAL_EVENT_TYPE,
							content: "Goal achieved! \u2705\n\nObjective: " + goal.objective +
								"\nEvaluator: Goal V2 accepted the persisted evidence packet." +
								"\nTokens: " + formatTokens(goal.tokensUsed) + "\nTime: " + formatDuration(goal.timeUsedMs),
							display: true,
							details: { kind: "complete", goal: { ...goal, status: "complete" }, progress: progressFor(goal) },
						}, { triggerTurn: false });
						return;
					}
					if (transition.status === "paused") {
						updateState({
							status: "paused",
							completion: transition.completion,
							pausedReason: transition.pausedReason,
							noProgressCount: 0,
						}, ctx);
						clearTimer();
						userSuspended = true;
						ctx.ui?.notify?.("Goal paused after the same completion rejection repeated three times.", "warning");
						return;
					}
					updateState({ completion: transition.completion, noProgressCount: 0 }, ctx);
					goalLog(ctx, "completion_evaluated", { decision: transition.completion.lastEvaluation?.decision ?? null, findings: transition.completion.lastEvaluation?.findings ?? [], advisories: transition.completion.lastEvaluation?.advisories ?? [] });
					if (transition.rejectionAction === "replan") {
						ctx.ui?.notify?.("Completion was rejected again; the next turn must change verification strategy or replan.", "warning");
					}
				}
			}

			if (completionPolicy === "v2") {
				resumeGoalLoop(ctx);
				return;
			}

			if (!legacyEvaluationHandledThisTurn) {
				const outcome = await evaluateLegacyCompletion(responseText, ctx, verification);
				if (outcome !== "active") return;
			}
		}
		// Resume the goal after either a goal-driven turn (continue progress)
		// or a user-driven turn (apply the user's guidance and keep going).
		// Headless 走同步续跑（print-mode 修复）：agent_end 的 emit 窗口内同步入队
		// followUp，agent loop 检测到队列非空后继续，print-mode 因此保持等待。
		resumeGoalLoop(ctx);
	});

	// ═══════════════════════════════════════════════════════════════════
	// Message Renderer
	// ═══════════════════════════════════════════════════════════════════

	pi.registerMessageRenderer(GOAL_EVENT_TYPE, (message, options, theme) => {
		const details = message.details as { kind?: string; goal?: GoalState | null; progress?: GoalProgressSnapshot; judgeVerdict?: JudgeVerdict | null } | undefined;
		const state = details?.goal ?? null;
		const judge = details?.judgeVerdict ?? null;
		// Older events did not embed a progress snapshot. Freeze their fallback at
		// the event-owned state timestamp so a historical paused card cannot keep
		// accumulating wall time whenever the session is rendered again.
		const progress = details?.progress ?? (state ? progressFor(state, state.endedAt ?? state.updatedAt) : null);
		return {
			render: (width: number) => {
				if (!progress) return [theme.fg("dim", "Goal event")];
				if (!options.expanded) {
					const color = progress.health.state === "blocked" ? "error"
						: progress.health.state === "attention" ? "warning"
						: progress.status === "complete" ? "success" : "accent";
					return [theme.fg(color, renderCompactGoalProgress(progress, width))];
				}
				const lines = renderGoalProgressLines(progress, width);
				if (judge && !judge.parseFailed) {
					lines.push(truncateDisplay("  Legacy judge: " + (judge.done ? "DONE" : "CONTINUE") + " | " + judge.reason, width));
				}
				return lines.map((line, index) => theme.fg(index === 0 ? "accent" : "text", line));
			},
			invalidate: () => {},
		};
	});

	// ═══════════════════════════════════════════════════════════════════
	// Model Tools
	// ═══════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "get_goal", label: "Get Goal",
		description: "Read the current goal, including the backward-compatible V2 view and Contract V3 lineage/runtime view.",
		parameters: Type.Object({
			mode: Type.Optional(StringEnum(["compact", "full", "delta"] as const)),
			sinceEventSeq: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!goal) {
				const text = reconstructionError ? "Goal state is unavailable: " + reconstructionError : "No goal is currently set.";
				return { content: [{ type: "text", text }], isError: Boolean(reconstructionError), details: { reconstructionError } };
			}
			const now = nowMs();
			const progress = progressFor(goal, now);
			const completionIntegrity = inspectCommittedArtifactsV3(goal, ctx.cwd, now);
			const publicEvaluation = goal.completion.lastEvaluation ? {
				...goal.completion.lastEvaluation,
				evaluator: {
					kind: goal.completion.lastEvaluation.evaluator.kind,
					model: goal.completion.lastEvaluation.evaluator.model,
					agentId: goal.completion.lastEvaluation.evaluator.agentId,
					sessionId: goal.completion.lastEvaluation.evaluator.sessionId,
					reportDigest: goal.completion.lastEvaluation.evaluator.reportDigest,
				},
			} : null;
				const fullView = {
				apiVersion: 2,
				id: goal.id,
				objective: goal.objective,
					status: goal.status,
					pausedReason: goal.pausedReason,
					blocker: goal.blocker,
				taskKind: goal.taskKind,
				criteria: goal.criteria.map(({ id, description, level, evidenceRefs }) => ({ id, description, level, evidenceRefs })),
				constraints: goal.constraints,
				deviations: goal.deviations,
				...(goal.blueprint ? { blueprint: goal.blueprint } : {}),
					...(goal.headless ? { headless: goal.headless } : {}),
					...(goal.runtime ? { runtime: goal.runtime } : {}),
					...(goal.completionTransaction ? { completionTransaction: goal.completionTransaction } : {}),
					execution: goal.execution,
				assurance: goal.assurance,
					claims: goal.claims,
					evidenceLedger: goal.evidenceLedger,
					runtimeControl: {
						approvals: structuredClone(approvals),
						sideEffectJournal: structuredClone(sideEffectJournal),
					},
					completion: { ...goal.completion, lastEvaluation: publicEvaluation },
					contract: buildGoalPublicViewV3(goal, completionIntegrity),
					integrity: completionIntegrity,
					progress,
				usage: progress.resources,
			};
				const mode = (params as { mode?: "compact" | "full" | "delta" }).mode ?? "full";
				const view = mode === "compact"
					? {
						apiVersion: 2, view: "compact", id: goal.id, objective: goal.objective, status: goal.status,
						pausedReason: goal.pausedReason, blocker: goal.blocker, runtime: goal.runtime,
						// UX-P2-02：compact 使用真正精简的 progress 投影，不再返回
						// 完整 outcome items/label/evidenceRefs；明细留在 full/delta。
						progress: compactGoalProgress(fullView.progress), usage: fullView.usage,
					}
					: mode === "delta"
						? {
							apiVersion: 2, view: "delta", id: goal.id, sinceEventSeq: (params as { sinceEventSeq?: number }).sinceEventSeq ?? null,
							updatedAt: goal.updatedAt, status: goal.status, runtime: goal.runtime,
							progress: fullView.progress, completion: fullView.completion, integrity: fullView.integrity,
						}
						: { ...fullView, view: "full" };
				return {
					content: [{ type: "text", text: JSON.stringify(view, null, 2) }],
					details: { goal: view, mode },
				};
		},
	});

	pi.registerTool({
		name: "prepare_goal_side_effect", label: "Prepare Goal Side Effect",
		description: "Prepare an external side effect under the Goal V3 idempotency journal. Execute only when the returned action is execute; reconcile or replay existing entries instead of blindly repeating them.",
		parameters: Type.Object({
			idempotencyKey: Type.String({ minLength: 1 }),
			operation: Type.String({ minLength: 1 }),
			resource: Type.String({ minLength: 1 }),
			request: Type.Unknown(),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!goal || goal.status !== "active" || !goal.runtime) return { content: [{ type: "text", text: "No active Goal runtime." }], isError: true, details: {} };
			const result = prepareGoalSideEffect({
				journal: sideEffectJournal,
				idempotencyKey: params.idempotencyKey,
				operation: params.operation,
				resource: params.resource,
				request: params.request,
				attemptId: goal.runtime.attemptId,
				now: nowMs(),
				adapterId: sideEffectAdapter?.id,
			});
			if (result.action === "conflict") return { content: [{ type: "text", text: result.error.message }], isError: true, details: { action: result.action, error: result.error } };
			if (result.action === "execute") recordRuntimeControlEvent("goal.side_effect_prepared", { entry: result.entry });
			return { content: [{ type: "text", text: JSON.stringify({ action: result.action, entry: result.entry }) }], details: { action: result.action, entry: result.entry } };
		},
	});

	pi.registerTool({
		name: "execute_goal_side_effect", label: "Execute Goal Side Effect",
		description: "Execute a prepared external side effect through the trusted host adapter, then persist its receipt. The request must match the prepared digest.",
		parameters: Type.Object({
			entryId: Type.String({ minLength: 1 }),
			request: Type.Unknown(),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!goal || goal.status !== "active" || !goal.runtime) return { content: [{ type: "text", text: "No active Goal runtime." }], isError: true, details: {} };
			if (!sideEffectAdapter) return { content: [{ type: "text", text: "No trusted Goal side-effect adapter is configured." }], isError: true, details: { code: "policy_denied" } };
			const index = sideEffectJournal.findIndex((entry) => entry.id === params.entryId);
			if (index < 0) return { content: [{ type: "text", text: "Unknown side-effect entry: " + params.entryId }], isError: true, details: {} };
			const entry = sideEffectJournal[index];
			if (entry.status === "committed") return { content: [{ type: "text", text: JSON.stringify({ action: "replay", entry }) }], details: { action: "replay", entry } };
			if (entry.status === "failed") return { content: [{ type: "text", text: "Reconcile the failed side effect before attempting execution again." }], isError: true, details: { action: "reconcile", entry } };
			if (entry.adapterId !== sideEffectAdapter.id) return { content: [{ type: "text", text: "Side-effect entry belongs to a different adapter." }], isError: true, details: { code: "idempotency_conflict", entry } };
			if (digestGoalValueV3(params.request).value !== entry.requestDigest.value) return { content: [{ type: "text", text: "Side-effect request does not match the prepared digest." }], isError: true, details: { code: "idempotency_conflict", entry } };
			if (sideEffectInFlight.has(entry.id)) return { content: [{ type: "text", text: JSON.stringify({ action: "reconcile", entry }) }], details: { action: "reconcile", entry } };
			const hookError = runRuntimeHook({ target: "tool", phase: "pre", operation: "side_effect.execute", payload: { entryId: entry.id, request: params.request } });
			if (hookError) return { content: [{ type: "text", text: hookError.message }], isError: true, details: { code: hookError.code, entry } };
			sideEffectInFlight.add(entry.id);
			try {
				const response = await sideEffectAdapter.execute({ entry: structuredClone(entry), request: params.request });
				const settled = settleGoalSideEffect(entry, { response, now: nowMs() });
				sideEffectJournal[index] = settled;
				recordRuntimeControlEvent("goal.side_effect_settled", { entry: settled, adapterId: sideEffectAdapter.id });
				runRuntimeHook({ target: "tool", phase: "post", operation: "side_effect.execute", payload: { entryId: entry.id, request: params.request }, result: response });
				return { content: [{ type: "text", text: JSON.stringify({ action: "committed", entry: settled }) }], details: { action: "committed", entry: settled } };
			} catch (error) {
				const typed = classifyGoalError(error);
				const settled = settleGoalSideEffect(entry, { error: typed, now: nowMs() });
				sideEffectJournal[index] = settled;
				recordRuntimeControlEvent("goal.side_effect_settled", { entry: settled, adapterId: sideEffectAdapter.id });
				runRuntimeHook({ target: "tool", phase: "post", operation: "side_effect.execute", payload: { entryId: entry.id, request: params.request }, error: typed });
				return { content: [{ type: "text", text: typed.message }], isError: true, details: { action: "failed", entry: settled, error: typed } };
			} finally {
				sideEffectInFlight.delete(entry.id);
			}
		},
	});

	pi.registerTool({
		name: "reconcile_goal_side_effect", label: "Reconcile Goal Side Effect",
		description: "Ask the trusted host adapter whether a prepared or failed external side effect committed, without blindly replaying it.",
		parameters: Type.Object({ entryId: Type.String({ minLength: 1 }) }),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!goal || goal.status !== "active" || !goal.runtime) return { content: [{ type: "text", text: "No active Goal runtime." }], isError: true, details: {} };
			if (!sideEffectAdapter) return { content: [{ type: "text", text: "No trusted Goal side-effect adapter is configured." }], isError: true, details: { code: "policy_denied" } };
			const index = sideEffectJournal.findIndex((entry) => entry.id === params.entryId);
			if (index < 0) return { content: [{ type: "text", text: "Unknown side-effect entry: " + params.entryId }], isError: true, details: {} };
			const entry = sideEffectJournal[index];
			if (entry.status === "committed") return { content: [{ type: "text", text: JSON.stringify({ action: "replay", entry }) }], details: { action: "replay", entry } };
			if (entry.adapterId !== sideEffectAdapter.id) return { content: [{ type: "text", text: "Side-effect entry belongs to a different adapter." }], isError: true, details: { code: "idempotency_conflict", entry } };
			const hookError = runRuntimeHook({ target: "tool", phase: "pre", operation: "side_effect.reconcile", payload: { entryId: entry.id } });
			if (hookError) return { content: [{ type: "text", text: hookError.message }], isError: true, details: { code: hookError.code, entry } };
			try {
				const result = await sideEffectAdapter.reconcile({ entry: structuredClone(entry) });
				if (result.status === "unknown") return { content: [{ type: "text", text: JSON.stringify({ action: "reconcile", entry }) }], details: { action: "reconcile", entry } };
				const settled = result.status === "committed"
					? settleGoalSideEffect(entry, { response: result.response, now: nowMs() })
					: settleGoalSideEffect(entry, { error: result.error, now: nowMs() });
				sideEffectJournal[index] = settled;
				recordRuntimeControlEvent("goal.side_effect_settled", { entry: settled, adapterId: sideEffectAdapter.id, reconciled: true });
				runRuntimeHook({ target: "tool", phase: "post", operation: "side_effect.reconcile", payload: { entryId: entry.id }, result });
				return { content: [{ type: "text", text: JSON.stringify({ action: settled.status, entry: settled }) }], details: { action: settled.status, entry: settled } };
			} catch (error) {
				const typed = classifyGoalError(error);
				return { content: [{ type: "text", text: typed.message }], isError: true, details: { action: "reconcile", entry, error: typed } };
			}
		},
	});

	pi.registerTool({
		name: "settle_goal_side_effect", label: "Settle Goal Side Effect",
		description: "Commit or fail a prepared Goal V3 side effect and persist its response/error receipt.",
		parameters: Type.Object({
			entryId: Type.String({ minLength: 1 }),
			response: Type.Optional(Type.Unknown()),
			error: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			if (!goal || goal.status !== "active") return { content: [{ type: "text", text: "No active Goal runtime." }], isError: true, details: {} };
			if (params.response !== undefined && params.error !== undefined) return { content: [{ type: "text", text: "Settle a side effect with response or error, not both." }], isError: true, details: {} };
			const index = sideEffectJournal.findIndex((entry) => entry.id === params.entryId);
			if (index < 0) return { content: [{ type: "text", text: "Unknown side-effect entry: " + params.entryId }], isError: true, details: {} };
			const entry = settleGoalSideEffect(sideEffectJournal[index], { response: params.response, error: params.error, now: nowMs() });
			sideEffectJournal[index] = entry;
			recordRuntimeControlEvent("goal.side_effect_settled", { entry });
			return { content: [{ type: "text", text: JSON.stringify({ action: entry.status, entry }) }], details: { action: entry.status, entry } };
		},
	});

	pi.registerTool({
		name: "update_goal", label: "Update Goal",
		description: "Apply exactly one Goal V2 action. Preflight structured references before record_evidence, reviewer handoff, or completion submission. Evidence IDs are immutable; revised content or provenance requires a new revision evidence ID. Legacy flat arguments remain accepted for one compatibility cycle.",
			parameters: Type.Object({
				action: Type.Optional(StringEnum(["record_evidence", "upsert_claim", "request_completion", "record_review", "change_execution", "mark_unmet", "pause", "record_deviation", "submit_completion_bundle"] as const)),
					bundle: Type.Optional(Type.Object({
						idempotencyKey: Type.String({ description: "Stable key for safe retry of this exact completion submission." }),
						summary: Type.String(),
						artifacts: Type.Array(Type.Object({
							id: Type.String({ description: "Stable artifact identifier used by evidence.artifactId." }),
							uri: Type.String({ description: "Artifact path or URI; distinct from the stable artifact id." }),
							digest: Type.String({ pattern: "^[0-9a-f]{64}$", description: "Lowercase SHA-256 digest of the artifact bytes." }),
							sizeBytes: Type.Number({ minimum: 0 }), mediaType: Type.Optional(Type.String()),
						})),
						evidence: Type.Array(Type.Union([
							Type.Object({
								id: Type.String({ description: "Immutable evidence ID. Use a new revision evidence ID when content or provenance changes." }),
								kind: StringEnum(["source", "artifact", "command", "tool_result", "observation", "user_confirmation"] as const),
								summary: Type.String(),
							criterionIds: Type.Optional(Type.Array(Type.String(), { description: "Declared Goal criterion IDs supported by this evidence; $constraint:n is never a criterion ID. Omitted input normalizes to an empty array." })),
								claimIds: Type.Optional(Type.Array(Type.String())),
								artifactId: Type.String({ description: "Exact artifacts[].id. An exact artifact URI alias is accepted and canonicalized. artifactId and digest are a required pair (CB-P0-01)." }),
								digest: Type.String({ pattern: "^[0-9a-f]{64}$", description: "Lowercase SHA-256 digest of the artifact bytes; required together with artifactId (CB-P0-01)." }),
							}, { description: "Artifact-linked evidence: artifactId and digest must be provided together." }),
							Type.Object({
								id: Type.String({ description: "Immutable evidence ID. Use a new revision evidence ID when content or provenance changes." }),
								kind: StringEnum(["source", "artifact", "command", "tool_result", "observation", "user_confirmation"] as const),
								summary: Type.String(),
							criterionIds: Type.Optional(Type.Array(Type.String(), { description: "Declared Goal criterion IDs supported by this evidence; $constraint:n is never a criterion ID. Omitted input normalizes to an empty array." })),
								claimIds: Type.Optional(Type.Array(Type.String())),
							}, { description: "Non-artifact evidence without artifactId/digest." }),
						])),
					deterministicChecks: Type.Optional(Type.Array(Type.Object({
						id: Type.String({ description: "Deterministic check ID from a separate namespace; never use it as a criterion ID." }), status: StringEnum(["passed", "failed"] as const), summary: Type.String(), evidenceIds: Type.Array(Type.String()),
					}))),
						reviewerResultRef: Type.Object({
							resultId: Type.String(), agentId: Type.String(), role: Type.String(), status: StringEnum(["completed"] as const),
							digest: Type.String({ pattern: "^[0-9a-f]{64}$", description: "Lowercase SHA-256 digest of the immutable reviewer result." }),
						}),
				}, { description: "Contract V3 atomic completion bundle. Preflight criterion, claim, evidence, check, artifact, and reviewer cross-references; $constraint:n is never a criterion. Artifacts are re-hashed before commit." })),
			status: Type.Optional(StringEnum(["complete", "unmet"] as const)),
				evidence: Type.Optional(Type.Union([Type.String(), Type.Object({
				id: Type.String({ description: "Immutable evidence ID (required for structured evidence). Use a new revision evidence ID when content or provenance changes." }),
				kind: StringEnum(["source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text"] as const),
				summary: Type.String(),
				// Accept target IDs inside the evidence object as well as at the
				// canonical top level. Some model providers naturally group all
				// evidence metadata together; normalization keeps both forms equal.
				criterionIds: Type.Optional(Type.Array(Type.String(), { description: "Declared Goal criterion IDs only; $constraint:n is a reviewer finding subject, never a criterion target." })),
				claimIds: Type.Optional(Type.Array(Type.String())),
				locator: Type.Optional(Type.String()),
				excerpt: Type.Optional(Type.String()),
				sourceKind: Type.Optional(StringEnum(["primary", "secondary", "workspace", "user"] as const)),
				independenceKey: Type.Optional(Type.String()),
				origin: Type.Optional(StringEnum(["tool", "agent", "user", "legacy"] as const)),
				verification: Type.Optional(StringEnum(["unverified", "verified", "rejected"] as const)),
				})])),
				evidenceId: Type.Optional(Type.String({ description: "Reuse an existing immutable ledger entry only when the record is unchanged and evidence is omitted." })),
				blocker: Type.Optional(Type.String({ description: "Required for unmet." })),
				subjectId: Type.Optional(Type.String({ description: "For action=record_deviation: criterion/claim or blueprint node id this deviation touches." })),
				description: Type.Optional(Type.String({ description: "For action=record_deviation: what deviated from the blueprint." })),
				reason: Type.Optional(Type.String({ description: "For action=record_deviation: why the deviation was necessary." })),
				impact: Type.Optional(Type.String({ description: "For action=record_deviation: impact on acceptance criteria." })),
				criterionId: Type.Optional(Type.String({ description: "Declared Goal criterion ID for per-criterion evidence. $constraint:n is never valid here." })),
				criterionIds: Type.Optional(Type.Array(Type.String(), { description: "Declared Goal criterion IDs only; preflight every value against the current Goal criteria." })),
				claimId: Type.Optional(Type.String()),
				claimIds: Type.Optional(Type.Array(Type.String())),
			claim: Type.Optional(Type.Object({
				id: Type.String(), text: Type.String(),
				materiality: StringEnum(["material", "supporting"] as const),
				risk: Type.Optional(StringEnum(["ordinary", "high"] as const)),
				evidenceRefs: Type.Optional(Type.Array(Type.String())),
			})),
			summary: Type.Optional(Type.String()),
			decision: Type.Optional(StringEnum(["accept", "revise", "blocked"] as const)),
			findings: Type.Optional(Type.Array(Type.Object({
				code: Type.String(), subjectId: Type.String(), reason: Type.String(),
				evidenceRefs: Type.Optional(Type.Array(Type.String())),
				missingEvidenceKind: Type.Optional(StringEnum(["source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text"] as const)),
				scope: Type.Optional(StringEnum(["local", "section", "global"] as const)),
				targetPath: Type.Optional(Type.String()), sectionId: Type.Optional(Type.String()),
				anchor: Type.Optional(Type.String()), requiredFix: Type.Optional(Type.String()),
				rewriteRequired: Type.Optional(Type.Boolean()), rewriteReason: Type.Optional(Type.String()),
			}))),
				advisories: Type.Optional(Type.Array(Type.String())),
				review: Type.Optional(Type.Object({
					status: StringEnum(["passed", "failed"] as const),
					reason: Type.String(),
					evaluator: Type.Object({
						kind: StringEnum(["reviewer"] as const),
						model: Type.Optional(Type.String()),
						agentId: Type.String(),
						sessionId: Type.Optional(Type.String()),
						reportDigest: Type.Optional(Type.String()),
						legacySessionFile: Type.Optional(Type.String()),
					}),
					sessionFile: Type.String({ description: "Readable sessionFile returned by spawn_role." }),
					findings: Type.Optional(Type.Array(Type.Object({
						code: Type.String(), subjectId: Type.String(), reason: Type.String(),
						evidenceRefs: Type.Optional(Type.Array(Type.String())),
						missingEvidenceKind: Type.Optional(StringEnum(["source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text"] as const)),
						scope: Type.Optional(StringEnum(["local", "section", "global"] as const)),
						targetPath: Type.Optional(Type.String()), sectionId: Type.Optional(Type.String()),
						anchor: Type.Optional(Type.String()), requiredFix: Type.Optional(Type.String()),
						rewriteRequired: Type.Optional(Type.Boolean()), rewriteReason: Type.Optional(Type.String()),
					}))),
					advisories: Type.Optional(Type.Array(Type.String())),
				})),
				reviewerSessionId: Type.Optional(Type.String()),
					execution: Type.Optional(Type.Object({
					preference: StringEnum(["auto", "direct", "specialist", "team"] as const),
					selected: StringEnum(["direct", "specialist", "team"] as const),
					role: Type.Optional(Type.String()),
					source: StringEnum(["auto", "user", "legacy"] as const),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					reasons: Type.Array(Type.String()),
					minimum: Type.Optional(StringEnum(["specialist"] as const)),
						reassessOn: Type.Array(StringEnum(["scope_expanded", "new_workstream", "conflict", "stalled"] as const)),
					})),
					routing: Type.Optional(Type.Object({
						uncertainty: StringEnum(["low", "medium", "high"] as const),
						coupling: StringEnum(["low", "medium", "high"] as const),
						risk: StringEnum(["low", "medium", "high"] as const),
						specialistNeed: StringEnum(["none", "helpful", "required"] as const),
						independentWorkstreams: Type.Number({ minimum: 0 }),
						heterogeneousSkills: Type.Boolean(),
					effort: StringEnum(["small", "medium", "large"] as const),
					confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
					repeatedFailureCount: Type.Optional(Type.Number({ minimum: 0 })),
						remainingWorkstreams: Type.Optional(Type.Number({ minimum: 0 })),
						coordinationOverheadHigh: Type.Optional(Type.Boolean()),
					})),
					reassessTrigger: Type.Optional(StringEnum(["scope_expanded", "new_workstream", "conflict", "stalled"] as const)),
			preference: Type.Optional(StringEnum(["auto", "direct", "specialist", "team"] as const)),
			selected: Type.Optional(StringEnum(["direct", "specialist", "team"] as const)),
			role: Type.Optional(Type.String()),
			confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			reasons: Type.Optional(Type.Array(Type.String())),
			// Deprecated flat reviewer fields remain parseable for one compatibility cycle.
			reviewerPassed: Type.Optional(Type.Boolean({ description: "Legacy reviewer decision; use action=record_review for Goal V2." })),
			reviewerVerdict: Type.Optional(Type.Object({
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(Type.String()),
				verifiedSources: Type.Optional(Type.Number({ minimum: 0 })),
				checksPassed: Type.Optional(Type.Boolean()),
				reportPath: Type.Optional(Type.String()),
				notes: Type.Optional(Type.String()),
				// G7 (P0 fix): single 模式终审须 reviewer 表态 singleRationaleApproved. 之前 schema 漏了 → 死锁.
				singleRationaleApproved: Type.Optional(Type.Boolean({ description: "G7: For single+non-coding goals, reviewer's verdict on whether the singleRationale holds (terminal review). true=task can be single; false=should have been orchestrated (complete rejected)." })),
			})),
			// G3 (教训6): verdict 来源真实性. reviewerPassed=true (非 coding) 须携 reviewerAgentId +
			// reviewerSessionFile — handler 读该 jsonl 提取 report_role_result 的 findings, 验非空.
			// sessionFile 由 pi-core 写 (main agent 不可伪造), 是跨 ext 唯一独立验证路径.
			reviewerAgentId: Type.Optional(Type.String({ description: "agentId of the spawned reviewer session (from spawn_role result). Required for non-coding reviewerPassed=true (G3: verdict source authenticity)." })),
			reviewerSessionFile: Type.Optional(Type.String({ description: "sessionFile (.jsonl) of the spawned reviewer. Handler reads it to extract the reviewer's actual report_role_result findings (G3)." })),
			// G7 预审 (A): single+非coding 执行前预审 singleRationale. spawn reviewer 审理由 →
			// singleRationalePreApproved=true (轻量 reviewer, 只需 model+thinkingLevel+singleRationaleApproved).
			// true → status=approved (可执行); false → status=rejected (须降级).
			singleRationalePreApproved: Type.Optional(Type.Boolean({ description: "G7 pre-audit: write the reviewer's pre-approval of singleRationale. true→status=approved(can execute); false→status=rejected(must downgrade to orchestrated)." })),
			singleRationaleReviewer: Type.Optional(Type.Object({
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(Type.String()),
				singleRationaleApproved: Type.Boolean(),
			})),
			// G7 降级 (B): executionMode single→orchestrated (reviewer 拒后重做) 或重提 singleRationale.
			executionMode: Type.Optional(StringEnum(["single", "orchestrated"] as const)),
			singleRationale: Type.Optional(Type.String({ description: "G7: when downgrading to single, re-submit singleRationale (≥30 chars, re-audited)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!goal) {
				return { content: [{ type: "text", text: "No goal to update." }], isError: true, details: {} };
			}
				const normalized = normalizeUpdateGoalAction(params, { now: nowMs() });
				if (!normalized.ok) {
					return {
						content: [{ type: "text", text: normalized.reason }],
						isError: true,
						details: {
							kind: normalized.kind,
							...(normalized.code ? { code: normalized.code } : {}),
							...(normalized.recovery ? { recovery: normalized.recovery } : {}),
							...(normalized.code ? { completionCompatible: false } : {}),
						},
					};
				}
				for (const warning of normalized.warnings) console.warn("[pi-goal] " + warning);
					const action = normalized.action;
					if (isTerminalGoalStatus(goal.status) && action.action !== "submit_completion_bundle") {
						return {
							content: [{ type: "text", text: "Goal is terminal (" + goal.status + "); clear or replace it before recording new state." }],
							isError: true,
							details: { status: goal.status },
						};
					}
					if (action.action === "request_completion" && goal.status !== "active") {
						return {
							content: [{ type: "text", text: "Completion can only be requested while the goal is active; resume it first." }],
							isError: true,
							details: { status: goal.status },
						};
					}

				if (action.action === "record_evidence") {
					if (action.criterionIds.length + action.claimIds.length === 0 && action.evidence === null) {
						return { content: [{ type: "text", text: "Reusing evidence requires at least one criterionId or claimId target." }], isError: true, details: {} };
					}
					const unknownCriteria = action.criterionIds.filter((id) => !goal!.criteria.some((item) => item.id === id));
					const unknownClaims = action.claimIds.filter((id) => !goal!.claims.some((item) => item.id === id));
					if (unknownCriteria.length + unknownClaims.length > 0) {
						const allowedCriteria = goal.criteria.map((item) => item.id).sort();
						const allowedClaims = goal.claims.map((item) => item.id).sort();
						return {
							content: [{ type: "text", text: "Evidence targets do not exist: " + [...unknownCriteria, ...unknownClaims].join(", ") +
								". Allowed criterion IDs: " + (allowedCriteria.join(", ") || "none") +
								". Allowed claim IDs: " + (allowedClaims.join(", ") || "none") +
								". $constraint:n is a reviewer finding subject, never a criterion evidence target." }],
							isError: true,
							details: { allowedCriterionIds: allowedCriteria, allowedClaimIds: allowedClaims },
						};
					}
					const existing = goal.evidenceLedger.find((item) => item.id === action.evidenceId);
					if (!action.evidence && !existing) {
						return { content: [{ type: "text", text: "Evidence " + action.evidenceId + " does not exist in the ledger." }], isError: true, details: {} };
					}
					if (existing && action.evidence) {
						const comparable = (item: EvidenceRef) => ({ ...item, recordedAt: 0 });
						if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(action.evidence))) {
							return {
								content: [{ type: "text", text: "Evidence id \"" + action.evidenceId + "\" already exists with different content. Evidence IDs are immutable; create a new revision evidence ID and use it in reviewer constraints and completion. Reuse the existing ID only for the exact same ledger record." }],
								isError: true,
								details: { existingEvidenceId: action.evidenceId, recovery: "create_revision_evidence_id" },
							};
						}
						}
						// Proof-or-Stop: artifact 证据由文件系统机械校验，agent 自报的
						// verification 不再被信任（声称 verified 但文件不存在 → rejected）。
						const rawRecord = existing ?? action.evidence!;
						const record = mechanicallyVerifyEvidence(rawRecord, ctx.cwd);
						let outcomeChanged = !existing
							|| record.verification !== rawRecord.verification
							|| (record.verificationNote !== undefined && record.verificationNote !== rawRecord.verificationNote);
						if (!existing) goal.evidenceLedger.push(record);
					const conflicts: string[] = [];
					for (const criterionId of action.criterionIds) {
						const criterion = goal.criteria.find((item) => item.id === criterionId)!;
						const assessment = assessEvidence(record.summary, criterion.evidence.map((item) => item.summary));
						if (assessment.conflict) conflicts.push(assessment.conflict);
							if (!criterion.evidenceRefs.includes(record.id)) {
								outcomeChanged = true;
							criterion.evidenceRefs.push(record.id);
							criterion.evidence.push({
								id: record.id,
								kind: record.kind === "command" ? "tool_result" : record.kind,
								summary: record.summary,
								...(record.locator === undefined ? {} : { locator: record.locator }),
								...(record.sourceKind === undefined ? {} : { sourceKind: record.sourceKind }),
								...(record.independenceKey === undefined ? {} : { independenceKey: record.independenceKey }),
								origin: record.origin,
								recordedAt: record.recordedAt,
								verification: record.verification,
							});
						}
					}
					for (const claimId of action.claimIds) {
						const claim = goal.claims.find((item) => item.id === claimId)!;
						const claimEvidence = claim.evidenceRefs
							.map((id) => goal!.evidenceLedger.find((item) => item.id === id)?.summary)
							.filter((summary): summary is string => Boolean(summary));
						const assessment = assessEvidence(record.summary, claimEvidence);
						if (assessment.conflict) conflicts.push(assessment.conflict);
							if (!claim.evidenceRefs.includes(record.id)) {
								outcomeChanged = true;
								claim.evidenceRefs.push(record.id);
							}
						}
							let conflictExecution: ExecutionDecision | null = null;
							let nextAssurance = outcomeChanged
								? assuranceAfterOutcomeMutation(goal, goalConfig, "Outcome evidence changed after the prior assurance decision.")
								: goal.assurance;
							if (conflicts.length > 0) {
							conflictExecution = reassessGoalExecution({
								uncertainty: "high", coupling: "medium", risk: "high",
								specialistNeed: goal.execution.role ? "helpful" : "none",
								independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium",
							}, "conflict").execution;
								nextAssurance = assuranceAfterOutcomeMutation(
									goal,
									goalConfig,
									"Conflicting evidence requires independent review.",
									true,
								);
							}
							updateState({
								evidenceLedger: [...goal.evidenceLedger], criteria: [...goal.criteria], claims: [...goal.claims],
								...(conflictExecution ? { execution: conflictExecution } : {}),
								...(nextAssurance !== goal.assurance ? { assurance: nextAssurance } : {}),
						}, ctx);
					goalLog(ctx, "evidence_recorded", { entry: record, criterionIds: action.criterionIds, claimIds: action.claimIds });
					return {
						content: [{ type: "text", text: "Evidence recorded: " + record.id + (conflicts.length > 0 ? " (conflict diagnostics recorded)" : "") + (action.completionCompatible ? "" : " (legacy_text: not eligible for the V3 completion bundle; record structured evidence with an immutable id instead)") }],
					details: {
						evidenceId: record.id,
						criterionIds: action.criterionIds,
						claimIds: action.claimIds,
						conflicts,
						completionCompatible: action.completionCompatible,
						...(action.completionCompatible ? {} : { recovery: "provide_structured_evidence_with_immutable_id" }),
					},
				};
				}

					if (action.action === "upsert_claim") {
					const missing = action.claim.evidenceRefs.filter((ref) => !goal!.evidenceLedger.some((evidence) => evidence.id === ref));
					if (missing.length > 0) return { content: [{ type: "text", text: "Claim references unknown evidence: " + missing.join(", ") }], isError: true, details: {} };
						const index = goal.claims.findIndex((item) => item.id === action.claim.id);
						const changed = index < 0 || JSON.stringify(goal.claims[index]) !== JSON.stringify(action.claim);
						if (index >= 0) goal.claims[index] = action.claim; else goal.claims.push(action.claim);
						const highRiskMaterial = action.claim.materiality === "material" && action.claim.risk === "high";
						const assurance = changed
							? assuranceAfterOutcomeMutation(
								goal,
								goalConfig,
								highRiskMaterial ? "A high-risk material claim requires fresh assurance." : "Research claims changed after the prior assurance decision.",
								highRiskMaterial,
							)
							: goal.assurance;
						updateState({ claims: [...goal.claims], ...(assurance !== goal.assurance ? { assurance } : {}) }, ctx);
					return { content: [{ type: "text", text: "Claim saved: " + action.claim.id }], details: { claim: action.claim } };
				}

				if (action.action === "request_completion") {
					// UX-P0-02：需要独立 reviewer 的 Contract V3 Goal 的完成协议是
					// reviewer + submit_completion_bundle。request_completion 必须
					// fail fast——不写 pending、不改状态，避免 turn 结束时误入 V2
					// completion judge，也避免 usesAtomicCompletionV3 因 requestedAt
					// 被污染而降级协议提示。
					if (requiresAtomicCompletionV3(goal)) {
						const criterionIds = goal.criteria.map((criterion) => criterion.id);
						return {
							content: [{ type: "text", text: "This goal requires the Contract V3 atomic completion protocol. Run the read-only goal-reviewer via spawn_role with resultConstraints (criterionIds " + JSON.stringify(criterionIds) + ", exact submitted evidenceIds and artifactUris), then submit artifacts, evidence, deterministicChecks and the reviewerResultRef in one update_goal action=submit_completion_bundle call. request_completion is not accepted for this goal; no pending completion was written and goal state is unchanged." }],
							isError: true,
							details: {
								code: "atomic_completion_required",
								recovery: "spawn_goal_reviewer_then_submit_completion_bundle",
								completionProtocol: "atomic-v3",
								statusUnchanged: true,
							},
						};
					}
					const requestedAt = Math.max(
						nowMs(),
						(goal.completion.requestedAt ?? -1) + 1,
						(goal.completion.lastEvaluation?.evaluatedAt ?? -1) + 1,
					);
					updateState({ completion: { ...goal.completion, summary: action.summary, requestedAt } }, ctx);
					goalLog(ctx, "completion_requested", { summary: action.summary });
					return { content: [{ type: "text", text: "Completion evaluation requested." }], details: { requestedAt } };
				}

				if (action.action === "record_review") {
					let transcript: string;
					try { transcript = fs.readFileSync(action.review.sessionFile, "utf8"); }
					catch (error) {
						return { content: [{ type: "text", text: "Reviewer session is unreadable: " + (error instanceof Error ? error.message : String(error)) }], isError: true, details: {} };
						}
						const extracted = extractReviewerFindings(transcript);
						const parentSession = ctx.sessionManager.getSessionFile?.();
						if (!parentSession) {
							return { content: [{ type: "text", text: "Current goal session has no stable session file for reviewer provenance." }], isError: true, details: {} };
						}
						const verified = verifyReviewerSource(
							action.review.evaluator.agentId,
							action.review.sessionFile,
							extracted,
							{ parentSession, role: "reviewer", sessionId: action.review.evaluator.sessionId },
						);
						if (!verified.ok) return { content: [{ type: "text", text: verified.reason ?? "Reviewer source verification failed." }], isError: true, details: {} };
						const transcriptDecision = reviewerTranscriptDecision(extracted.findings);
						if (transcriptDecision === null) {
							return { content: [{ type: "text", text: "Reviewer findings[0] must declare an explicit Ready/Approved or Not ready/Rejected verdict." }], isError: true, details: {} };
						}
						if (transcriptDecision !== action.review.status) {
							return { content: [{ type: "text", text: "Submitted review status contradicts the reviewer transcript verdict." }], isError: true, details: {} };
						}
						if (action.review.status === "failed" && action.review.findings.length === 0) {
							return { content: [{ type: "text", text: "A failed review must include structured blocking findings." }], isError: true, details: {} };
						}
						if (action.review.status === "passed" && action.review.findings.length > 0) {
							return { content: [{ type: "text", text: "A passed review cannot carry blocking findings; record them as advisories or mark the review failed." }], isError: true, details: {} };
						}
					for (const finding of action.review.findings) {
						const constraintMatch = finding.subjectId.match(/^\$constraint:(\d+)$/);
						const knownConstraint = Boolean(constraintMatch && Number(constraintMatch[1]) < goal.constraints.length);
						const known = finding.subjectId === "$goal"
							|| knownConstraint
							|| goal.criteria.some((item) => item.id === finding.subjectId)
							|| goal.claims.some((item) => item.id === finding.subjectId);
						if (!known) return { content: [{ type: "text", text: "Review finding references unknown subject " + finding.subjectId }], isError: true, details: {} };
						const unknownEvidence = (finding.evidenceRefs ?? []).filter((id) => !goal!.evidenceLedger.some((item) => item.id === id));
						if (unknownEvidence.length > 0) {
							return { content: [{ type: "text", text: "Review finding references unknown evidence: " + unknownEvidence.join(", ") }], isError: true, details: {} };
						}
							if ((finding.evidenceRefs ?? []).length === 0 && !finding.missingEvidenceKind) {
								return { content: [{ type: "text", text: "A review finding must cite evidenceRefs or declare missingEvidenceKind." }], isError: true, details: {} };
							}
							if (!transcriptBindsFinding(extracted.findings, finding)) {
								return { content: [{ type: "text", text: "Structured review finding " + finding.subjectId + " is not bound to the reviewer transcript and its evidence/missing-evidence key." }], isError: true, details: {} };
							}
					}
					const fingerprint = action.review.status === "passed" ? null : createHash("sha256").update(JSON.stringify({
						policy: "goal_completion_policy_v2",
						failures: action.review.findings.map((item) => ({ code: item.code, subjectId: item.subjectId, missingEvidenceKind: item.missingEvidenceKind ?? null }))
							.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
					})).digest("hex");
					const evaluation: CompletionEvaluation = {
						decision: action.review.status === "passed" ? "accept" : "revise",
						evaluatedAt: nowMs(), criterionCoverage: [], claimCoverage: [],
						findings: action.review.findings, advisories: action.review.advisories,
							evaluator: {
								kind: "reviewer",
								agentId: extracted.provenance!.agentId,
								sessionId: extracted.sessionId,
								reportDigest: createHash("sha256").update(transcript).digest("hex"),
							legacySessionFile: action.review.sessionFile,
						},
						fingerprint,
					};
					if (action.review.status === "failed") {
						const transition = applyAuthoritativeCompletionEvaluation(goal, evaluation);
						updateState({
							assurance: { ...goal.assurance, reviewStatus: "failed" },
							completion: transition.completion,
							...(transition.status === "paused" ? { status: "paused", pausedReason: transition.pausedReason } : {}),
						}, ctx);
						goalLog(ctx, "review_recorded", { status: "failed", findings: action.review.findings.length, advisories: action.review.advisories.length });
						if (transition.status === "paused") {
							clearTimer();
							userSuspended = true;
						}
						return {
							content: [{ type: "text", text: "Independent review recorded: failed (" + transition.rejectionAction + ")" }],
							details: { evaluation, rejectionAction: transition.rejectionAction },
						};
					}
					updateState({
						assurance: { ...goal.assurance, reviewStatus: "passed" },
						completion: { ...goal.completion, lastEvaluation: evaluation, rejectionCount: 0 },
					}, ctx);
					goalLog(ctx, "review_recorded", { status: "passed", findings: action.review.findings.length, advisories: action.review.advisories.length });
					return { content: [{ type: "text", text: "Independent review recorded: passed" }], details: { evaluation } };
				}

						if (action.action === "change_execution") {
							if (goal.execution.source === "user") {
								return { content: [{ type: "text", text: "Execution preference is user-locked and cannot be changed by an agent tool call." }], isError: true, details: { execution: goal.execution } };
							}
							if (action.routing) {
							const rerouted = reassessGoalExecution(action.routing.signals, action.routing.trigger);
							if (rerouted.blockedReason) return { content: [{ type: "text", text: rerouted.blockedReason }], isError: true, details: {} };
							if (!rerouted.execution) return { content: [{ type: "text", text: "Execution remains " + goal.execution.selected + "." }], details: { execution: goal.execution } };
							updateState({ execution: rerouted.execution }, ctx);
							return { content: [{ type: "text", text: "Execution reassessed to " + rerouted.execution.selected + "." }], details: { execution: rerouted.execution } };
						}
							const requested = action.execution!;
							const activeTools = new Set(pi.getActiveTools());
							if (requested.selected === "team" && !activeTools.has("dag_execute")) {
								return { content: [{ type: "text", text: "team execution requires the active dag_execute tool." }], isError: true, details: {} };
							}
							if (requested.selected === "specialist" && activeTools.has("list_roles") && observedRoleCatalog === null) {
								return { content: [{ type: "text", text: "Call list_roles before changing to specialist execution." }], isError: true, details: { requiredTool: "list_roles" } };
							}
							if (requested.selected === "specialist" && (!requested.role
								|| !activeTools.has("spawn_role")
								|| observedRoleCatalog === null
								|| !observedRoleCatalog.includes(requested.role))) {
								return { content: [{ type: "text", text: "specialist execution requires an active spawn_role tool and a role from the observed list_roles catalog." }], isError: true, details: { availableRoles: observedRoleCatalog ?? [] } };
							}
							const execution: ExecutionDecision = {
								...requested,
								source: requested.source === "legacy" ? "legacy" : "auto",
							};
							if (execution.selected === "specialist" && !execution.role) {
							return { content: [{ type: "text", text: "specialist execution requires a registered role." }], isError: true, details: {} };
						}
						updateState({ execution }, ctx);
						return { content: [{ type: "text", text: "Execution changed to " + execution.selected + "." }], details: { execution } };
				}

				if (action.action === "pause") {
					pauseGoal(action.reason, ctx);
					ctx.ui?.notify?.("Goal paused: needs your input — " + action.reason, "warning");
					return { content: [{ type: "text", text: "Goal paused for user input: " + action.reason + " (reply to resume with guidance, or /goal resume)" }], details: { status: "paused", reason: action.reason } };
				}
				if (action.action === "record_deviation") {
					const deviation: DeviationRecord = {
						id: "d" + randomUUID().slice(0, 6),
						...(action.subjectId ? { subjectId: action.subjectId } : {}),
						description: action.description,
						reason: action.reason,
						...(action.impact ? { impact: action.impact } : {}),
						recordedAt: nowMs(),
						origin: "agent",
					};
					// 有限账本：超出 20 条折叠（防失控）。
					const capped = [...goal.deviations, deviation].slice(-20);
					updateState({ deviations: capped }, ctx);
					goalLog(ctx, "deviation_recorded", { deviation });
					return {
						content: [{ type: "text", text: "Deviation recorded: " + deviation.id + " — " + deviation.description }],
						details: { deviation },
					};
				}
				if (action.action === "submit_completion_bundle") {
					const completionPreflight = preflightCompletionSubmissionV3(goal, action);
					if (completionPreflight.outcome === "replay") {
						return {
							content: [{ type: "text", text: "Completion bundle replay accepted; the goal was already completed." }],
							details: { replayed: true, transaction: completionPreflight.transaction },
						};
					}
					if (completionPreflight.outcome === "conflict") {
						return {
							content: [{ type: "text", text: "The completion idempotency key was already committed with a different payload." }],
							isError: true,
							details: { kind: "idempotency_conflict", transaction: completionPreflight.transaction },
						};
					}
					if (completionPreflight.outcome === "terminal") {
						return { content: [{ type: "text", text: completionPreflight.reason }], isError: true, details: { kind: "completion_bundle_rejected" } };
					}
					const branch = ctx.sessionManager.getBranch();
					const resolved = resolveRoleResultFromBranch(branch, action.reviewerResultRef as RoleResultRefV1);
					if (!resolved.ok) {
						return { content: [{ type: "text", text: resolved.reason }], isError: true, details: { kind: "reviewer_result_missing" } };
					}
					const operation = captureActiveGoalOperation();
					if (!operation) {
						return { content: [{ type: "text", text: "Completion bundle requires the same active goal run for its full verification and commit." }], isError: true, details: { kind: "operation_superseded", status: goal.status } };
					}
					const verification = goalConfig.verifyCommand
						? await runVerifyCommand(goalConfig.verifyCommand, goalConfig.verifyTimeoutMs ?? 120_000)
						: undefined;
					if (!isActiveGoalOperation(operation) || !goal) {
						return { content: [{ type: "text", text: "Completion bundle was not committed because the active goal run changed during verification." }], isError: true, details: { kind: "operation_superseded", status: goal?.status ?? null } };
					}
					const prepared = prepareCompletionBundleV3({
						goal,
						action,
						reviewerResult: resolved.result,
						cwd: ctx.cwd,
						now: nowMs(),
						...(goalConfig.verifyCommand === undefined ? {} : { verifyCommand: goalConfig.verifyCommand }),
						...(verification === undefined ? {} : { verifyResult: verification }),
					});
					if (!prepared.ok) {
						if (prepared.reason === "IDEMPOTENT_REPLAY") {
							return { content: [{ type: "text", text: "Completion bundle replay accepted; the goal was already completed." }], details: { replayed: true, transaction: prepared.details?.transaction } };
						}
						if (prepared.reason === "IDEMPOTENCY_CONFLICT") {
							return { content: [{ type: "text", text: "The completion idempotency key was already committed with a different payload." }], isError: true, details: { kind: "idempotency_conflict", ...(prepared.details ?? {}) } };
						}
						return { content: [{ type: "text", text: prepared.reason }], isError: true, details: { kind: "completion_bundle_rejected", ...(prepared.details ?? {}) } };
					}
					updateState(prepared.patch, ctx);
					goalLog(ctx, "completion_bundle_committed", {
						idempotencyKey: action.idempotencyKey,
						bundleDigest: completionBundleDigest(prepared.bundle),
						reviewerResultId: action.reviewerResultRef.resultId,
					});
					return {
						content: [{ type: "text", text: "Completion bundle committed atomically; goal complete." }],
						details: { status: "complete", replayed: false, transaction: goal.completionTransaction },
					};
				}
				if (action.action !== "mark_unmet") {
					return { content: [{ type: "text", text: "Unsupported goal action." }], isError: true, details: {} };
				}
				updateState({ status: "unmet", blocker: action.blocker, noProgressCount: 0 }, ctx);
				return { content: [{ type: "text", text: "Goal marked unmet: " + action.blocker }], details: { status: "unmet" } };

			/* LEGACY V1 HANDLER RETIRED: preserved below for one release as source-level migration documentation.
			if (params.criterionId && params.evidence) {
				const criterion = goal.criteria.find((c) => c.id === params.criterionId);
				if (!criterion) {
					return { content: [{ type: "text", text: "Criterion \"" + params.criterionId + "\" not found." }], isError: true, details: {} };
				}
				// Dedup + conflict check against already-recorded evidence for this criterion.
				// Near-duplicate -> skip (no new info); contradiction -> warn but still record.
				const assessment = assessEvidence(params.evidence, criterion.evidence);
				if (assessment.duplicate) {
					return { content: [{ type: "text", text: "Evidence skipped (near-duplicate of an existing entry for \"" + criterion.description + "\"): " + params.evidence }], details: { criterionId: criterion.id, skipped: true } };
				}
				if (assessment.conflict) {
					console.warn("[pi-goal] evidence conflict for criterion \"" + criterion.id + "\": " + assessment.conflict);
				}
				criterion.evidence.push(params.evidence);
				updateState({ criteria: [...goal.criteria] }, ctx);
				return { content: [{ type: "text", text: "Evidence recorded for \"" + criterion.description + "\": " + params.evidence }], details: { criterionId: criterion.id } };
			}
			// G7 预审 (A): single+非coding 执行前预审 singleRationale. spawn reviewer 审理由 →
			// singleRationalePreApproved=true (轻量 reviewer) → status=approved; false → status=rejected.
			if (params.singleRationalePreApproved !== undefined) {
				if (!goal.taskType || goal.taskType === "coding" || goal.executionMode !== "single") {
					return { content: [{ type: "text", text: "singleRationalePreApproved only applies to single+non-coding goals. This goal is taskType=" + (goal.taskType ?? "undefined") + " executionMode=" + (goal.executionMode ?? "undefined") + "." }], isError: true, details: {} };
				}
				if (goal.singleRationaleStatus !== "pending") {
					return { content: [{ type: "text", text: "singleRationaleStatus is " + (goal.singleRationaleStatus ?? "undefined") + " — pre-audit only allowed while pending. Already audited; to re-audit after downgrade/re-submit, downgrade first (executionMode=orchestrated) then back to single to reset to pending." }], isError: true, details: {} };
				}
				const reviewer = params.singleRationaleReviewer;
				if (!reviewer) {
					return { content: [{ type: "text", text: "singleRationalePreApproved requires singleRationaleReviewer {model, thinkingLevel, singleRationaleApproved} from the spawned pre-audit reviewer." }], isError: true, details: {} };
				}
				const contract = validateSingleRationalePreApproval(reviewer);
				if (!contract.ok) return { content: [{ type: "text", text: "singleRationaleReviewer contract not satisfied: " + (contract.reason ?? "unknown") }], isError: true, details: {} };
				// 预审结果必须与 singleRationalePreApproved 一致 (防 main agent 自报 reviewer 说 true 但传 false).
				if (reviewer.singleRationaleApproved !== params.singleRationalePreApproved) {
					return { content: [{ type: "text", text: "singleRationaleReviewer.singleRationaleApproved (" + reviewer.singleRationaleApproved + ") ≠ singleRationalePreApproved (" + params.singleRationalePreApproved + "). Inconsistent — write the reviewer's actual verdict." }], isError: true, details: {} };
				}
				const newStatus = params.singleRationalePreApproved ? "approved" : "rejected";
				updateState({ singleRationaleStatus: newStatus }, ctx);
				return { content: [{ type: "text", text: "singleRationale pre-audit: " + (params.singleRationalePreApproved ? "APPROVED → status=approved, 可开始执行 (终局仍须 reviewer 验收)" : "REJECTED → status=rejected, 须降级 update_goal({executionMode:\"orchestrated\"})") + "." }], details: { singleRationaleStatus: newStatus } };
			}
			// G7 降级 (B): executionMode 改写. single→orchestrated (reviewer 拒后重做) 或重提 single.
			if (params.executionMode !== undefined && params.executionMode !== goal.executionMode) {
				const toSingle = params.executionMode === "single";
				// 升级/重入 single 须重提 singleRationale (且须重新预审).
				if (toSingle) {
					const r = (params.singleRationale ?? "").trim();
					if (r.length < 30) {
						return { content: [{ type: "text", text: "Downgrade/re-enter single requires singleRationale (≥30 chars) explaining why single is appropriate — will be re-audited by reviewer (pending)." }], isError: true, details: {} };
					}
					updateState({ executionMode: "single", singleRationale: params.singleRationale, singleRationaleStatus: "pending", reviewerPassed: false, reviewerVerdict: undefined, reviewerAgentId: undefined, reviewerSessionFile: undefined }, ctx);
					return { content: [{ type: "text", text: "executionMode → single. singleRationale reset to pending — must re-run pre-audit before executing." }], details: { executionMode: "single", singleRationaleStatus: "pending" } };
				}
			// →orchestrated: 清 single 相关状态.
				updateState({ executionMode: "orchestrated", singleRationale: undefined, singleRationaleStatus: undefined, reviewerPassed: false, reviewerVerdict: undefined, reviewerAgentId: undefined, reviewerSessionFile: undefined }, ctx);
				return { content: [{ type: "text", text: "executionMode → orchestrated. singleRationale cleared; switch to spawn-role orchestration. Reviewer gate still applies on complete." }], details: { executionMode: "orchestrated" } };
			}
			// 深修 D: reviewer APPROVE writeback — flip reviewerPassed to open the complete gate.
			if (params.reviewerPassed !== undefined) {
				// 第2+3条: reviewerPassed=true 须携 reviewerVerdict, 验契约 + 重跑 quality-gates 验真伪.
				if (params.reviewerPassed && goal.taskType && goal.taskType !== "coding") {
					const verdict = params.reviewerVerdict;
					if (!verdict) {
						return { content: [{ type: "text", text: "reviewerPassed=true requires structured reviewer audit data and a spawned-session transcript; model, thinking level, and source counts are diagnostics only." }], isError: true, details: {} };
					}
					const contract = validateReviewerVerdict(verdict);
					if (!contract.ok) {
						return { content: [{ type: "text", text: "Reviewer verdict contract not satisfied: " + (contract.reason ?? "unknown") }], isError: true, details: {} };
					}
					// 第3条: 读 reportPath 重跑 quality-gates, 验 reviewer 自报 checksPassed 真伪.
					if (verdict.reportPath) {
						let reportText = "";
						try {
							reportText = fs.readFileSync(verdict.reportPath, "utf8");
						} catch (e) {
							return { content: [{ type: "text", text: "reviewerVerdict.reportPath unreadable: " + verdict.reportPath + " (" + (e as Error).message + "). Cannot re-verify quality gates (第3条)." }], isError: true, details: {} };
						}
						const qg = verifyQualityGates(reportText, goal.taskType);
						if (!qg.ok && qg.blocking !== false) {
							return { content: [{ type: "text", text: "Quality gates re-verify BLOCKED (第3条, not trusting reviewer self-report): " + (qg.reason ?? "unknown") + "." }], isError: true, details: { metrics: qg.metrics, blocking: qg.blocking } };
						}
						if (!verdict.checksPassed) {
							return { content: [{ type: "text", text: "reviewerVerdict.checksPassed=false — reviewer did not approve the work. Fix the report or submit reviewerPassed=false." }], isError: true, details: { qualityGateDiagnostics: qg.metrics, qualityGateWarning: qg.ok ? undefined : qg.reason } };
						}
					}
					// G3 (教训6): verdict 来源真实性 — 必须指向一个真实的 spawn reviewer session.
				// 读 reviewerSessionFile (.jsonl, sub-session 独有文件, pi-core 写、不可伪造), 提取
				// report_role_result 的 findings, 验非空. 纯决策走 verifyReviewerSource (已单测).
				if (!params.reviewerAgentId || !params.reviewerSessionFile) {
					return { content: [{ type: "text", text: "reviewerPassed=true for non-coding goal requires reviewerAgentId + reviewerSessionFile (G3: verdict source authenticity). The verdict must come from a real spawned reviewer session, not a self-constructed JSON. Re-spawn a reviewer and pass its agentId + sessionFile." }], isError: true, details: {} };
				}
				let reviewerJsonl = "";
				try {
					reviewerJsonl = fs.readFileSync(params.reviewerSessionFile, "utf8");
				} catch (e) {
					return { content: [{ type: "text", text: "reviewerSessionFile unreadable: " + params.reviewerSessionFile + " (" + (e as Error).message + "). Cannot verify the reviewer actually reported (G3)." }], isError: true, details: {} };
				}
				const extracted = extractReviewerFindings(reviewerJsonl);
				const source = verifyReviewerSource(params.reviewerAgentId, params.reviewerSessionFile, extracted);
				if (!source.ok) {
					return { content: [{ type: "text", text: source.reason ?? "Reviewer source verification failed (G3)." }], isError: true, details: {} };
				}
				updateState({ reviewerPassed: params.reviewerPassed, reviewerVerdict: verdict, reviewerAgentId: params.reviewerAgentId, reviewerSessionFile: params.reviewerSessionFile }, ctx);
				} else {
					updateState({ reviewerPassed: params.reviewerPassed }, ctx);
				}
				return { content: [{ type: "text", text: "Reviewer gate " + (params.reviewerPassed ? "OPENED (approved)" : "CLOSED (rejected)") + "." }], details: { reviewerPassed: params.reviewerPassed } };
			}
			if (params.status === "complete") {
				if (!params.evidence) return { content: [{ type: "text", text: "Evidence is required." }], isError: true, details: {} };
				// 深修 D: route through canComplete gate (evidence + reviewer for non-coding).
				const gate = canComplete(goal);
				if (!gate.ok) {
					return { content: [{ type: "text", text: "Cannot mark complete: " + (gate.reason ?? "gate failed") }], isError: true, details: {} };
				}
				updateState({ status: "complete", completionEvidence: params.evidence, noProgressCount: 0 }, ctx);
				pi.sendMessage(
					{ customType: GOAL_EVENT_TYPE, content: "Goal achieved! \u2705\n\nObjective: " + goal.objective + "\nEvidence: " + params.evidence, display: true, details: { kind: "complete", goal: { ...goal, status: "complete" }, progress: progressFor(goal) } },
					{ triggerTurn: false },
				);
				return { content: [{ type: "text", text: "Goal complete: " + goal.objective }], details: { goal: { ...goal, status: "complete" } } };
			}
			if (params.status === "unmet") {
				if (!params.blocker) return { content: [{ type: "text", text: "Blocker is required." }], isError: true, details: {} };
				updateState({ status: "unmet", blocker: params.blocker, noProgressCount: 0 }, ctx);
				return { content: [{ type: "text", text: "Goal unmet: " + params.blocker }], details: { goal: { ...goal, status: "unmet" } } };
			}
			return { content: [{ type: "text", text: "Use criterionId+evidence or status:complete|unmet." }], isError: true, details: {} };
			*/
		},
	});

	pi.registerTool({
		name: "propose_goal_draft", label: "Propose Goal Draft",
		description: "Propose a Goal V2 draft after calling list_roles when available. Includes adaptive execution and risk-based assurance decisions.",
		parameters: Type.Object({
			objective: Type.String({ description: "Concise 1-2 sentence objective." }),
			criteria: Type.Array(Type.Union([
				Type.String(),
				Type.Object({ description: Type.String(), level: Type.Optional(StringEnum(["blocking", "advisory"] as const)) }),
			]), { minItems: 1, description: "One or more genuine outcome criteria; do not add workflow/source-count criteria to meet a quota." }),
			constraints: Type.Optional(Type.Array(Type.String())),
			taskKind: Type.Optional(StringEnum(TASK_KINDS)),
			executionPreference: Type.Optional(StringEnum(["auto", "direct", "specialist", "team"] as const)),
			role: Type.Optional(Type.String({ description: "Registered specialist role selected from list_roles." })),
			availableRoles: Type.Optional(Type.Array(Type.String({ description: "Role names returned by list_roles." }))),
			roleCatalogAvailable: Type.Optional(Type.Boolean()),
				routing: Type.Optional(Type.Object({
				uncertainty: StringEnum(["low", "medium", "high"] as const),
				coupling: StringEnum(["low", "medium", "high"] as const),
				risk: StringEnum(["low", "medium", "high"] as const),
				specialistNeed: StringEnum(["none", "helpful", "required"] as const),
				independentWorkstreams: Type.Number({ minimum: 0 }),
				heterogeneousSkills: Type.Boolean(),
				effort: StringEnum(["small", "medium", "large"] as const),
				confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				})),
			assurance: Type.Optional(Type.Object({
				risk: StringEnum(["low", "medium", "high"] as const),
				hasHighRiskClaims: Type.Optional(Type.Boolean()),
				hasEvidenceConflict: Type.Optional(Type.Boolean()),
				irreversibleExternalAction: Type.Optional(Type.Boolean()),
				userRequiresReviewer: Type.Optional(Type.Boolean()),
			})),
			researchClaims: Type.Optional(Type.Array(Type.Object({
				id: Type.String(), text: Type.String(),
				materiality: StringEnum(["material", "supporting"] as const),
				risk: Type.Optional(StringEnum(["ordinary", "high"] as const)),
				evidenceRefs: Type.Optional(Type.Array(Type.String())),
			}))),
			tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
			// 深层目标（设计/架构/多子系统）的实现结构理解，写入 spec 文档供用户微调。
			structure: Type.Optional(Type.String({ description: "For deep goals (design/architecture, multiple subsystems, tech selection, contracts): the structural understanding — module breakdown, data flow, critical path, contracts, failure modes. Omit for shallow goals." })),
			// Spec 澄清：模型判断目标存在真实歧义时，不创建 goal，先返回待确认问题。
			needsClarification: Type.Optional(Type.Boolean({ description: "Set true when the objective has genuine ambiguity that should be clarified with the user before drafting. Simple, well-scoped goals must omit this." })),
			openQuestions: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { description: "Open questions to clarify with the user, ordered by importance. No count limit — ask everything that genuinely matters. Leave empty unless needsClarification is true." })),
			// Deprecated aliases.
			taskType: Type.Optional(StringEnum(["coding", "research", "document", "business", "pm", "review"] as const)),
			executionMode: Type.Optional(StringEnum(["single", "orchestrated"] as const)),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const raw = params as Record<string, any>;
			if (raw.executionPreference && raw.executionMode) return { content: [{ type: "text", text: "Use executionPreference or legacy executionMode, not both." }], isError: true, details: {} };
			const objective = raw.objective.trim();
			let criteria: GoalCriterionDraft[] = raw.criteria.map((criterion: string | { description: string; level?: GateLevel }) =>
				typeof criterion === "string"
					? { description: criterion.trim(), level: "blocking" }
					: { description: criterion.description.trim(), level: criterion.level ?? "blocking" },
			);
			// UX finding: the draft writer keeps adding environment-state gates
			// ("git status must be clean", "tracked changes must be zero") that are
			// unrelated to the outcome and unsatisfiable on a dirty worktree.
			// Downgrade them to advisory so they cannot block completion.
			const { criteria: gatedCriteria, downgraded } = downgradeEnvironmentStateGates(criteria, objective);
			criteria = gatedCriteria;
			if (downgraded.length > 0 && ctx.hasUI) {
				ctx.ui.notify("Downgraded " + downgraded.length + " environment-state gate(s) to advisory (repo/worktree state is not a task outcome):\n" + downgraded.join("\n"), "info");
			}
			const constraints: string[] | undefined = raw.constraints?.map((constraint: string) => constraint.trim());
			const claims: ResearchClaim[] = (raw.researchClaims ?? []).map((claim: ResearchClaim) => ({
				...claim,
				id: claim.id.trim(),
				text: claim.text.trim(),
				evidenceRefs: (claim.evidenceRefs ?? []).map((ref) => ref.trim()),
			}));
			const proposalCheck = validateGoalProposal({
				objective,
				taskType: raw.taskKind ?? raw.taskType,
				executionMode: raw.executionMode,
				executionPreference: raw.executionPreference,
				criteria,
				constraints,
				researchClaims: claims,
			});
			if (!proposalCheck.ok) {
				return { content: [{ type: "text", text: proposalCheck.reason ?? "Invalid goal proposal." }], isError: true, details: {} };
			}
			const taskKind = (raw.taskKind ?? raw.taskType ?? "general") as TaskKind;
			const signals: ExecutionRoutingSignals = raw.routing ?? {
				uncertainty: "medium", coupling: "medium", risk: raw.assurance?.risk ?? "low",
				specialistNeed: raw.role ? "helpful" : "none", independentWorkstreams: 1,
				heterogeneousSkills: false, effort: criteria.length >= 4 ? "large" : "medium",
			};
			const activeTools = new Set(pi.getActiveTools());
			if (activeTools.has("list_roles") && observedRoleCatalog === null) {
				return {
					content: [{ type: "text", text: "Call list_roles before propose_goal_draft so routing uses the real registered role catalog." }],
					isError: true,
					details: {
						requiredTool: "list_roles",
						// UX-P2-03：结构化恢复字段，不改变路由策略。
						nextAction: "call_list_roles_then_retry_propose_goal_draft",
						roleCatalogRequired: true,
					},
				};
			}
			const rawAvailableRoles: unknown[] = observedRoleCatalog ?? (Array.isArray(raw.availableRoles) ? raw.availableRoles : []);
			const availableRoles: string[] = [...new Set(rawAvailableRoles
				.filter((role): role is string => typeof role === "string")
				.map((role) => role.trim())
				.filter(Boolean))];
			const roleCatalogAvailable = observedRoleCatalog !== null || raw.roleCatalogAvailable === true || raw.availableRoles !== undefined;
			const registeredRole = typeof raw.role === "string" ? raw.role.trim() : "";
			const roleIsRegistered = Boolean(registeredRole && availableRoles.includes(registeredRole));
			const roleExecutionAvailable = roleCatalogAvailable && availableRoles.length > 0;
			const availableModes: Array<"direct" | "specialist" | "team"> = ["direct"];
			if (roleExecutionAvailable && activeTools.has("spawn_role")) availableModes.push("specialist");
			if (roleExecutionAvailable && activeTools.has("dag_execute")) availableModes.push("team");
			const preference: ExecutionPreference = raw.executionPreference
					?? (raw.executionMode === "single" ? "direct" : raw.executionMode === "orchestrated" ? "auto" : undefined)
					?? goalConfig.defaultExecution
					?? "auto";
			const preferredMode = raw.executionMode === "orchestrated"
				? "specialist" as const
				: preference === "auto" ? undefined : preference;
			if ((preference === "specialist" || raw.executionMode === "orchestrated")
				&& (!roleIsRegistered || !availableModes.includes("specialist"))) {
				return {
					content: [{ type: "text", text: "The specialist route requires an active spawn_role tool and a matching registered role from list_roles." }],
					isError: true,
					details: { availableRoles },
				};
			}
			let routed = routeExecution({
				signals,
				availableModes,
				...(preferredMode ? { preferredMode } : {}),
			});
			if (routed.status === "blocked") return { content: [{ type: "text", text: routed.reasons.join(" ") }], isError: true, details: { route: routed } };
			if (routed.mode === "specialist" && !roleIsRegistered) {
				if (preference === "specialist" || raw.executionMode === "orchestrated") {
					return { content: [{ type: "text", text: "The specialist route requires a matching registered role from list_roles." }], isError: true, details: { availableRoles } };
				}
				const fallback = routeExecution({ signals, availableModes: availableModes.filter((mode) => mode !== "specialist") });
				if (fallback.status === "blocked") return { content: [{ type: "text", text: fallback.reasons.join(" ") }], isError: true, details: { route: fallback } };
				routed = {
					...fallback,
					reasons: [...routed.reasons, "No matching registered specialist role is available; falling back to direct and retaining reassessment triggers.", ...fallback.reasons],
					shouldReassess: true,
				};
			}
			const execution: ExecutionDecision = {
				preference,
				selected: routed.mode,
				...(routed.mode === "specialist" ? { role: registeredRole } : {}),
				source: raw.executionMode ? "legacy" : "auto",
				confidence: raw.routing?.confidence ?? (raw.routing ? 0.75 : 0.5),
				reasons: routed.reasons,
				...(raw.executionMode === "orchestrated" ? { minimum: "specialist" as const } : {}),
				reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
			};
			const assuranceInput = {
				...(raw.assurance ?? { risk: "low" }),
					hasHighRiskClaims: Boolean(raw.assurance?.hasHighRiskClaims)
						|| claims.some((claim) => claim.materiality === "material" && claim.risk === "high"),
			};
			const reviewer = selectReviewerPolicy({ ...assuranceInput, taskType: taskKind, deterministicVerificationAvailable: Boolean(goalConfig.verifyCommand) });
			const requirement = goalConfig.reviewPolicy === "always" ? "required" : goalConfig.reviewPolicy === "never" ? "none" : reviewer.mode;
			const assurance: AssuranceDecision = {
				reviewRequirement: requirement,
				reviewStatus: requirement === "none" ? "not_required" : "pending",
				independent: requirement !== "none",
				depth: requirement === "required" ? "deep" : reviewer.depth,
				source: raw.assurance?.userRequiresReviewer ? "user" : "auto",
				reasons: goalConfig.reviewPolicy === "always" ? ["reviewPolicy=always"] : goalConfig.reviewPolicy === "never" ? ["reviewPolicy=never"] : reviewer.reasons,
				decidedAt: nowMs(),
			};
			const proposal: GoalProposal = {
				objective, criteria, constraints: constraints ?? [], taskKind,
				executionPreference: preference, execution, assurance,
				claims,
				...(typeof raw.structure === "string" && raw.structure.trim() ? { structure: raw.structure.trim() } : {}),
			};
			// Spec 澄清（UX: 用户两三句话 → agent 展开的细节可能与意图相左）。
			// 模型声明存在真实歧义时，不创建 goal，把 1-2 个最关键的问题交给主
			// agent 逐一询问用户；回答进入对话上下文后，模型应带新理解重 draft。
			const questions = (raw.openQuestions ?? [])
				.map((question: unknown) => typeof question === "string" ? question.trim() : "")
				.filter(Boolean);
			if (raw.needsClarification === true && questions.length > 0) {
				const uniqueQuestions = [...new Set(questions)];
				return {
					content: [{ type: "text", text: "Goal clarification needed before drafting. Ask the user the following question(s) in order of importance (one round per response; incorporate each answer before asking the next when follow-ups depend on it). When the objective involves external facts (market, competitors, API/pricing status, best practices), research the web first so the questions are grounded. Re-call propose_goal_draft only when the objective is fully understood or the user says to proceed. Do not create the goal yet." }],
				details: { needsClarification: true, openQuestions: uniqueQuestions },
			};
			}
			if (!ctx.hasUI) {
				if (goal) return { content: [{ type: "text", text: "A goal is already set (status: " + goal.status + "). Clear it first." }], isError: true, details: {} };
				setGoal(proposal, { tokenBudget: raw.tokenBudget }, ctx);
				const specPath = writeGoalSpecDoc(proposal, ctx, goalConfig.goalSpecDir, nowMs);
				return { content: [{ type: "text", text: "Goal created (non-interactive)." }], details: { goal: { ...goal! }, specDoc: specPath } };
			}
			if (goal) {
				// Any existing goal (active/paused/complete/unmet/blocked) requires
				// explicit user confirmation before replacing. The user may want to
				// resume a paused goal, review a completed one, or keep the current
				// context — silently overwriting loses that.
				const statusLabel = goal.status === "active" ? "active" : goal.status;
				const ok = await ctx.ui.confirm(
					"Replace existing goal?",
					"A goal is currently " + statusLabel + ". Starting a new one will replace it" + (goal.status === "active" ? " (the current goal will be marked blocked)" : "") + ".\n\nChoose OK to start a new goal, or Cancel to keep the current goal.",
				);
				if (!ok) return { content: [{ type: "text", text: "Kept current goal." }], details: {} };
			}
			let choice = await showGoalReview(proposal, ctx);
			if (choice === "execution") {
				const selected = await ctx.ui.select("Execution preference", ["auto", "direct", "specialist", "team"]);
				if (!selected) return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
				const rerouted = routeExecution({ signals, availableModes, ...(selected === "auto" ? {} : { userSelection: { mode: selected as "direct" | "specialist" | "team", locked: true } }) });
				if (rerouted.status === "blocked" || (rerouted.mode === "specialist" && !roleIsRegistered)) {
					return { content: [{ type: "text", text: rerouted.status === "blocked" ? rerouted.reasons.join(" ") : "Choose a registered role before selecting specialist." }], isError: true, details: {} };
				}
				proposal.executionPreference = selected as ExecutionPreference;
				const { role: _previousRole, ...executionWithoutRole } = proposal.execution;
				proposal.execution = {
					...executionWithoutRole,
					preference: proposal.executionPreference,
					selected: rerouted.mode,
					...(rerouted.mode === "specialist" ? { role: registeredRole } : {}),
					source: "user",
					confidence: 1,
					reasons: rerouted.reasons,
				};
				choice = await showGoalReview(proposal, ctx);
			}
			switch (choice) {
				case "start": {
					setGoal(proposal, { tokenBudget: raw.tokenBudget }, ctx);
					const specPath = writeGoalSpecDoc(proposal, ctx, goalConfig.goalSpecDir, nowMs);
					if (specPath) ctx.ui?.notify?.("Goal spec written to " + specPath + " — edit the md and run /goal apply <path> to refine it.", "info");
					return { content: [{ type: "text", text: "Goal started: " + goal!.objective }], details: { goal: { ...goal! }, specDoc: specPath } };
				}
				case "edit": {
					// 升级：编辑完整 spec 文档（objective/criteria/constraints/claims/
					// 执行策略/决策记录都在一份 md 里），而不是只改两行文本。
					const specMarkdown = proposalToMarkdown({ ...proposalToSpecInput(proposal), createdAt: nowMs() });
					const editedSpec = await ctx.ui.editor("Edit goal spec (markdown):", specMarkdown);
					if (!editedSpec?.trim()) return { content: [{ type: "text", text: "Cancelled (empty spec)." }], details: {} };
					const parsed = parseGoalSpecMarkdown(editedSpec);
					if (!parsed.ok || !parsed.doc) {
						const reason = parsed.error ?? "The spec document could not be parsed.";
						ctx.ui?.notify?.("Spec edit rejected: " + reason, "warning");
						return { content: [{ type: "text", text: "Spec edit rejected: " + reason }], isError: true, details: {} };
					}
					const editedProposal = specDocToProposal(parsed.doc, proposal);
					if (editedProposal.criteria.length === 0) return { content: [{ type: "text", text: "Cancelled (no criteria)." }], details: {} };
					setGoal(editedProposal, { tokenBudget: raw.tokenBudget }, ctx);
					return { content: [{ type: "text", text: "Goal started after spec edit: " + goal!.objective }], details: { goal: { ...goal! }, specDoc: writeGoalSpecDoc(editedProposal, ctx, goalConfig.goalSpecDir, nowMs) } };
				}
				default: return { content: [{ type: "text", text: "Cancelled by user." }], details: {} };
			}
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// /goal Command
	// ═══════════════════════════════════════════════════════════════════

	function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null } {
		const match = input.match(/(?:^|\s)--tokens(?:=|\s+)([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)(?:\s|$)/);
		if (!match) return { objective: input.trim(), tokenBudget: null };
		const raw = match[1].replace(/\s+/g, "");
		const suffix = raw.slice(-1).toLowerCase();
		const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
		const value = Number(numeric);
		if (!Number.isFinite(value) || value <= 0) return { objective: input.trim(), tokenBudget: null };
		const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
		return {
			tokenBudget: Math.round(value * multiplier),
			objective: (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim(),
		};
	}

	pi.registerCommand("goal", {
		description: "Draft, review, start, inspect, steer, pause, resume, cancel, edit, fork, or clear a persistent goal",
		getArgumentCompletions: (prefix) => {
			return ["draft", "review", "start", "status", "pause", "resume", "cancel", "approve", "edit", "fork", "clear", "help", "run", "apply", "telemetry"]
				.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			let trimmed = args.trim();
			if (trimmed === "review") trimmed = "status";
			else if (trimmed.startsWith("review ")) trimmed = "apply " + trimmed.slice("review ".length).trim();
			if (trimmed.startsWith("draft ")) trimmed = trimmed.slice("draft ".length).trim();
			if (trimmed.startsWith("start ")) {
				const value = trimmed.slice("start ".length).trim();
				const candidate = path.isAbsolute(value) ? value : path.join(ctx.cwd, value);
				trimmed = value && fs.existsSync(candidate) ? "run " + value : value;
			}
			if (trimmed === "draft" || trimmed === "start") {
				ctx.ui.notify("Usage: /goal " + trimmed + " <objective-or-spec-path>", "warning");
				return;
			}
			if (!trimmed || trimmed === "status") {
				if (!goal) {
					ctx.ui.notify("Usage: /goal draft <objective> [--tokens 50k]\n  /goal review <spec> | start <spec-or-objective> | status | pause | resume | cancel | approve <capability> <scope> | edit | fork | clear\n\nNo goal currently set.", "info");
					return;
				}
				// Inject a persistent, collapsible goal card into the conversation
				// (ctrl+o to expand) instead of a transient notify toast.
				const now = nowMs();
				const progress = progressFor(goal, now);
				const displayGoal = {
					...goal,
					timeUsedMs: progress.resources.activeMs,
				};
				pi.sendMessage(
					{ customType: GOAL_EVENT_TYPE, content: "Goal status: " + goal.objective, display: true, details: { kind: "status", goal: displayGoal, progress, judgeVerdict: lastJudgeVerdict } },
					{ triggerTurn: false },
				);
				return;
			}
			if (trimmed === "telemetry") {
				const entries = readGoalTelemetry(goalConfig.goalSpecDir ?? "docs/goals", ctx.cwd);
				if (entries.length === 0) { ctx.ui.notify("No goal telemetry recorded yet.", "info"); return; }
				const lines = entries.map((entry) =>
					"- " + new Date(entry.endedAt).toISOString().slice(0, 16) + " [" + entry.outcome + "] " +
					entry.objective.slice(0, 60) + " | " + entry.taskKind + "/" + entry.execution.topology +
					" | " + formatTokens(entry.resources.tokensUsed) + " tok" +
					(entry.rejections.count > 0 ? " | rej=" + entry.rejections.count : ""),
				);
				ctx.ui.notify("Goal telemetry (last " + entries.length + "):\n" + lines.join("\n"), "info");
				return;
			}
			if (trimmed === "help") {
				ctx.ui.notify("/goal draft <objective> [--tokens N] — draft and review a goal\n/goal review <path> — review an editable goal spec\n/goal start <path-or-objective> — start from a blueprint or enter the draft/review flow\n/goal status — show current goal\n/goal pause | resume | cancel — control execution\n/goal approve <capability> <scope> — grant a pending capability for this run\n/goal edit — create a new revision in the editor\n/goal fork — create a child run from current evidence\n/goal clear — remove current state\n/goal telemetry — show completed goal statistics", "info");
				return;
			}
			if (trimmed.startsWith("run ")) {
				// 交互式补充入口：与 --goal-run flag 完全同一条代码路径。
				const filePath = trimmed.slice("run ".length).trim();
				if (!filePath) { ctx.ui.notify("Usage: /goal run <path-to-spec.md>", "warning"); return; }
				const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(ctx.cwd, filePath);
				const started = await startGoalFromSpecPath(ctx, absolutePath, { confirmIfUI: true, entrypoint: "interactive" });
				if (!started.ok) ctx.ui.notify("Blueprint goal failed to start: " + started.error, "error");
				return;
			}
			if (trimmed.startsWith("apply ")) {
				// 从用户微调过的 spec 文档恢复 proposal，走 review UI 确认。
				const filePath = trimmed.slice("apply ".length).trim();
				if (!filePath) { ctx.ui.notify("Usage: /goal apply <path-to-spec.md>", "warning"); return; }
				const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(ctx.cwd, filePath);
				let text: string;
				try {
					text = fs.readFileSync(absolutePath, "utf8");
				} catch {
					ctx.ui.notify("Cannot read spec file: " + filePath, "warning");
					return;
				}
				const parsed = parseGoalSpecMarkdown(text);
				if (!parsed.ok || !parsed.doc) {
					ctx.ui.notify("Spec parse failed: " + (parsed.error ?? "unknown"), "warning");
					return;
				}
				const fallbackExecution: ExecutionDecision = {
					preference: "auto", selected: "direct", source: "auto", confidence: 0.5,
					reasons: ["Loaded from a goal spec document; review before starting."],
					reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
				};
				const fallbackAssurance: AssuranceDecision = {
					reviewRequirement: "advisory", reviewStatus: "pending", independent: true,
					depth: "light", source: "auto", reasons: ["Loaded from a goal spec document."], decidedAt: nowMs(),
				};
				const base: GoalProposal = {
					objective: parsed.doc.objective,
					criteria: parsed.doc.criteria.map((criterion) => ({ description: criterion.description, level: criterion.level })),
					constraints: parsed.doc.constraints,
					claims: parsed.doc.claims.map((claim) => ({
						id: claim.id, text: claim.text, materiality: claim.materiality,
						...(claim.risk ? { risk: claim.risk } : {}),
						evidenceRefs: [],
					})),
					taskKind: (parsed.doc.machine.taskKind as TaskKind) ?? "general",
					executionPreference: "auto",
					execution: fallbackExecution,
					assurance: fallbackAssurance,
				};
				const proposal = specDocToProposal(parsed.doc, base);
				if (proposal.criteria.length === 0) { ctx.ui.notify("Spec has no criteria.", "warning"); return; }
				let choice = await showGoalReview(proposal, ctx);
				if (choice === "execution") {
					const selected = await ctx.ui.select("Execution preference", ["auto", "direct", "specialist", "team"]);
					if (!selected) return;
					proposal.execution = {
						...proposal.execution, preference: selected as ExecutionPreference, selected: selected as "direct" | "specialist" | "team",
						source: "user", confidence: 1, reasons: ["User selected execution in the review UI."],
					};
					choice = await showGoalReview(proposal, ctx);
				}
				if (choice === "start") {
					setGoal(proposal, { tokenBudget: parsed.doc.machine.tokenBudget ?? null }, ctx);
					ctx.ui.notify("Goal started from spec: " + goal!.objective, "info");
					return;
				}
				if (choice === "edit") {
					const specMarkdown = proposalToMarkdown({ ...proposalToSpecInput(proposal), createdAt: nowMs() });
					const editedSpec = await ctx.ui.editor("Edit goal spec (markdown):", specMarkdown);
					if (editedSpec?.trim()) {
						const reparsed = parseGoalSpecMarkdown(editedSpec);
						if (reparsed.ok && reparsed.doc) {
							setGoal(specDocToProposal(reparsed.doc, proposal), { tokenBudget: parsed.doc.machine.tokenBudget ?? null }, ctx);
							ctx.ui.notify("Goal started after spec edit: " + goal!.objective, "info");
							return;
						}
						ctx.ui.notify("Spec edit rejected: " + (reparsed.error ?? "parse failed"), "warning");
					}
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			if (trimmed === "clear") { if (!goal) { ctx.ui.notify("No goal to clear.", "info"); return; } clearGoal(ctx); ctx.ui.notify("Goal cleared.", "info"); return; }
			if (trimmed === "pause") { if (!goal || goal.status !== "active") { ctx.ui.notify("No active goal.", "info"); return; } pauseGoal("user pause", ctx); ctx.ui.notify("Goal paused.", "info"); return; }
			if (trimmed === "resume") { if (!goal || !canResumeGoal(goal.status)) { ctx.ui.notify("No resumable goal (paused/budget-limited/usage-limited only; blocked/unmet/complete require /goal clear).", "info"); return; } resumeGoal(ctx); ctx.ui.notify("Goal resumed: " + goal.objective.slice(0, 80) + (goal.objective.length > 80 ? "…" : ""), "info"); return; }
			if (trimmed === "cancel") { if (!goal) { ctx.ui.notify("No goal to cancel.", "info"); return; } if (!cancelGoal("user cancel", ctx)) ctx.ui.notify("Goal is already terminal (" + goal.status + ").", "info"); return; }
			if (trimmed.startsWith("approve ")) {
				const match = trimmed.match(/^approve\s+(\S+)\s+(.+)$/);
				if (!match || !goal || !goal.runtime) { ctx.ui.notify("Usage: /goal approve <capability> <scope>", "warning"); return; }
				const approval = addApproval({ capability: match[1], scope: match[2].trim(), decidedBy: "user" });
				if (!approval) { ctx.ui.notify("Could not record approval.", "warning"); return; }
				if (goal.status === "paused" && /approval|required/i.test(goal.pausedReason ?? "")) resumeGoal(ctx);
				ctx.ui.notify("Capability approved for this run: " + approval.capability + " " + approval.scope, "info");
				return;
			}
			if (trimmed === "edit") {
				if (!goal) { ctx.ui.notify("No goal to edit.", "info"); return; }
				if (!ctx.hasUI) { ctx.ui.notify("/goal edit requires the interactive editor; edit the spec file and use /goal review <path> in non-UI mode.", "warning"); return; }
				const edited = await editGoal(ctx);
				ctx.ui.notify(edited ? "Goal revision started." : "Goal edit cancelled.", "info");
				return;
			}
			if (trimmed === "fork") {
				if (!goal) { ctx.ui.notify("No goal to fork.", "info"); return; }
				forkGoal(ctx);
				ctx.ui.notify("Forked goal run: " + goal!.runtime?.runId, "info");
				return;
			}

			const { objective, tokenBudget } = parseTokenBudget(trimmed);
			if (!objective) { ctx.ui.notify("Usage: /goal <objective> [--tokens 50k]", "warning"); return; }
			// If a goal is already active, confirm replacement before drafting.
			if (goal && goal.status === "active" && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Replace goal?",
					"New objective: " + objective.slice(0, 120) + "\n\nThe current goal will be marked blocked (superseded).",
				);
				if (!ok) { ctx.ui.notify("Kept current goal.", "info"); return; }
			}
				const proposeMsg = "Draft a formal goal for the following task using the pi-goal-writer skill. Call list_roles first when available, then call propose_goal_draft with a concise objective and at least one genuine, independently verifiable outcome criterion. Do not add criteria merely to meet a count.\n\nWhen the objective involves external facts (market, competitors, library/API status, pricing, best practices) or your knowledge may be stale, research the web with web_search BEFORE drafting so criteria and claims are grounded.\n\n<untrusted_task>\n" + objective + "\n</untrusted_task>\n\n" + (tokenBudget
					? "Token budget: " + formatTokens(tokenBudget) + ". You MUST pass this exact token count into propose_goal_draft's tokenBudget parameter (a missing tokenBudget is a drafting error)."
					: "Token budget: none");
			pi.sendUserMessage(proposeMsg);
		},
	});
}

export function createPiGoalExtension(
	dependencies: Partial<PiGoalRuntimeDependencies> = {},
): (pi: ExtensionAPI) => void {
	const runtime: PiGoalRuntimeDependencies = {
		complete,
		minContinueIntervalMs: CONFIG.minContinueIntervalMs,
		now: Date.now,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		...dependencies,
	};
	return (pi) => registerPiGoalExtension(pi, runtime);
}

export * from "./evaluation-v3";
export * from "./benchmark-fixtures-v3";
export * from "./observability-v3";
export * from "./fault-injection-v3";
export * from "./benchmark-fault-matrix-v3";
export * from "./runtime-v3";

export default createPiGoalExtension();
