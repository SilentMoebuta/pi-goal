import type { AssuranceDecision, CompletionFinding, CompletionEvaluation, GoalStateV2, StoredGoalCriterionV2 } from "./state";
import { DEFAULT_GOAL_CONFIG, taskRoutingBlock, taskGovernanceBlock, executionDecisionBlock, injectSuperpowersCoding, type GoalConfig, type ReviewerProtocolHint } from "./config";
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
	return status === "complete" || status === "unmet" || status === "blocked" || status === "cancelled";
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
	if (usesAtomicCompletionV3(goal)) {
		const criterionIds = JSON.stringify(goal.criteria.map((criterion) => criterion.id));
		const evidenceIds = JSON.stringify(goal.evidenceLedger.map((evidence) => evidence.id));
		return "\n\nGoal Contract V3 completion protocol:\n" +
			"- Use the read-only goal-reviewer role for the independent completion review. Pass exact criteria, evidence IDs, deterministic checks, and artifact paths.\n" +
			"- Call spawn_role with resultConstraints.criterionIds exactly " + criterionIds + "; deterministic check IDs are not criterion IDs.\n" +
			"- Set resultConstraints.evidenceIds to the exact non-empty IDs submitted in the completion bundle (currently persisted: " + evidenceIds + ") and resultConstraints.artifactUris to the exact submitted artifact URIs.\n" +
			"- The reviewer returns decision, summary, criterionCoverage, structured findings, artifact SHA-256/size receipts, and an immutable resultRef.\n" +
			"- Compute the same lowercase SHA-256 digests and byte sizes from current artifact bytes.\n" +
			"- Submit artifacts, evidence, deterministicChecks, and reviewerResultRef in one update_goal action=submit_completion_bundle call.\n" +
			"- An accept reviewer result is ready for atomic submission; advisories are non-blocking. If artifact bytes change, obtain a new constrained reviewer result before submitting.\n" +
			"- Do not inspect reviewer session files, parse identifiers from filenames, use symbolic verdict phrases, or separately record review/completion.\n";
	}
	return "\n\nReviewer transcript contract:\n" +
		"- report_role_result.findings[0] must be exactly `✅ Ready` or `❌ Not ready`.\n" +
		"- Every blocking finding must then name code, subjectId (criterion, claim, or $constraint:n), and either evidenceRefs or missingEvidenceKind.\n" +
		"- For report/artifact defects also provide scope (local/section/global), targetPath, sectionId, anchor, requiredFix, and rewriteRequired. rewriteRequired may be true only for a global structural defect and must include rewriteReason.\n" +
		"- Submit those same identifiers through update_goal action=record_review; unbound or contradictory verdicts are rejected.\n";
}

export function usesAtomicCompletionV3(goal: GoalState): boolean {
	return goal.runtime?.contractVersion === 3
		&& goal.assurance.reviewRequirement !== "none"
		&& goal.completion.requestedAt === null
		&& goal.completion.lastEvaluation === null;
}

function reviewerProtocolHint(goal: GoalState): ReviewerProtocolHint {
	if (goal.assurance.reviewRequirement === "none") return "none";
	return usesAtomicCompletionV3(goal) ? "atomic-v3" : "legacy-v2";
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
		"      Evaluate on THREE dimensions, then call report_role_result with findings[0] as an object containing id, decision=approve|reject, reason, and evidenceRefs:\\n" +
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

function blueprintEntrypoint(goal: GoalState): "interactive" | "headless" | "api" {
	return goal.runtime?.entrypoint ?? (goal.headless ? "headless" : "interactive");
}

export function goalBlueprintBlock(goal: GoalState): string {
	const blueprint = goal.blueprint;
	if (!blueprint) return "";
	const entrypoint = blueprintEntrypoint(goal);
	const lines: string[] = ["\n<GOAL-BLUEPRINT>"];
	lines.push("Entrypoint: " + entrypoint + ". Treat this pre-specified blueprint as STRONG guidance.");
	if (entrypoint === "headless") {
		lines.push("This run runs unattended for an external caller; durable progress and terminal state are projected through the goal log and result artifact.");
	} else if (entrypoint === "interactive") {
		lines.push("The user can steer the run in real time and can pause, resume, edit, or fork it from the interactive session.");
	} else {
		lines.push("The API caller controls lifecycle and steering; preserve durable state so control can resume from checkpoints.");
	}
	lines.push("If you deviate from any declared item (topology, roles, DAG nodes, evidence expectations, review setup),");
	lines.push("you MUST call update_goal({ action: \"record_deviation\", subjectId?, description, reason, impact }) as you deviate.");
	lines.push("An unreported deviation is a blueprint contract violation regardless of entrypoint.");
	if (blueprint.entry?.prompt) {
		lines.push("");
		lines.push("Entry instructions:");
		lines.push(blueprint.entry.prompt);
	}
	lines.push("");
	lines.push("Execution blueprint:");
	lines.push("- Topology: " + blueprint.execution.topology);
	if (blueprint.execution.role) lines.push("- Registered role: " + blueprint.execution.role);
	const roleDefs = blueprint.execution.roleDefs ?? [];
	for (const roleDef of roleDefs) {
		const meta = [
			...(roleDef.tools && roleDef.tools.length > 0 ? ["tools: " + roleDef.tools.join(", ")] : []),
			...(roleDef.maxTurns ? ["maxTurns: " + roleDef.maxTurns] : []),
			...(roleDef.model ? ["model: " + roleDef.model] : []),
		].join("; ");
		lines.push("- roleDef " + roleDef.name + ": " + roleDef.description + (meta ? " (" + meta + ")" : ""));
	}
	const dag = blueprint.execution.dag;
	if (dag) {
		lines.push("- DAG (expect to execute with dag_execute, honoring consumers/depends_on):");
		for (const node of dag.nodes) {
			const target = node.roleDef ? " via " + node.roleDef : node.role ? " via role " + node.role : " (main agent)";
			const consumers = node.consumers && node.consumers.length > 0 ? " -> " + node.consumers.join(", ") : "";
			lines.push("  * " + node.id + target + ": " + node.task + consumers);
		}
		if (dag.maxConcurrent) lines.push("- maxConcurrent: " + dag.maxConcurrent);
	}
	const evidence = blueprint.evidence;
	if (evidence && ((evidence.criteria ?? []).length > 0 || (evidence.nodes ?? []).length > 0)) {
		lines.push("");
		lines.push("Evidence expectations (diagnostic — gaps appear as advisories, they do not by themselves reject completion):");
		for (const expectation of evidence.criteria ?? []) {
			const kinds = expectation.kinds && expectation.kinds.length > 0 ? expectation.kinds.join("/") : "any kind";
			lines.push("- " + expectation.id + ": " + kinds + " x" + (expectation.minCount ?? 1) + (expectation.verification ? " " + expectation.verification : "") + (expectation.note ? " — " + expectation.note : ""));
		}
		for (const node of evidence.nodes ?? []) {
			lines.push("- node " + node.id + " should produce " + node.evidenceKind + " evidence attached to " + node.attachTo);
		}
	}
	const review = blueprint.review;
	if (review) {
		lines.push("");
		lines.push("Reviewer:");
		lines.push("- Requirement: " + (review.requirement ?? "advisory"));
		if (review.checklist.length > 0) {
			lines.push("- Checklist (spawn the reviewer with these checks):");
			for (const [index, item] of review.checklist.entries()) lines.push("  " + (index + 1) + ". " + item);
		}
		const reviewerMeta = [
			...(review.model ? ["model: " + review.model] : []),
			...(review.thinkingLevel ? ["thinking: " + review.thinkingLevel] : []),
		].join("; ");
		if (reviewerMeta) lines.push("- " + reviewerMeta);
	}
	if (blueprint.verification?.command) {
		lines.push("");
		lines.push("Verification command: " + blueprint.verification.command + (blueprint.verification.timeoutMs ? " (timeout " + blueprint.verification.timeoutMs + "ms)" : ""));
	}
	lines.push("</GOAL-BLUEPRINT>");
	return lines.join("\n");
}

/** Per-turn blueprint guidance, specialized only where entrypoint lifecycle semantics differ. */
export function goalBlueprintContinuationBlock(goal: GoalState): string {
	const blueprint = goal.blueprint;
	if (!blueprint) return "";
	const block = goalBlueprintBlock(goal);
	if (!block) return "";
	const entrypoint = blueprintEntrypoint(goal);
	const lifecycleGuidance = entrypoint === "headless"
		? "This run runs unattended: every turn, record evidence with update_goal({ action: \"record_evidence\", criterionId, evidence }) so the external caller sees durable progress in the goal log. If a user decision is required, call update_goal({ action: \"pause\", reason }) so the run reports instead of waiting silently."
		: entrypoint === "interactive"
			? "The user can steer the run in real time. Reconcile new instructions with the blueprint and durable goal state before continuing. Every turn, record evidence with update_goal({ action: \"record_evidence\", criterionId, evidence }); use pause/resume when execution should stop and continue."
			: "Accept lifecycle control and steering from the API caller. Every turn, record evidence with update_goal({ action: \"record_evidence\", criterionId, evidence }) so checkpoints and status projections remain durable.";
	return "\n\n" + block + "\n\n" + lifecycleGuidance + "\n";
}

/** @deprecated Use goalBlueprintBlock; retained for extension API compatibility. */
export const headlessBlueprintBlock = goalBlueprintBlock;
/** @deprecated Use goalBlueprintContinuationBlock; retained for extension API compatibility. */
export const headlessContinuationBlock = goalBlueprintContinuationBlock;

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
		? "\n3. Record evidence with update_goal({ action: \"record_evidence\", criterionId, evidence: {...} }).\n4. Maintain research claims with action: \"upsert_claim\" when applicable.\n5. " +
			(usesAtomicCompletionV3(goal)
				? "When blocking outcomes are satisfied, obtain a goal-reviewer resultRef and call update_goal({ action: \"submit_completion_bundle\", ... })."
				: "When blocking outcomes are satisfied, call update_goal({ action: \"request_completion\", summary }).")
		: "";

	return (
		(config.superpowersIntegration ? taskRoutingBlock(config) : "") +
		(injectSuperpowersCoding(config, goal.taskKind) ? superpowersAdaptationBlock() + superpowersDisciplineBlock() : "") +
			(config.superpowersIntegration ? taskGovernanceBlock(goal.taskKind, reviewerProtocolHint(goal)) : "") +
			executionDecisionBlock(goal.execution) +
			reviewerTranscriptContractBlock(goal) +
			completionFeedbackBlock(goal, config) +
		goalBlueprintContinuationBlock(goal) +
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
		"When a review or completion check finds a defect in an existing report/artifact, use PATCH-FIRST remediation:\n" +
		"1. Classify each finding as local, section, or global and record a stable id, targetPath, sectionId, anchor, problem, requiredFix, evidenceRefs, and rewriteRequired.\n" +
		"2. For local/section findings, read the existing targetPath and edit it in place (or under the project's edited-sections override), preserving the artifact path and unrelated sections. Do not call write to regenerate the entire report.\n" +
		"3. Re-review the same finding ids individually after the patch. A finding is closed only when its target anchor and requiredFix are verified.\n" +
		"4. Preserve the original draft by strong default. A full rewrite remains available for the exceptional case where scope=global, rewriteRequired=true, and a concrete reason explains why bounded edits cannot keep the document coherent; otherwise do not rerun the writer DAG node.\n" +
		"5. Use dag_rerun only for a genuinely structural graph failure (missing node, wrong dependency, or invalid upstream result), and rerun the smallest affected closure.\n" +
		"6. When the same class of failure repeats, stop and report the root cause. If progress needs a user decision, call update_goal({ action: \"pause\", reason: \"<what is blocked, what decision is needed>\" }).";
}

export function goalSystemPrompt(goal: GoalState, config: GoalConfig = DEFAULT_GOAL_CONFIG): string {
	const criteriaBlock = buildCriteriaBlock(goal.criteria);
	const budgetInfo = goal.tokenBudget != null
		? "Token budget: " + formatTokens(goal.tokenBudget) + " (" + formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed)) + " remaining)"
		: "No token budget";
	const completionInstruction = usesAtomicCompletionV3(goal)
		? "When blocking outcomes are satisfied, obtain an independent goal-reviewer resultRef and submit one atomic update_goal action=submit_completion_bundle.\n"
		: 'When blocking outcomes are satisfied, call update_goal({ action: "request_completion", summary: "..." }).\n';

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
		completionInstruction +
		"The completion evaluator uses the persisted ledger, claims, deterministic verification, and the latest response." +
		(config.superpowersIntegration ? taskRoutingBlock(config) : "") +
			(config.superpowersIntegration ? taskGovernanceBlock(goal.taskKind, reviewerProtocolHint(goal)) : "") +
			executionDecisionBlock(goal.execution) + reviewerTranscriptContractBlock(goal) + completionFeedbackBlock(goal, config) +
		goalBlueprintContinuationBlock(goal) +
		executionFailureGuidanceBlock();
}
