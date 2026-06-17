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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

const GOAL_STORAGE_TYPE = "pi-goal";
const GOAL_EVENT_TYPE = "pi-goal:event";
const GOAL_CONTINUATION_TYPE = "pi-goal:continuation";
const GOAL_JUDGE_TYPE = "pi-goal:judge";

type GoalStatus = "active" | "paused" | "budget_limited" | "complete" | "unmet";

interface Criterion {
	id: string;
	description: string;
	evidence: string[];
}

interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	criteria: Criterion[];
	constraints: string[];
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedMs: number;
	createdAt: number;
	updatedAt: number;
	noProgressCount: number;
	autoTurnCount: number;
	pausedReason: string | null;
	blocker: string | null;
	completionEvidence: string | null;
}

interface GoalSnapshot {
	action: "set" | "update" | "clear" | "status" | "budget_limited";
	goal: GoalState | null;
}

interface JudgeVerdict {
	done: boolean;
	reason: string;
	parseFailed: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
	maxAutoTurns: 25,
	noProgressTokenThreshold: 50,
	maxNoProgressTurns: 2,
	minContinueIntervalMs: 3_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Utility Helpers
// ═══════════════════════════════════════════════════════════════════════

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function escapeXml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function extractOutputTokens(event: { message?: { role?: string; usage?: { output?: number } } }): number {
	if (event.message?.role !== "assistant") return 0;
	return Math.max(0, event.message.usage?.output ?? 0);
}

function extractTextContent(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function isAssistantMessage(m: { role?: string }): m is AssistantMessage {
	return m.role === "assistant";
}

// ═══════════════════════════════════════════════════════════════════════
// Judge Service
// ═══════════════════════════════════════════════════════════════════════

const JUDGE_SYSTEM_PROMPT = "You are a strict completion judge for an autonomous coding agent.\n" +
	"The agent has been working toward a goal. You receive:\n" +
	"1. The goal objective and its acceptance criteria\n" +
	"2. The agent's most recent response (including any tool calls made and their results)\n\n" +
	"Decide whether the goal is FULLY ACHIEVED based on the evidence in the agent's response.\n\n" +
	"A goal is DONE only when:\n" +
	"- Every explicit criterion has concrete, specific evidence in the response\n" +
	"- The agent has verified deliverables against real artifacts (files, test output, build status)\n" +
	"- No criterion lacks evidence\n\n" +
	"A goal is NOT done when:\n" +
	"- Any criterion is missing, incomplete, or unverified\n" +
	"- Evidence is vague (\"all tests pass\" without showing which tests)\n" +
	"- Criteria were not individually checked against real output\n\n" +
	"Reply ONLY with a single JSON object on one line, no markdown fences:\n" +
	'{"done": true, "reason": "brief rationale"}\n' +
	"or\n" +
	'{"done": false, "reason": "what\'s missing"}';

async function runJudge(
	goal: GoalState,
	responseText: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<JudgeVerdict> {
	const model = ctx.model;
	if (!model) {
		return { done: false, reason: "no model available for judge", parseFailed: false };
	}

	const criteriaBlock = goal.criteria.length > 0
		? "\nCriteria:\n" + goal.criteria.map((c) => `  [${c.evidence.length > 0 ? "\u2713" : " "}] ${c.description}`).join("\n")
		: "";

	const judgePrompt = "Goal: " + goal.objective + criteriaBlock + "\n\nAgent's most recent response:\n" + responseText.slice(0, 8_000) + "\n\nIs the goal fully achieved? Check each criterion against concrete evidence in the response.";

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { done: false, reason: `judge auth failed: ${auth.error}`, parseFailed: false };
	}

	const startMs = Date.now();
	try {
		const result = await complete(
			model,
			{
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: judgePrompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				temperature: 0,
				maxTokens: 256,
			},
		);
		const rawResponse = extractTextContent(result);
		const durationMs = Date.now() - startMs;

		let verdict: JudgeVerdict;
		try {
			const parsed = JSON.parse(rawResponse.trim());
			verdict = { done: parsed.done === true, reason: typeof parsed.reason === "string" ? parsed.reason : rawResponse, parseFailed: false };
		} catch {
			const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					verdict = { done: parsed.done === true, reason: typeof parsed.reason === "string" ? parsed.reason : "unparseable", parseFailed: false };
				} catch {
					verdict = { done: false, reason: "judge response not JSON", parseFailed: true };
				}
			} else {
				verdict = { done: false, reason: "judge response not JSON", parseFailed: true };
			}
		}

		pi.sendMessage(
			{
				customType: GOAL_JUDGE_TYPE,
				content: `Judge: ${verdict.done ? "DONE" : "CONTINUE"} — ${verdict.reason}`,
				display: false,
				details: { verdict, durationMs, modelId: model.id, usage: result.usage },
			},
			{ triggerTurn: false },
		);

		return verdict;
	} catch (err) {
		return { done: false, reason: `judge error: ${err instanceof Error ? err.message : String(err)}`, parseFailed: false };
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Prompt Generation
// ═══════════════════════════════════════════════════════════════════════

function buildCriteriaBlock(criteria: Criterion[]): string {
	if (criteria.length === 0) return "";
	const lines = criteria.map((c) => {
		const icon = c.evidence.length > 0 ? "\u2705" : "\u23F3";
		return `  ${icon} [${c.id}] ${c.description}${c.evidence.length > 0 ? ` (evidence: ${c.evidence.length})` : ""}`;
	});
	return "\nCriteria progress:\n" + lines.join("\n");
}

// continuationPrompt — uses string concatenation (no template literals with backticks)
function continuationPrompt(goal: GoalState): string {
	const budgetLine = goal.tokenBudget != null
		? "- Token budget: " + formatTokens(goal.tokenBudget) + " (" + formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed)) + " remaining)"
		: "- No token budget set";
	const criteriaBlock = buildCriteriaBlock(goal.criteria);
	const criteriaInstruction = goal.criteria.length > 0
		? "\n3. Submit evidence per criterion:\n   Call update_goal({ criterionId: \"<id>\", evidence: \"<detail>\" }) for each completed criterion.\n4. When ALL criteria show \u2705, call update_goal({ status: \"complete\", evidence: \"<summary>\" }).\n5. The system will reject complete if any criterion lacks evidence."
		: "";

	return (
		"<GOAL-MODE-ADAPTATION>\n" +
		"The superpowers skills you are about to load were designed for interactive use where\n" +
		"a human is present. Since you are in autonomous goal mode, adapt EVERY instruction:\n\n" +
		"| Skill says... | You do this instead... |\n" +
		"|---|---|\n" +
		'| "get user approval" | Dispatch a reviewer subagent as the autonomous approver. |\n' +
		'| "ask clarifying questions" | Use your best judgment based on the goal objective. |\n' +
		'| "present the design" | Write to a file, then dispatch the approver to review it. |\n' +
		'| "invoke <skill> skill" | Read the skill\'s SKILL.md with the read tool. Path: pi-superpowers-upgraded/skills/<skill>/SKILL.md |\n' +
		'| "HARD-GATE: no code until approved" | RESPECT THIS. Do not write code. Dispatch approver, get approval, then proceed. |\n\n' +
		"REMEMBER: The approver IS the user for this goal run. Treat its decisions as binding.\n" +
		"</GOAL-MODE-ADAPTATION>\n\n" +
		"<EXTREMELY-IMPORTANT>\n" +
		"You are executing an autonomous goal. The user is NOT watching. You MUST follow process discipline.\n\n" +
		"BEFORE taking any action this turn, load and read these skills (use the read tool):\n" +
		"1. pi-superpowers-upgraded/skills/using-superpowers/SKILL.md\n" +
		"2. Check the situation table and load the relevant superpowers skill\n\n" +
		"For this turn's work, determine the right superpowers skill:\n" +
		"| If this turn involves... | Load this skill |\n" +
		"|---|---|\n" +
		"| Open-ended design, architecture, new approach | pi-superpowers-upgraded/skills/brainstorming/SKILL.md |\n" +
		"| Multi-file or coordinated changes | pi-superpowers-upgraded/skills/writing-plans/SKILL.md |\n" +
		"| Executing a written plan | pi-superpowers-upgraded/skills/subagent-driven-development/SKILL.md |\n" +
		"| Adding testable behavior | pi-superpowers-upgraded/skills/test-driven-development/SKILL.md |\n" +
		"| Bug or unexpected behavior | pi-superpowers-upgraded/skills/systematic-debugging/SKILL.md |\n" +
		'| About to claim anything is done | pi-superpowers-upgraded/skills/verification-before-completion/SKILL.md |\n\n' +
		"<HARD-GATE>\n" +
		"If a superpowers skill requires an approval gate, do NOT stop or skip it.\n" +
		"Instead, dispatch a reviewer subagent as the autonomous approver.\n\n" +
		"Use this dispatch template for the approver:\n\n" +
		"    subagent({\n" +
		'      subagent_type: "reviewer",\n' +
		'      description: "Approve [design/plan/code]",\n' +
		'      prompt: "You are the autonomous approver for an unattended goal run.\\n' +
		"      The user is not present. You make the call.\\n\\n" +
		"      GOAL: <copy objective from above>\\n" +
		"      REVIEWING: <the design, plan, or code being evaluated>\\n\\n" +
		"      Evaluate on THREE dimensions, return one word: APPROVED or REJECTED:\\n" +
		"      1. PROCESS - was the superpowers process followed?\\n" +
		"      2. TECHNICAL - does it work? Are there placeholders?\\n" +
		"      3. USER VALUE - does this deliver what the goal requires?\\n\\n" +
		"      APPROVE if sound. REJECT if broken, skipped steps, or placeholders.\\n" +
		'      Rejection MUST include specific, actionable feedback."\n' +
		"    })\n\n" +
		"APPROVE if sound. REJECT if broken, skipped steps, or doesn't meet the goal.\n" +
		"IF THE APPROVER REJECTS 3 CONSECUTIVE TIMES: pause goal with update_goal({ status: \"unmet\" }).\n" +
		"</HARD-GATE>\n\n" +
		"<HARD-GATE>\n" +
		"If writing code without a plan for multi-file changes, STOP. Load writing-plans first.\n" +
		"If claiming completion without verification-before-completion, STOP. Verify first.\n" +
		"If implementing without TDD (test first, watch it fail, then code), STOP. Follow TDD.\n" +
		"</HARD-GATE>\n" +
		"</EXTREMELY-IMPORTANT>\n\n" +
		"---\n\n" +
		"Continue working toward the active goal.\n\n" +
		"<untrusted_objective>\n" +
		escapeXml(goal.objective) + "\n" +
		"</untrusted_objective>\n\n" +
		"Progress:\n" +
		"- Tokens used: " + formatTokens(goal.tokensUsed) + "\n" +
		budgetLine + "\n" +
		"- Time spent: " + formatDuration(goal.timeUsedMs) + "\n" +
		"- Auto-continuation turns: " + goal.autoTurnCount + "/" + CONFIG.maxAutoTurns + "\n" +
		criteriaBlock + "\n\n" +
		"Rules:\n" +
		"1. Before marking complete, perform a strict completion audit against real evidence:\n" +
		"   - Inspect relevant files, command output, test results\n" +
		"   - Verify every criterion has been met with concrete evidence\n" +
		"   - Do not accept proxy signals or partial progress as completion\n" +
		"2. An independent judge will also evaluate completion after each turn.\n" +
		criteriaInstruction + "\n" +
		"3. Do not mark complete merely because budget is nearly exhausted."
	);
}

function budgetLimitPrompt(goal: GoalState): string {
	const criteriaBlock = buildCriteriaBlock(goal.criteria);
	return "The active goal has reached its token budget.\n\n" +
		"<untrusted_objective>\n" +
		escapeXml(goal.objective) + "\n" +
		"</untrusted_objective>\n\n" +
		"Usage:\n" +
		"- Tokens used: " + formatTokens(goal.tokensUsed) + "\n" +
		"- Token budget: " + (goal.tokenBudget != null ? formatTokens(goal.tokenBudget) : "none") + "\n" +
		"- Time spent: " + formatDuration(goal.timeUsedMs) + "\n" +
		criteriaBlock + "\n\n" +
		"The goal is budget_limited. Wrap up: summarize progress, identify remaining work.\n" +
		"Do not call update_goal unless the goal is actually complete.";
}

function goalSystemPrompt(goal: GoalState): string {
	const criteriaBlock = buildCriteriaBlock(goal.criteria);
	const budgetInfo = goal.tokenBudget != null
		? "Token budget: " + formatTokens(goal.tokenBudget) + " (" + formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed)) + " remaining)"
		: "No token budget";

	return "## Active Goal\n\n" +
		"<untrusted_objective>\n" +
		escapeXml(goal.objective) + "\n" +
		"</untrusted_objective>\n\n" +
		"Status: " + goal.status + "\n" +
		"Time spent: " + formatDuration(goal.timeUsedMs) + "\n" +
		"Tokens used: " + formatTokens(goal.tokensUsed) + "\n" +
		budgetInfo + "\n" +
		criteriaBlock + "\n\n" +
		"Use get_goal to check the current state.\n" +
		"Use update_goal({ criterionId, evidence }) to submit evidence per criterion.\n" +
		'When ALL criteria are satisfied, call update_goal({ status: "complete", evidence: "..." }).\n' +
		"An independent judge will evaluate completion after each turn.";
}

// ═══════════════════════════════════════════════════════════════════════
// Goal Draft Review UI
// ═══════════════════════════════════════════════════════════════════════

interface GoalProposal {
	objective: string;
	criteria: string[];
	constraints: string[];
}

type ReviewResult = "start" | "edit" | "cancel";

async function showGoalReview(
	proposal: GoalProposal,
	ctx: ExtensionCommandContext,
): Promise<ReviewResult> {
	const items: SelectItem[] = [
		{ value: "start", label: "Start — begin working toward this goal" },
		{ value: "edit", label: "Edit — modify the objective or criteria" },
		{ value: "cancel", label: "Cancel — discard this draft" },
	];

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const headerBorder = new DynamicBorder((s) => theme.fg("accent", s));
		container.addChild(headerBorder);
		container.addChild(new Text(theme.fg("accent", theme.bold(" Goal Draft Review "))));
		container.addChild(new Text(""));
		container.addChild(new Text(theme.fg("accent", theme.bold("Objective:"))));
		container.addChild(new Text(theme.fg("text", "  " + proposal.objective)));
		container.addChild(new Text(""));

		if (proposal.criteria.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Acceptance Criteria:"))));
			for (const c of proposal.criteria) {
				container.addChild(new Text(theme.fg("dim", "  \u2610 " + c)));
			}
			container.addChild(new Text(""));
		}
		if (proposal.constraints.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Constraints:"))));
			for (const c of proposal.constraints) {
				container.addChild(new Text(theme.fg("dim", "  \u2022 " + c)));
			}
			container.addChild(new Text(""));
		}

		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(""));
		container.addChild(new Text(theme.fg("dim", "  Enter: confirm  Esc: cancel")));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
		};
	});

	return (choice as ReviewResult) ?? "cancel";
}

// ═══════════════════════════════════════════════════════════════════════
// Main Extension
// ═══════════════════════════════════════════════════════════════════════

export default function piGoalExtension(pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let judgeParseFailures = 0;
	let userSuspended = false;
	let continuationQueued = false;
	let turnStartedAt: number | null = null;
	let turnGoalId: string | null = null;
	let lastAssistantText = "";
	let wasGoalDriven = false;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer() {
		if (continuationTimer) { clearTimeout(continuationTimer); continuationTimer = null; }
	}

	function persist(action: GoalSnapshot["action"]) {
		pi.appendEntry<GoalSnapshot>(GOAL_STORAGE_TYPE, { action, goal: goal ? { ...goal } : null });
	}

	const GOAL_TOOLS = ["get_goal", "update_goal", "propose_goal_draft"];

	function syncTools() {
		const active = new Set(pi.getActiveTools());
		let changed = false;
		const canPropose = !goal || ["active", "paused", "budget_limited", "complete", "unmet"].includes(goal.status);
		const canGet = !!goal;
		const canUpdate = goal?.status === "active";
		const desired: Record<string, boolean> = { propose_goal_draft: canPropose, get_goal: canGet, update_goal: canUpdate };
		for (const [name, want] of Object.entries(desired)) {
			if (want && !active.has(name)) { active.add(name); changed = true; }
			else if (!want && active.has(name)) { active.delete(name); changed = true; }
		}
		if (changed) pi.setActiveTools(Array.from(active));
	}

	function updateFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!goal || goal.status === "complete" || goal.status === "unmet") {
			ctx.ui.setStatus("pi-goal", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		switch (goal.status) {
			case "active": {
				const usage = goal.tokenBudget != null
					? " (" + formatTokens(goal.tokensUsed) + "/" + formatTokens(goal.tokenBudget) + ")"
					: " (" + formatDuration(goal.timeUsedMs) + ")";
				ctx.ui.setStatus("pi-goal", theme.fg("accent", "\uD83C\uDFAF goal" + usage));
				break;
			}
			case "paused":
				ctx.ui.setStatus("pi-goal", theme.fg("warning", "\u23F8 goal paused"));
				break;
			case "budget_limited":
				ctx.ui.setStatus("pi-goal", theme.fg("warning", "\uD83D\uDCB0 budget reached"));
				break;
		}
	}

	function updateState(patch: Partial<GoalState>, ctx: ExtensionContext) {
		if (!goal) return;
		Object.assign(goal, patch, { updatedAt: Date.now() });
		persist("update");
		updateFooter(ctx);
		syncTools();
	}

	function reconstruct(ctx: ExtensionContext) {
		goal = null;
		clearTimer();
		turnStartedAt = null;
		turnGoalId = null;
		lastAssistantText = "";
		wasGoalDriven = false;
		continuationQueued = false;
		userSuspended = false;
		judgeParseFailures = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== GOAL_STORAGE_TYPE) continue;
			const data = (entry as { data?: Partial<GoalSnapshot> }).data;
			if (data?.goal) goal = { ...data.goal } as GoalState;
		}
	}

	function setGoal(
		objective: string, criteria: string[], constraints: string[],
		opts: { tokenBudget?: number | null }, ctx: ExtensionContext,
	): GoalState {
		const now = Date.now();
		if (goal?.status === "active") {
			goal.status = "unmet";
			goal.blocker = "Replaced by new goal";
			goal.updatedAt = now;
		}
		const criteriaStates: Criterion[] = criteria.map((desc) => ({
			id: "c" + randomUUID().slice(0, 6),
			description: desc,
			evidence: [],
		}));
		const newGoal: GoalState = {
			id: randomUUID(), objective, status: "active", criteria: criteriaStates, constraints,
			tokenBudget: opts.tokenBudget ?? null, tokensUsed: 0, timeUsedMs: 0,
			createdAt: now, updatedAt: now, noProgressCount: 0, autoTurnCount: 0,
			pausedReason: null, blocker: null, completionEvidence: null,
		};
		goal = newGoal;
		userSuspended = false;
		continuationQueued = false;
		persist("set");
		updateFooter(ctx);
		syncTools();
		sendContinuation(ctx);
		return newGoal;
	}

	function pauseGoal(reason: string, ctx: ExtensionContext): boolean {
		if (!goal || goal.status !== "active") return false;
		updateState({ status: "paused", pausedReason: reason }, ctx);
		clearTimer();
		userSuspended = true;
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal paused: " + reason + "\n\nObjective: " + goal.objective, display: true, details: { kind: "paused", goal: { ...goal } } },
			{ triggerTurn: false },
		);
		return true;
	}

	function resumeGoal(ctx: ExtensionContext): boolean {
		if (!goal || goal.status !== "paused") return false;
		userSuspended = false;
		continuationQueued = false;
		updateState({ status: "active", noProgressCount: 0, pausedReason: null }, ctx);
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal resumed.\n\nObjective: " + goal.objective, display: true, details: { kind: "resumed", goal: { ...goal } } },
			{ triggerTurn: false },
		);
		sendContinuation(ctx);
		return true;
	}

	function clearGoal(ctx: ExtensionContext): boolean {
		if (!goal) return false;
		clearTimer();
		const oldGoal = goal;
		goal = null;
		userSuspended = false;
		continuationQueued = false;
		persist("clear");
		updateFooter(ctx);
		syncTools();
		pi.sendMessage(
			{ customType: GOAL_EVENT_TYPE, content: "Goal cleared.", display: true, details: { kind: "cleared", goal: oldGoal } },
			{ triggerTurn: false },
		);
		return true;
	}

	function sendContinuation(ctx: ExtensionContext) {
		if (!goal || goal.status !== "active") return;
		if (userSuspended) return;
		clearTimer();
		queueMicrotask(() => {
			if (!goal || goal.status !== "active") return;
			if (userSuspended) return;
			wasGoalDriven = true;
			pi.sendMessage(
				{ customType: GOAL_CONTINUATION_TYPE, content: continuationPrompt(goal), display: false, details: { goalId: goal.id } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	function scheduleContinuation(ctx: ExtensionContext) {
		clearTimer();
		if (userSuspended) return;
		if (!goal || goal.status !== "active") return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (goal.noProgressCount >= CONFIG.maxNoProgressTurns) {
			pauseGoal("no progress for " + CONFIG.maxNoProgressTurns + " turns", ctx);
			ctx.ui.notify("\u23F8 Goal paused (no progress). Use /goal resume to continue.", "warning");
			return;
		}
		if (goal.autoTurnCount >= CONFIG.maxAutoTurns) {
			pauseGoal("reached max auto-turns (" + CONFIG.maxAutoTurns + ")", ctx);
			ctx.ui.notify("\u23F8 Goal paused (max turns reached).", "info");
			return;
		}
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			if (!goal || goal.status !== "active") return;
			if (userSuspended) return;
			sendContinuation(ctx);
		}, CONFIG.minContinueIntervalMs);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Events
	// ═══════════════════════════════════════════════════════════════════

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		syncTools();
		if (goal?.status === "active") {
			goal = { ...goal, status: "paused", pausedReason: "session reload", updatedAt: Date.now() };
			persist("status");
			ctx.ui.notify("\u23F8 Goal paused (session reload): " + goal.objective.slice(0, 80) + "\u2026\nUse /goal resume to continue.", "info");
		} else if (goal) {
			ctx.ui.notify("\uD83C\uDFAF Goal restored: " + goal.objective.slice(0, 80) + "\u2026 (" + goal.status + ")", "info");
		}
		updateFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); syncTools(); updateFooter(ctx); });
	pi.on("session_shutdown", async () => { clearTimer(); turnStartedAt = null; turnGoalId = null; });

	pi.on("before_agent_start", async (event) => {
		if (!goal || goal.status !== "active") return;
		return { systemPrompt: event.systemPrompt + "\n\n" + goalSystemPrompt(goal) };
	});

	pi.on("context", async (event) => {
		if (!goal) return event;
		let lastContinuationIdx = -1;
		const messages = event.messages as Array<{ customType?: string; details?: { goalId?: string } }>;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].customType === GOAL_CONTINUATION_TYPE && messages[i].details?.goalId === goal.id) lastContinuationIdx = i;
		}
		return {
			messages: messages.filter((msg, idx) => {
				if (msg.customType === GOAL_JUDGE_TYPE) return false;
				if (msg.customType === GOAL_CONTINUATION_TYPE) {
					return goal?.status === "active" && msg.details?.goalId === goal?.id && idx === lastContinuationIdx;
				}
				return true;
			}),
		};
	});

	pi.on("turn_start", async () => {
		if (goal?.status === "active") { turnStartedAt = Date.now(); turnGoalId = goal.id; }
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!goal || goal.status !== "active" || turnGoalId !== goal.id) return;
		const elapsed = turnStartedAt ? Date.now() - turnStartedAt : 0;
		const outputTokens = extractOutputTokens(event);
		turnStartedAt = null; turnGoalId = null;
		goal.timeUsedMs += elapsed;
		goal.tokensUsed += outputTokens;
		if (outputTokens < CONFIG.noProgressTokenThreshold) goal.noProgressCount += 1;
		else goal.noProgressCount = 0;
		if (wasGoalDriven) goal.autoTurnCount += 1;
		if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
			goal.status = "budget_limited"; goal.updatedAt = Date.now();
			persist("budget_limited"); updateFooter(ctx); syncTools();
			pi.sendMessage(
				{ customType: GOAL_EVENT_TYPE, content: budgetLimitPrompt(goal), display: true, details: { kind: "budget_limited", goal: { ...goal } } },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			return;
		}
		if (isAssistantMessage(event.message)) lastAssistantText = extractTextContent(event.message);
		persist("update"); updateFooter(ctx);
	});

	pi.on("input", async () => { if (goal?.status === "active") { clearTimer(); userSuspended = true; } });

	pi.on("agent_end", async (event, ctx) => {
		const done = wasGoalDriven;
		wasGoalDriven = false;
		if (!goal || goal.status !== "active") return;
		if (ctx.signal?.aborted) { pauseGoal("interrupted", ctx); return; }
		if (ctx.hasPendingMessages()) return;
		if (!done) return;

		if (lastAssistantText.trim()) {
			const verdict = await runJudge(goal, lastAssistantText, ctx, pi);
			if (verdict.parseFailed) {
				judgeParseFailures += 1;
				if (judgeParseFailures >= 3) {
					pauseGoal("judge parse failures (3 consecutive)", ctx);
					ctx.ui.notify("\u23F8 Goal paused (judge parse failures).", "warning");
					return;
				}
			} else { judgeParseFailures = 0; }

			if (verdict.done) {
				const uncovered = goal.criteria.filter((c) => c.evidence.length === 0);
				if (uncovered.length > 0) {
					ctx.ui.notify("\u26A0\uFE0F Judge says done, but " + uncovered.length + " criteria lack evidence. Continuing...", "warning");
				} else {
					updateState({ status: "complete", completionEvidence: verdict.reason, noProgressCount: 0 }, ctx);
					pi.sendMessage(
						{ customType: GOAL_EVENT_TYPE, content: "Goal achieved! \u2705\n\nObjective: " + goal.objective + "\nJudge: " + verdict.reason + "\nTokens: " + formatTokens(goal.tokensUsed) + "\nTime: " + formatDuration(goal.timeUsedMs), display: true, details: { kind: "complete", goal: { ...goal, status: "complete" } } },
						{ triggerTurn: false },
					);
					return;
				}
			}
		}
		scheduleContinuation(ctx);
	});

	// ═══════════════════════════════════════════════════════════════════
	// Message Renderer
	// ═══════════════════════════════════════════════════════════════════

	pi.registerMessageRenderer(GOAL_EVENT_TYPE, (message, options, theme) => {
		const details = message.details as { kind?: string; goal?: GoalState | null } | undefined;
		const kind = details?.kind ?? "event";
		const state = details?.goal ?? null;
		const labels: Record<string, (t: typeof theme) => string> = {
			active: (t) => t.fg("accent", "active"), continuing: (t) => t.fg("muted", "continuing"),
			paused: (t) => t.fg("warning", "paused"), resumed: (t) => t.fg("accent", "resumed"),
			cleared: (t) => t.fg("dim", "cleared"), budget_limited: (t) => t.fg("warning", "budget reached"),
			complete: (t) => t.fg("success", "achieved"), unmet: (t) => t.fg("error", "unmet"),
		};
		return {
			render: () => {
				const lines: string[] = [];
				const prefix = theme.fg("accent", theme.bold("Goal"));
				const label = (labels[kind] ?? ((t: typeof theme) => t.fg("text", kind)))(theme);
				lines.push(prefix + " " + label + (!options.expanded ? " " + theme.fg("dim", "(ctrl+o)") : ""));
				if (options.expanded && state) {
					lines.push(theme.fg("dim", "  Objective: ") + theme.fg("text", state.objective));
					if (state.criteria?.length) {
						for (const c of state.criteria) {
							const icon = c.evidence?.length > 0 ? "\u2705" : "\u23F3";
							lines.push(theme.fg("dim", "  " + icon + " ") + theme.fg("text", c.description));
						}
					}
					const usage = state.tokenBudget
						? formatTokens(state.tokensUsed) + "/" + formatTokens(state.tokenBudget)
						: formatDuration(state.timeUsedMs);
					lines.push(theme.fg("dim", "  Usage: ") + theme.fg("text", usage));
				}
				return lines;
			},
			invalidate: () => {},
		};
	});

	// ═══════════════════════════════════════════════════════════════════
	// Model Tools
	// ═══════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "get_goal", label: "Get Goal",
		description: "Read the current active goal: objective, status, criteria, token usage, and budget.",
		parameters: Type.Object({}),
		async execute() {
			if (!goal) return { content: [{ type: "text", text: "No goal is currently set." }], details: {} };
			return {
				content: [{ type: "text", text: JSON.stringify({
					objective: goal.objective, status: goal.status,
					criteria: goal.criteria.map((c) => ({ id: c.id, description: c.description, done: c.evidence.length > 0, evidence: c.evidence })),
					constraints: goal.constraints, tokens_used: goal.tokensUsed, token_budget: goal.tokenBudget,
					remaining_tokens: goal.tokenBudget !== null ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : null,
					time_used_seconds: Math.floor(goal.timeUsedMs / 1000), auto_turns: goal.autoTurnCount,
				}, null, 2) }],
				details: { goal },
			};
		},
	});

	pi.registerTool({
		name: "update_goal", label: "Update Goal",
		description: "Update the active goal. Submit evidence per criterion, or mark goal complete/unmet.",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["complete", "unmet"] as const)),
			evidence: Type.Optional(Type.String({ description: "Required for complete." })),
			blocker: Type.Optional(Type.String({ description: "Required for unmet." })),
			criterionId: Type.Optional(Type.String({ description: "ID of criterion for per-criterion evidence." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!goal || goal.status !== "active") {
				return { content: [{ type: "text", text: "No active goal to update." }], isError: true, details: {} };
			}
			if (params.criterionId && params.evidence) {
				const criterion = goal.criteria.find((c) => c.id === params.criterionId);
				if (!criterion) {
					return { content: [{ type: "text", text: "Criterion \"" + params.criterionId + "\" not found." }], isError: true, details: {} };
				}
				criterion.evidence.push(params.evidence);
				updateState({ criteria: [...goal.criteria] }, ctx);
				return { content: [{ type: "text", text: "Evidence recorded for \"" + criterion.description + "\": " + params.evidence }], details: { criterionId: criterion.id } };
			}
			if (params.status === "complete") {
				if (!params.evidence) return { content: [{ type: "text", text: "Evidence is required." }], isError: true, details: {} };
				const uncovered = goal.criteria.filter((c) => c.evidence.length === 0);
				if (uncovered.length > 0) {
					return { content: [{ type: "text", text: "Cannot mark complete: " + uncovered.length + " criteria lack evidence." }], isError: true, details: {} };
				}
				updateState({ status: "complete", completionEvidence: params.evidence, noProgressCount: 0 }, ctx);
				pi.sendMessage(
					{ customType: GOAL_EVENT_TYPE, content: "Goal achieved! \u2705\n\nObjective: " + goal.objective + "\nEvidence: " + params.evidence, display: true, details: { kind: "complete", goal: { ...goal, status: "complete" } } },
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
		},
	});

	pi.registerTool({
		name: "propose_goal_draft", label: "Propose Goal Draft",
		description: "Propose a goal draft for user review. The user will see the objective and criteria, then choose Start, Edit, or Cancel.",
		parameters: Type.Object({
			objective: Type.String({ description: "Concise 1-2 sentence objective." }),
			criteria: Type.Array(Type.String(), { description: "3-7 verifiable criteria." }),
			constraints: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				if (goal?.status === "active") return { content: [{ type: "text", text: "A goal is already active." }], isError: true, details: {} };
				setGoal(params.objective, params.criteria, params.constraints ?? [], {}, ctx);
				return { content: [{ type: "text", text: "Goal created (non-interactive)." }], details: { goal: { ...goal! } } };
			}
			if (goal?.status === "active") {
				return { content: [{ type: "text", text: "A goal is already active. Clear it first." }], isError: true, details: {} };
			}
			const proposal: GoalProposal = { objective: params.objective, criteria: params.criteria, constraints: params.constraints ?? [] };
			const choice = await showGoalReview(proposal, ctx);
			switch (choice) {
				case "start": { setGoal(proposal.objective, proposal.criteria, proposal.constraints, {}, ctx); return { content: [{ type: "text", text: "Goal started: " + goal!.objective }], details: { goal: { ...goal! } } }; }
				case "edit": {
					const editedObjective = await ctx.ui.editor("Edit goal objective:", proposal.objective);
					if (!editedObjective?.trim()) return { content: [{ type: "text", text: "Cancelled (empty objective)." }], details: {} };
					const criteriaText = proposal.criteria.join("\n");
					const editedCriteria = await ctx.ui.editor("Edit criteria (one per line):", criteriaText);
					const newCriteria = (editedCriteria ?? criteriaText).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
					if (newCriteria.length === 0) return { content: [{ type: "text", text: "Cancelled (no criteria)." }], details: {} };
					setGoal(editedObjective.trim(), newCriteria, proposal.constraints, {}, ctx);
					return { content: [{ type: "text", text: "Goal started after edit: " + goal!.objective }], details: { goal: { ...goal! } } };
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
		description: "Set, view, pause, resume, or clear a long-running autonomous goal",
		getArgumentCompletions: (prefix) => {
			return ["status", "pause", "resume", "clear", "help"].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status") {
				if (!goal) {
					ctx.ui.notify("Usage: /goal <objective> [--tokens 50k]\n  /goal status | pause | resume | clear | help\n\nNo goal currently set.", "info");
					return;
				}
				const lines = ["Goal: " + goal.objective, "Status: " + goal.status,
					"Tokens: " + formatTokens(goal.tokensUsed) + (goal.tokenBudget ? "/" + formatTokens(goal.tokenBudget) : ""),
					"Time: " + formatDuration(goal.timeUsedMs), "Turns: " + goal.autoTurnCount];
				if (goal.criteria.length > 0) {
					lines.push("Criteria:");
					for (const c of goal.criteria) lines.push("  " + (c.evidence.length > 0 ? "\u2705" : "\u23F3") + " " + c.description);
				}
				if (goal.blocker) lines.push("Blocker: " + goal.blocker);
				if (goal.pausedReason) lines.push("Paused: " + goal.pausedReason);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (trimmed === "help") {
				ctx.ui.notify("/goal <objective> [--tokens N] — set a goal\n/goal status — show current goal\n/goal pause — pause\n/goal resume — resume\n/goal clear — remove", "info");
				return;
			}
			if (trimmed === "clear") { if (!goal) { ctx.ui.notify("No goal to clear.", "info"); return; } clearGoal(ctx); ctx.ui.notify("Goal cleared.", "info"); return; }
			if (trimmed === "pause") { if (!goal || goal.status !== "active") { ctx.ui.notify("No active goal.", "info"); return; } pauseGoal("user pause", ctx); ctx.ui.notify("Goal paused.", "info"); return; }
			if (trimmed === "resume") { if (!goal || goal.status !== "paused") { ctx.ui.notify("No paused goal.", "info"); return; } resumeGoal(ctx); ctx.ui.notify("Goal resumed.", "info"); return; }

			const { objective, tokenBudget } = parseTokenBudget(trimmed);
			if (!objective) { ctx.ui.notify("Usage: /goal <objective> [--tokens 50k]", "warning"); return; }
			const proposeMsg = "Draft a formal goal for the following task using the pi-goal-writer skill. Call propose_goal_draft with a concise objective and 3-7 concrete, independently verifiable acceptance criteria.\n\n<untrusted_task>\n" + objective + "\n</untrusted_task>\n\nToken budget: " + (tokenBudget ? formatTokens(tokenBudget) : "none");
			pi.sendUserMessage(proposeMsg);
		},
	});
}
