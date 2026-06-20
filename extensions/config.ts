import * as fs from "node:fs";
import * as path from "node:path";

export interface GoalConfig {
	/** Inject superpowers workflow discipline (skill mapping, HARD-GATE,
	 *  reviewer-subagent template) into the goal continuation prompt and the
	 *  per-turn system prompt. Default true: pi-goal is designed to pair with
	 *  pi-superpowers. Set false in .pi/goal.json for standalone use. */
	superpowersIntegration: boolean;

	/** GG-14: a "provider/model-id" spec for the per-turn judge LLM call.
	 *  When set (trusted projects only, via .pi/goal.json), runJudge resolves it
	 *  via ctx.modelRegistry.find(provider, modelId) and uses that model instead
	 *  of the session's ctx.model — so a cheap/fast evaluator can judge without
	 *  burning the main model every turn. Falls back to ctx.model when unset or
	 *  unresolvable. Default undefined = backward-compatible (uses ctx.model). */
	judgeModel?: string;

	/** GG-1: a shell command run via child_process as a DETERMINISTIC
	 *  verification gate before the LLM judge (trusted projects only, via
	 *  .pi/goal.json, e.g. {"verifyCommand":"npm test"}). When set,
	 *  runJudge runs it and short-circuits done:false on a non-zero exit,
	 *  with the truncated stderr/stdout as the reason. When unset (default),
	 *  runJudge is UNCHANGED — LLM-judge-only. The strongest SOTA completion
	 *  signal per the C1 gap analysis; opt-in + trusted-gate keeps it safe.
	 *  Security: loadGoalConfig only populates this for trusted projects, so
	 *  runJudge can trust the field's presence without re-checking trust. */
	verifyCommand?: string;

	/** GG-3: a "provider/model-id" spec for a stronger model consulted when the
	 *  goal stalls (no-progress). When set (trusted projects only, via
	 *  .pi/goal.json), a stuck goal asks this model for ONE concrete next-step
	 *  suggestion, injected into the next continuation before pausing. Falls
	 *  back to pause-only when unset. Default undefined = backward-compatible. */
	stuckEscalateModel?: string;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = { superpowersIntegration: true, judgeModel: undefined, verifyCommand: undefined, stuckEscalateModel: undefined };

/** GG-3: build the prompt sent to a stronger model when the goal stalls, asking
 *  for ONE concrete next step to unstick it. Pure + unit-testable; the model
 *  call + injection is runtime (escalateStuck in extensions/index.ts). */
export function buildEscalationPrompt(input: { objective: string; criteriaSummary: string }): string {
	return "A goal-driven agent has stalled (no progress for several turns). Propose ONE concrete next step to unstick it — a specific action it should take next, not a plan.\n\n"
		+ "Goal objective: " + input.objective + "\n\n"
		+ "Criteria progress:\n" + (input.criteriaSummary || "(none)") + "\n\n"
		+ "Reply with ONLY the single concrete next step, no preamble or explanation.";
}

/** GG-14: parse a "provider/model-id" spec into {provider, modelId} for
 *  modelRegistry.find(). Returns null for anything that cannot resolve to a
 *  (non-empty provider, non-empty modelId) pair, so runJudge can fall back to
 *  ctx.model safely. */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
	if (!spec || typeof spec !== "string") return null;
	const slash = spec.indexOf("/");
	if (slash <= 0) return null; // no slash, or empty provider before it
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1).trim();
	if (!provider.trim() || !modelId) return null;
	return { provider, modelId };
}

/** Detect an in-process subagent session (spawned by @gotgenes/pi-subagents).
 *  Mirrors the isSubagentSession guard in pi-plan-execute-gate/gate.ts: a
 *  subagent session is created via SessionManager.newSession({ parentSession }),
 *  so ctx.sessionManager.getHeader()?.parentSession is set.
 *
 *  Divergence from the gate: the gate is permissive (returns true on a missing
 *  header → force Build Mode so delegated work is never blocked). pi-goal's
 *  correct action on a missing header is to run NORMALLY (reconstruct the
 *  goal), so here we only short-circuit when parentSession is positively
 *  present. Skipping reconstruction on a headerless top-level session would
 *  silently null out the parent's live `goal` closure — the exact bug this
 *  guard exists to prevent.
 *  ponytail: inlined rather than importing from pi-plan-execute-gate (that
 *  package does not ship gate.ts in its npm `files`, and pi-goal has no
 *  runtime dep on it; ~8 lines beat a new cross-package coupling). */
export function isSubagentSession(ctx: {
	sessionManager: { getHeader?: () => { parentSession?: string } | null } | null;
}): boolean {
	try {
		const header = ctx.sessionManager?.getHeader?.();
		return Boolean(header?.parentSession);
	} catch {
		return false;
	}
}

/** Load optional config from <cwd>/.pi/goal.json (trusted projects only).
 *  Falls back to DEFAULT_GOAL_CONFIG on any error or missing file. */
export function loadGoalConfig(cwd: string, trusted: boolean): GoalConfig {
	if (!trusted) return { ...DEFAULT_GOAL_CONFIG };
	const cfgPath = path.join(cwd, ".pi", "goal.json");
	try {
		if (!fs.existsSync(cfgPath)) return { ...DEFAULT_GOAL_CONFIG };
		const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<GoalConfig> & Record<string, unknown>;
		return {
			superpowersIntegration: raw.superpowersIntegration === false ? false : true,
			judgeModel: typeof raw.judgeModel === "string" ? raw.judgeModel : undefined,
			verifyCommand: typeof raw.verifyCommand === "string" ? raw.verifyCommand : undefined,
			stuckEscalateModel: typeof raw.stuckEscalateModel === "string" ? raw.stuckEscalateModel : undefined,
		};
	} catch {
		return { ...DEFAULT_GOAL_CONFIG };
	}
}

// ═══════════════════════════════════════════════════════════════════════
// HCI helpers (research/2026-06-19-pi-goal-hci-audit.md)
// Pure functions extracted so tool-availability / resume / footer logic is
// unit-testable without spinning up the extension.
// ═══════════════════════════════════════════════════════════════════════

export type GoalStatus =
	| "active" | "paused" | "budget_limited" | "usage_limited"
	| "blocked" | "complete" | "unmet";

/** Terminal statuses: a goal in these states cannot be resumed (must clear to
 *  restart). blocked = superseded by a newer goal; unmet = blocker unresolved;
 *  complete = done. */
export function isTerminalStatus(status: GoalStatus | null | undefined): boolean {
	return !status || status === "blocked" || status === "unmet" || status === "complete";
}

/** P0-1 fix: update_goal is available in EVERY state where a goal exists, not
 *  just active. This breaks the pause→no-update_goal deadlock (agent can
 *  self-resume) and lets the agent amend evidence / revert after complete. */
export function canUpdateGoal(status: GoalStatus | null | undefined): boolean {
	return !!status;
}

/** P0-2 fix: /goal resume covers every non-terminal paused/limited state.
 *  blocked/unmet/complete are terminal (clear to restart). */
export function canResumeGoal(status: GoalStatus | null | undefined): boolean {
	return status === "paused" || status === "budget_limited" || status === "usage_limited";
}

export interface FooterStatusInfo {
	usage?: string;          // e.g. "1.2k/50k" or "3m12s" for active
	pausedReason?: string | null;
	blocker?: string | null;
}

/** P1-1/P1-2/P1-3 fix: footer text surfaces the pause/blocker reason or
 *  completion, not just a bare status word. Returns undefined to clear the
 *  footer only when there is genuinely nothing to show (no goal). */
export function footerStatusText(status: GoalStatus | null | undefined, info: FooterStatusInfo, theme?: { fg: (color: string, text: string) => string }): string {
	const fg = (color: string, text: string) => (theme ? theme.fg(color, text) : text);
	const trunc = (s: string | null | undefined, n = 40) =>
		(s && s.length > 0 ? ": " + (s.length > n ? s.slice(0, n) + "…" : s) : "");
	switch (status) {
		case "active":
			return fg("accent", "🎯 goal" + (info.usage ? " (" + info.usage + ")" : ""));
		case "paused":
			return fg("warning", "⏸ goal paused" + trunc(info.pausedReason));
		case "budget_limited":
			return fg("warning", "💰 budget reached" + trunc(info.pausedReason));
		case "usage_limited":
			return fg("warning", "⚠ usage limited" + trunc(info.pausedReason));
		case "blocked":
			return fg("error", "🚩 goal blocked" + trunc(info.blocker));
		case "unmet":
			return fg("error", "🚩 goal unmet" + trunc(info.blocker));
		case "complete":
			return fg("success", "✅ goal achieved");
		default:
			return "";
	}
}
