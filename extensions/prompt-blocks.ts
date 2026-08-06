import type { AssuranceDecision, CompletionFinding, CompletionEvaluation, GoalStateV2, StoredGoalCriterionV2 } from "./state";
import { DEFAULT_GOAL_CONFIG, taskRoutingBlock, taskGovernanceBlock, executionDecisionBlock, injectSuperpowersCoding, type GoalConfig } from "./config";
import { escapeXml, formatDuration, formatTokens } from "./util";

export type GoalState = GoalStateV2;
export type Criterion = StoredGoalCriterionV2;

export function buildCriteriaBlock(criteria: Criterion[]): string {
	if (criteria.length === 0) return "";
	const lines = criteria.map((c) => {
		const evidenceCount = c.evidenceRefs.length;
		const icon = evidenceCount > 0 ? "\u2705" : c.level === "advisory" ? "\u2022" : "\u23F3";
		return `  ${icon} [${c.id}] ${c.description} [${c.level}]${evidenceCount > 0 ? ` (evidence: ${evidenceCount})` : ""}`;
	});
	return "\nCriteria progress:\n" + lines.join("\n");
}

export function completionFeedbackBlock(goal: GoalState, config: GoalConfig = DEFAULT_GOAL_CONFIG): string {
	// Shadow audits are deliberately non-authoritative. Legacy and V2 blocking
	// evaluations are durable control-plane feedback and must reach the next turn.
	if (config.completionPolicy === "shadow") return "";
	const evaluation = goal.completion.lastEvaluation;
	if (!evaluation || evaluation.decision === "accept") return "";
	const findings = evaluation.findings.map((finding) =>
		"- [" + finding.code + "] " + finding.subjectId + ": " + finding.reason,
	).join("\n");
	const strategy = goal.completion.rejectionCount >= 2
		? "The same structural rejection repeated. Change verification strategy or replan; do not add more evidence of the same kind merely to increase a count."
		: "Address only the concrete blocking gaps below.";
	const resubmit = "\nAfter addressing the gaps, call update_goal({ action: \"request_completion\", summary }) again to trigger a fresh evaluation — the previous request was already judged and will not re-run automatically.";
	return "\n\n<COMPLETION-FEEDBACK>\n" + strategy + "\n" + (findings || "- No structured finding was recorded.") + resubmit + "\n</COMPLETION-FEEDBACK>\n";
}

export function reviewerTranscriptDecision(findings: unknown): "passed" | "failed" | null {
	const first = Array.isArray(findings) ? findings[0] : findings;
	const text = typeof first === "string" ? first : first && typeof first === "object" ? JSON.stringify(first) : "";
	if (!text.trim()) return null;
	if (/❌|⚠️|\b(?:not ready|ready with fixes|rejected|reject|failed|fail)\b/i.test(text)) return "failed";
	if (/✅\s*ready|\bapproved\b/i.test(text)) return "passed";
	return null;
}

export function transcriptBindsFinding(transcriptFindings: unknown, finding: CompletionFinding): boolean {
	const text = typeof transcriptFindings === "string" ? transcriptFindings : JSON.stringify(transcriptFindings);
	if (!text.includes(finding.subjectId)) return false;
	const evidenceBinding = finding.evidenceRefs && finding.evidenceRefs.length > 0
		? finding.evidenceRefs.every((ref) => text.includes(ref))
		: Boolean(finding.missingEvidenceKind && text.includes(finding.missingEvidenceKind));
	return evidenceBinding;
}

export function assuranceAfterOutcomeMutation(
	goal: GoalState,
	config: GoalConfig,
	reason: string,
	forceRequired = false,
): AssuranceDecision {
	const requirement = config.reviewPolicy === "never"
		? "none"
		: config.reviewPolicy === "always" || forceRequired ? "required" : goal.assurance.reviewRequirement;
	const reasons = goal.assurance.reasons.includes(reason)
		? [...goal.assurance.reasons]
		: [...goal.assurance.reasons, reason];
	return {
		...goal.assurance,
		reviewRequirement: requirement,
		reviewStatus: requirement === "none" ? "not_required" : "pending",
		independent: requirement !== "none",
		depth: requirement === "required" ? "deep" : goal.assurance.depth,
		reasons,
		decidedAt: Date.now(),
	};
}

export function isTerminalGoalStatus(status: GoalState["status"]): boolean {
	return status === "complete" || status === "unmet" || status === "blocked";
}

export function legacyAcceptedEvaluation(goal: GoalState, reason: string, evaluatedAt: number): CompletionEvaluation {
	return {
		decision: "accept",
		evaluatedAt,
		criterionCoverage: goal.criteria.map((criterion) => ({
			criterionId: criterion.id,
			status: criterion.evidenceRefs.length > 0 ? "satisfied" : "unsatisfied",
			evidenceRefs: [...criterion.evidenceRefs],
			reason: criterion.evidenceRefs.length > 0
				? "The legacy compatibility gate observed persisted criterion evidence."
				: "The legacy compatibility gate did not require evidence for this advisory criterion.",
		})),
		claimCoverage: [],
		findings: [],
		advisories: ["Accepted by completionPolicy=legacy compatibility semantics; research claim coverage was not evaluated by Goal V2.", reason],
		evaluator: { kind: "judge" },
		fingerprint: null,
	};
}

export function reviewerTranscriptContractBlock(goal: GoalState): string {
	if (goal.assurance.reviewRequirement === "none") return "";
	return "\n\nReviewer transcript contract:\n" +
		"- report_role_result.findings[0] must be exactly `✅ Ready` or `❌ Not ready`.\n" +
		"- Every blocking finding must then name code, subjectId (criterion, claim, or $constraint:n), and either evidenceRefs or missingEvidenceKind.\n" +
		"- Submit those same identifiers through update_goal action=record_review; unbound or contradictory verdicts are rejected.\n";
}

// continuationPrompt — uses string concatenation (no template literals with backticks)
export function superpowersAdaptationBlock(): string {
	return (
		"<GOAL-MODE-ADAPTATION>\n" +
		"The superpowers skills you are about to load were designed for interactive use where\n" +
		"a human is present. Since you are in autonomous goal mode, adapt EVERY instruction:\n\n" +
		"| Skill says... | You do this instead... |\n" +
		"|---|---|\n" +
		'| "get user approval" | Dispatch a reviewer subagent as the autonomous approver. |\n' +
		'| "ask clarifying questions" | Spawn a researcher subagent to gather context, then a reviewer to validate assumptions before proceeding. |\n' +
		'| "present the design" | Write to a file, then dispatch the approver to review it. |\n' +
		'| "invoke <skill> skill" | Load the skill by name: run /skill:<name> (e.g. /skill:writing-plans). Pi auto-loads skills by description, so simply announcing the skill name also works. Do NOT hardcode file paths — the superpowers bundle is installed as the "pi-superpowers" package, not a local directory. |\n' +
		'| "HARD-GATE: no code until approved" | RESPECT THIS. Do not write code. Dispatch approver, get approval, then proceed. |\n\n' +
		"REMEMBER: The approver IS the user for this goal run. Treat its decisions as binding.\n" +
		"</GOAL-MODE-ADAPTATION>\n\n"
	);
}

export function superpowersDisciplineBlock(): string {
	return (
		"<EXTREMELY-IMPORTANT>\n" +
		"You are executing an autonomous goal. The user is NOT watching. You MUST follow process discipline.\n\n" +
		"BEFORE taking any action this turn, load the using-superpowers skill, then check its situation\n" +
		"table and load the relevant superpowers skill for this turn's work.\n\n" +
		"For this turn's work, determine the right superpowers skill (load by name with /skill:<name>):\n" +
		"| If this turn involves... | Load this skill |\n" +
		"|---|---|\n" +
		"| Open-ended design, architecture, new approach | /skill:brainstorming |\n" +
		"| Multi-file or coordinated changes | /skill:writing-plans |\n" +
		"| Executing a written plan | /skill:subagent-driven-development |\n" +
		"| Adding testable behavior | /skill:test-driven-development |\n" +
		"| Bug or unexpected behavior | /skill:systematic-debugging |\n" +
		'| About to claim anything is done | /skill:verification-before-completion |\n\n' +
		"<HARD-GATE>\n" +
		"If a superpowers skill requires an approval gate, do NOT stop or skip it.\n" +
		"Instead, dispatch a reviewer subagent as the autonomous approver.\n\n" +
		"Use this dispatch template for the approver:\n\n" +
		"    spawn_role({\n" +
		'      role: "reviewer",\n' +
		'      task: "You are the autonomous approver for an unattended goal run.\\n' +
		"      The user is not present. You make the call.\\n\\n" +
		"      GOAL: <copy objective from above>\\n" +
		"      REVIEWING: <the design, plan, or code being evaluated>\\n\\n" +
			"      Evaluate on THREE dimensions, then call report_role_result. findings[0] must be exactly ✅ Ready or ❌ Not ready:\\n" +
		"      1. PROCESS - was the superpowers process followed?\\n" +
		"      2. TECHNICAL - does it work? Are there placeholders?\\n" +
		"      3. USER VALUE - does this deliver what the goal requires?\\n\\n" +
		"      APPROVE if sound. REJECT if broken, skipped steps, or placeholders.\\n" +
			'      Rejection MUST include specific, actionable feedback with code, subjectId, and evidenceRefs or missingEvidenceKind."\n' +
		"    })\n\n" +
		"    // ponytail: foreground (default mode) is correct for an approval gate — the\n" +
		"    // approver blocks until the reviewer reports. background mode is Phase 5.\n\n" +
		"APPROVE if sound. REJECT if broken, skipped steps, or doesn't meet the goal.\n" +
		"IF THE APPROVER REJECTS 3 CONSECUTIVE TIMES: pause goal with update_goal({ status: \"unmet\" }).\n" +
		"</HARD-GATE>\n\n" +
		"<HARD-GATE>\n" +
		"If writing code without a plan for multi-file changes, STOP. Load writing-plans first.\n" +
		"If claiming completion without verification-before-completion, STOP. Verify first.\n" +
		"If implementing without TDD (test first, watch it fail, then code), STOP. Follow TDD.\n" +
		"</HARD-GATE>\n" +
		"</EXTREMELY-IMPORTANT>\n\n"
	);
}

export function continuationPrompt(goal: GoalState, config: GoalConfig = DEFAULT_GOAL_CONFIG, maxAutoTurns = Number(process.env.GOAL_MAX_AUTO_TURNS) || 200): string {
	const budgetLine = goal.tokenBudget != null
		? "- Token budget: " + formatTokens(goal.tokenBudget) + " (" + formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed)) + " remaining)"
		: "- No token budget set";
	// 预算感知规划（审计 P0，简化版）：team 执行且设有预算时，引导把全局
	// 预算按节点分配并写进节点任务，避免单个节点烧掉全部预算。
	const budgetAwarePlanning = goal.execution.selected === "team" && goal.tokenBudget != null
		? "\nBudget-aware planning: the goal has a total token budget of " + formatTokens(goal.tokenBudget) +
			". When building the DAG, estimate each node's token cost and write an explicit budget hint into each node's task (e.g. \"budget: ~X tokens — stop early if the answer is found\"). Do not give one node the whole budget."
		: "";
	const criteriaBlock = buildCriteriaBlock(goal.criteria);
	const criteriaInstruction = goal.criteria.length > 0
		? "\n3. Record evidence with update_goal({ action: \"record_evidence\", criterionId, evidence: {...} }).\n4. Maintain research claims with action: \"upsert_claim\" when applicable.\n5. When blocking outcomes are satisfied, call update_goal({ action: \"request_completion\", summary })."
		: "";

	return (
		(config.superpowersIntegration ? taskRoutingBlock(config) : "") +
		(injectSuperpowersCoding(config, goal.taskKind) ? superpowersAdaptationBlock() + superpowersDisciplineBlock() : "") +
			(config.superpowersIntegration ? taskGovernanceBlock(goal.taskKind) : "") +
			executionDecisionBlock(goal.execution) +
			reviewerTranscriptContractBlock(goal) +
			completionFeedbackBlock(goal, config) +
		"---\n\n" +
		"Continue working toward the active goal.\n\n" +
		"<untrusted_objective>\n" +
		escapeXml(goal.objective) + "\n" +
		"</untrusted_objective>\n\n" +
		"Progress:\n" +
		"- Tokens used: " + formatTokens(goal.tokensUsed) + "\n" +
		budgetLine + "\n" +
		"- Time spent: " + formatDuration(goal.timeUsedMs) + "\n" +
		"- Auto-continuation turns: " + goal.autoTurnCount + "/" + maxAutoTurns + "\n" +
		budgetAwarePlanning + "\n" +
		criteriaBlock + "\n\n" +
		"Rules:\n" +
		"1. Before marking complete, perform a strict completion audit against real evidence:\n" +
		"   - Inspect relevant files, command output, test results\n" +
		"   - Verify every criterion has been met with concrete evidence\n" +
		"   - Do not accept proxy signals or partial progress as completion\n" +
			"2. Completion is evaluated from the persisted evidence ledger after an explicit request. Advisory gaps never reject completion.\n" +
		criteriaInstruction + "\n" +
			"6. Do not request completion merely because budget is nearly exhausted."
	);
}

export function budgetLimitPrompt(goal: GoalState): string {
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

// Per-turn governance rules, injected via before_agent_start so they survive
// long-conversation dilution (the user's stated reason these used to live in
// CLAUDE.md). 深修 C: governance 按 task_type 分流 (config.ts taskGovernanceBlock),
// 非 coding 任务不套 coding 门,各有自己的 governance 块。
/** 验证失败后的修复形态引导（UX: 主 agent 倾向主会话缝补，而不是回到 DAG 结构）。
 *  决策顺序：定位节点 → dag_rerun 重跑；结构问题 → specPatch；反复失败 → 根因
 *  上溯 + 调研；需要用户决策 → pause 汇报。交互一律前置，执行中不打断用户。 */
function executionFailureGuidanceBlock(): string {
	return "\n\n## Execution failure recovery\n" +
		"When a DAG execution finishes but completion verification fails, recover inside the DAG structure instead of patching files directly in the main session:\n" +
		"1. If the failure maps to specific nodes, call dag_rerun(checkpoint, { rerunNodes: [...], inject: { nodeId: \"why it failed / what verification rejected\" } }) — it reruns those nodes AND their downstream closure, reusing untouched results.\n" +
		"2. If the graph itself is wrong (missing nodes, wrong dependencies, wrong roles), call dag_rerun with specPatch { add | remove | modify } to restructure, then rerun.\n" +
		"3. Only patch directly in the main session for a small, isolated issue that no DAG node owns — and say so explicitly.\n" +
		"4. When the same class of failure repeats, stop re-running: analyze the ROOT CAUSE upstream — is a preceding step missing (research, design, verification) that would make later steps flow? Run web_search to see how others solve it before changing anything.\n" +
		"5. If progress is impossible without a user decision, call update_goal({ action: \"pause\", reason: \"<what is blocked, what decision is needed>\" }) — the goal pauses and reports to the user. Never keep patching in circles.";
}

export function goalSystemPrompt(goal: GoalState, config: GoalConfig = DEFAULT_GOAL_CONFIG): string {
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
		"Use update_goal action=record_evidence to add evidence to the ledger.\n" +
		'When blocking outcomes are satisfied, call update_goal({ action: "request_completion", summary: "..." }).\n' +
		"The completion evaluator uses the persisted ledger, claims, deterministic verification, and the latest response." +
		(config.superpowersIntegration ? taskRoutingBlock(config) : "") +
			(config.superpowersIntegration ? taskGovernanceBlock(goal.taskKind) : "") +
			executionDecisionBlock(goal.execution) + reviewerTranscriptContractBlock(goal) + completionFeedbackBlock(goal, config) +
		executionFailureGuidanceBlock();
}

