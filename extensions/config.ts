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

	/** GG-1: max ms the verify command may run before being SIGKILLed (default
	 *  120000 — real test suites exceed the old 30s cap). Trusted projects only. */
	verifyTimeoutMs?: number;

	/** Phase-1 task-routing: force a task type so the main agent skips LLM
	 *  auto-judgment and uses the named workflow directly. Rollback path for
	 *  misjudged task types (e.g. a non-coding goal that wrongly entered the
	 *  superpowers coding flow). Values: "coding" | "research" | "pm" |
	 *  "review" | undefined. Default undefined = LLM auto-judges via the
	 *  routing清单. Trusted projects only (read from .pi/goal.json). */
	forceTaskType?: string;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = { superpowersIntegration: true, judgeModel: undefined, verifyCommand: undefined, stuckEscalateModel: undefined, verifyTimeoutMs: undefined, forceTaskType: undefined };

/** Whether to inject the superpowers coding-flow blocks (superpowersAdaptation
 *  + superpowersDiscipline + GOAL_GOVERNANCE). True when superpowersIntegration
 *  is on AND the task is coding — either forceTaskType is unset (LLM
 *  auto-judges, default) or explicitly "coding". False when forceTaskType is a
 *  non-coding type (research/pm/review) — clean rollback: suppress the coding
 *  gates so the LLM does not receive competing instructions ("follow TDD
 *  HARD-GATE" + "use research workflow"). Gating on explicit USER-DECLARED
 *  config is NOT a runtime task-type classifier (no research violated).
 *
 *  深修 C: 加 goalTaskType 参数(per-goal,来自 GoalState.taskType)。
 *  优先级: goalTaskType > config.forceTaskType > undefined(coding 默认,backward-compat)。
 *  undefined → 仍注入 coding(legacy 行为不变),只有显式非 coding 才抑制。 */
export function injectSuperpowersCoding(config: GoalConfig = DEFAULT_GOAL_CONFIG, goalTaskType?: string): boolean {
	// goalTaskType (per-goal) 优先于 config.forceTaskType (global trusted)
	const t = goalTaskType ?? config.forceTaskType;
	// backward-compat: undefined → 仍注入 coding (default behavior preserved)
	// 非 coding → 抑制 coding 门 (no competing instructions)
	return config.superpowersIntegration && (t === undefined || t === "coding");
}

/** Phase-1 task-routing清单 (design: task_workflow_routing_design.md). Pure
 *  prompt string builder, unit-testable. Injected alongside the superpowers
 *  block so the LLM self-judges the task type (no hard classifier — research
 *  strong-evidence: no mature system uses a task-type auto-classifier; Claude
 *  Code uses subagent description for LLM self-matching). On no-match, the LLM
 *  MUST generate a DAGSpec and call dag_execute (not free-form) — per user
 *  requirement. forceTaskType (trusted config) is the rollback path for
 *  misjudged types. */
export function taskRoutingBlock(config: GoalConfig = DEFAULT_GOAL_CONFIG): string {
	const overrideNote = config.forceTaskType
		? `\nTASK-TYPE OVERRIDE: user explicitly set forceTaskType="${config.forceTaskType}" — use the ${config.forceTaskType} workflow, do NOT auto-judge the task type.\n`
		: "";
	return (
		"<TASK-ROUTING>\n" +
		"Judge the task type from the goal objective, then route to the matching workflow.\n" +
		"This清单 is fallback guidance — you (the LLM) judge, no hard classifier.\n\n" +
		overrideNote +
		"| task 特征 | workflow | role | 触发词 |\n" +
		"|---|---|---|---|\n" +
		"| 写代码/改代码/修 bug/重构 | superpowers (coding) | coder | 实现/修复/重构/测试 |\n" +
		"| 调研/对比/现状/可行性 | research (5-Phase) | researcher | 调研/了解/对比/现状 |\n" +
		"| 产品方向/机会/规划/PRD | pm-discovery (PM SOP) | pm | 机会/规划/方向/PRD |\n" +
		"| 审查/审计/评估 | review | reviewer | 审查/审计/评估 |\n" +
		"| 无匹配 | 现场生成 (MUST, 不纯自由发挥) | 按需 spawn | — |\n\n" +
		"多匹配 tiebreak: 编排型 role (PM/reviewer) > 执行型 role (researcher/coder)。\n" +
		"例: \"调研 X 痛点并识别产品机会\" 同时匹配 research(调研)+PM(机会) → PM 胜出, PM 在 workflow 内 spawn researcher 做调研。\n" +
		"理由: 编排型 role 能调度执行型 role, 反之不能。\n\n" +
		"无匹配时 (MUST): 生成 DAGSpec (多 role 协作探索) → 调 dag_execute (inline spec, 不落盘) → 各 node spawn role 跑 per-role workflow。\n" +
		"跑通后可建议固化为新 preset (Phase 2, 可选)。\n\n" +
		"重要: superpowers (brainstorm→plan→TDD→review) 是 coding 专用流程。\n" +
		"非 coding 任务 (research/pm/review) 不要套 superpowers 的 coding 门 (如强制 TDD) — 按对应 workflow 走。\n" +
		"</TASK-ROUTING>\n"
	);
}

// ═══════════════════════════════════════════════════════════════════════
// 深修 C: per-task-type governance 分流
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §四
// 非 coding 任务不套 coding 门 (superpowers 阶段门),各有自己的 governance 块。
// 由 goalSystemPrompt / continuationPrompt 注入,替代硬编码的 GOAL_GOVERNANCE。
// undefined → coding governance (backward-compat)。
// ═════════════════════════════════════════════════════════════════════

/** Per-task-type governance block. Pure + unit-testable.
 *  - coding/undefined → superpowers 阶段门 (existing GOAL_GOVERNANCE content)
 *  - research → 计划→采集→交叉验证→综合→reviewer 验引用 + 质量门清单
 *  - pm → 盘点→痛点→机会→优先级→reviewer 验论证
 *  - review → 审计清单 + reviewer 复核
 *  Returns the governance text injected into goalSystemPrompt/continuationPrompt. */
export function taskGovernanceBlock(goalTaskType?: string): string {
	switch (goalTaskType) {
		case "research":
			return RESEARCH_GOVERNANCE;
		case "pm":
			return PM_GOVERNANCE;
		case "review":
			return REVIEW_GOVERNANCE;
		default: // coding / undefined → backward-compat
			return CODING_GOVERNANCE;
	}
}

/** 深修 B: orchestrated 模式编排者身份约束 (prompt 层,不做工具 deny)。
 *  executionMode=orchestrated 时注入 continuationPrompt,明确:
 *  - main agent 是编排者,执行工作必须 spawn role
 *  - 直接调 web_search/write/edit 执行实质工作 = 违约(可被 reviewer 检测)
 *  - 违约检测靠 reviewer 事后审查 + judge turn 级评估,不靠工具 deny
 *  主张: 执行权与验收权正交 — 简单任务(single)可直执,但验收必须独立。
 *  Returns empty string for single/undefined (no constraint, backward-compat). */
export function orchestratorConstraintBlock(executionMode?: string): string {
	if (executionMode !== "orchestrated") return "";
	return "\n\n## Orchestrated 模式约束 (executionMode=orchestrated)\n" +
		"你是编排者。执行工作必须 spawn role (researcher/coder/pm/reviewer)。\n" +
		"直接调 web_search/write/edit 执行实质工作 = 违约 (可被 reviewer 检测)。\n" +
		"违约检测靠 reviewer 事后审查 + judge turn 级评估 — 不硬 deny 工具 (执行权与验收权正交)。\n" +
		"例外: 读文件/跑测试等编排辅助操作可直接调 (非实质执行工作)。\n";
}

// Governance block texts (kept as module-level consts for testability + clarity)
const CODING_GOVERNANCE =
	"\n\n## Goal 模式规则\n" +
	"当有活跃 goal 时，处理每条新消息前必须：\n" +
	"1. 判断正处于 superpowers 的哪个阶段（需求→探索→计划→实施→TDD→审查→完成）\n" +
	"2. 加载该阶段的对应技能到上下文（即使你觉得\"已经知道了\"）\n" +
	"3. 对照技能里的 Red Flags 表格自检：是否正在跳过某个 HARD-GATE？\n" +
	"4. 如果上一轮跳过了某个阶段（如没做 TDD 就写了实现），暂停并修复缺口\n\n" +
	"违反此规则的典型反模式（出现即回退）：\n" +
	"- \"这个项目太小，不需要完整流程\"\n" +
	"- \"计划里代码都写好了，直接编辑更快\"\n" +
	"- \"先写代码再补测试也没关系\"\n" +
	"- \"我刚才看过那个技能了，不用再看\"\n\n" +
	"## Superpowers 模式规则\n" +
	"处理任何非琐碎任务（多文件修改、新功能、重构、bug 修复）时：\n" +
	"1. 判断任务处于 superpowers 的哪个阶段\n" +
	"2. 加载对应技能到上下文，遵循其 HARD-GATE 约束\n" +
	"3. 未获审批（用户或 reviewer）前不得跨阶段\n" +
	"4. 禁止的反模式：跳过设计直接写代码、先实现后补测试、跳过审查\n";

const RESEARCH_GOVERNANCE =
	"\n\n## Research 模式规则 (taskType=research)\n" +
	"调研类任务不套 superpowers coding 门（无 TDD/HARD-GATE），按 research workflow 走：\n" +
	"1. 计划：列出 ≥3 个独立研究角度（多角度并发，单 agent 串行 = 偷懒信号）\n" +
	"2. 采集：每条数据标注来源（URL/文件路径）+ 置信度（高/中/低/猜测）\n" +
	"3. 交叉验证：关键数据用 ≥2 个独立来源佐证，二手编译数据追源头\n" +
	"4. 综合：诚实标注数据/推理/假设的边界\n" +
	"5. reviewer 验引用：完成前 spawn 独立 reviewer 审引用可溯率 + 判断可信度（reviewer ≠ 产出者）\n\n" +
	"质量门（reviewer 检查清单）：引用可溯率（URL/路径占比）、来源多样性（域名/机构数）、置信度标注完整性、是否循环论证。\n" +
	"禁止的反模式：自评自己写的报告（循环论证）、单源断言、拍脑袋置信度。\n";

const PM_GOVERNANCE =
	"\n\n## PM 模式规则 (taskType=pm)\n" +
	"产品方向类任务不套 superpowers coding 门，按 PM Discovery SOP 走：\n" +
	"1. 盘点：领域现状 + 竞品格局\n" +
	"2. 痛点：用数据说话（来源+置信度），区分 AI 能解 vs 流程/治理问题\n" +
	"3. 机会：3-5 个，每个含技术可行性/业界现状/差异化/风险\n" +
	"4. 优先级：用户价值×可行性×差异化，MVP 边界（做/不做）+ 成功指标（领域特化）\n" +
	"5. reviewer 验论证：完成前 spawn 独立 reviewer 审机会是否有据、优先级是否合理、假设是否标注\n\n" +
	"禁止的反模式：纯口号式建议（如\"用 AI 做合同管理\"）、无数据支撑的判断、自评自审。\n";

const REVIEW_GOVERNANCE =
	"\n\n## Review 模式规则 (taskType=review)\n" +
	"审查/审计类任务不套 superpowers coding 门，按 review workflow 走：\n" +
	"1. 审计清单：按正确性/安全/可维护/迁移风险维度逐项查\n" +
	"2. 证据：每条发现附文件行号/源码/测试输出\n" +
	"3. 分级：critical/major/minor/nit，给修改建议\n" +
	"4. reviewer 复核：完成前 spawn 独立 reviewer 复核审计覆盖度 + 分级合理性（reviewer ≠ 产出者）\n\n" +
	"禁止的反模式：只夸不批、无证据的主观判断、跳过分级。\n";

// ═══════════════════════════════════════════════════════════════════════
// 深修 D: 独立 reviewer gate (非 coding goal 完成前强制 spawn reviewer)
// Design: docs/superpowers/specs/2026-07-02-non-coding-goal-design.md §三
// Root cause: SESSION_HANDOFF §八 根因2+4 — main agent 自审自评 = 循环论证。
// 业界调研发现:四框架(CrewAI/LangGraph/AutoGen/MetaGPT)均无"reviewer≠producer"
// 硬约束,pi-goal 深修 D 是差异化增量。
// 主张:执行权与验收权正交 — 简单任务用 goal 仍可直执(single),
// 但验收必须独立(reviewer ≠ producer),根除自审自评。
// Backward-compat: undefined taskType 和 "coding" 无 reviewer gate(行为不变)。
// ═════════════════════════════════════════════════════════════════════

/** A goal slice sufficient for the complete-gate decision. Decoupled from
 *  the full GoalState (index.ts) so this is a pure, unit-testable function
 *  with no pi-runtime types. Fields mirror the GoalState additions for 深修 D. */
export interface CompletableGoal {
	/** Per-goal task type declared at propose_goal_draft time (深修 A).
	 *  undefined = legacy goal (backward-compat: treated as coding, no gate). */
	taskType?: "coding" | "research" | "pm" | "review";
	/** True only after an independent reviewer (subagent ≠ producer) has
	 *  APPROVED. Non-coding goals require this to complete. */
	reviewerPassed?: boolean;
	/** Criteria with their collected evidence (existing field). */
	criteria: { evidence: string[] }[];
}

/** Gate checked before a goal may transition to "complete". Pure + unit-
 *  testable. Called by both complete paths:
 *    1. update_goal({status:"complete"}) — index.ts update_goal handler
 *    2. judge verdict.done — index.ts runJudge path
 *  Both must pass this gate, so the logic lives here once (DRY).
 *
 *  Order of checks (cheap deterministic first):
 *    1. All criteria have evidence (existing behavior, preserved)
 *    2. Non-coding taskType requires reviewerPassed=true (深修 D)
 *
 *  Backward-compat: taskType undefined or "coding" → no reviewer gate.
 *  Legacy goals behave exactly as before. */
export function canComplete(goal: CompletableGoal): { ok: boolean; reason?: string } {
	// 1. Evidence gate (existing behavior — preserved verbatim)
	const uncovered = goal.criteria.filter((c) => c.evidence.length === 0);
	if (uncovered.length > 0) {
		return { ok: false, reason: uncovered.length + " criteria lack evidence" };
	}
	// 2. 深修 D: reviewer gate for non-coding goals
	//    undefined / "coding" → no gate (backward-compat).
	if (goal.taskType && goal.taskType !== "coding" && !goal.reviewerPassed) {
		return {
			ok: false,
			reason: "Non-coding goal (taskType=" + goal.taskType + ") requires independent reviewer APPROVE before complete. Spawn a reviewer (reviewer ≠ producer) and have it submit its verdict, then the gate opens. Root cause addressed: prevent main-agent self-review (循环论证).",
		};
	}
	return { ok: true };
}

/** A goal slice sufficient for the get_goal text serializer. Decoupled from the
 *  full GoalState (index.ts) so serializeGoalText is a pure, unit-testable
 *  function with no pi-runtime types. Fields mirror the GoalState shape.
 *  taskType/reviewerPassed/executionMode are optional (深修 D/A); undefined →
 *  JSON.stringify omits the key, keeping legacy coding-goal output clean. */
export interface SerializableGoal {
	objective: string;
	status: string;
	criteria: { id: string; description: string; evidence: string[] }[];
	constraints: string[];
	tokensUsed: number;
	tokenBudget: number | null;
	timeUsedMs: number;
	autoTurnCount: number;
	/** Per-goal task type (深修 A). undefined = legacy coding goal. */
	taskType?: "coding" | "research" | "pm" | "review";
	/** True after independent reviewer APPROVE (深修 D). undefined = not applicable
	 *  (coding goal, no gate); false = research goal under review, not yet approved. */
	reviewerPassed?: boolean;
	/** Execution mode (深修 A). single (default) = main agent 直执; orchestrated = spawn role. */
	executionMode?: "single" | "orchestrated";
}

/** Serializes a goal to the text payload returned by the get_goal tool.
 *  Pure + unit-testable. Extracted from an inline hand-written field whitelist
 *  in index.ts's get_goal handler that silently dropped taskType/reviewerPassed/
 *  executionMode (the 深修 D/A fields) — the bug surfaced during 深修 D live
 *  verification (goal-d-live-verification.md): get_goal text omitted taskType
 *  even though state held it. `details: { goal }` carried the full state so the
 *  canComplete gate still worked (it reads state, not text), but the user-facing
 *  text lied. Centralizing here makes the field list testable against the real
 *  implementation, not a spec-mirror (circular).
 *
 *  Key naming: snake_case to match the existing get_goal text contract
 *  (tokens_used/time_used_seconds/auto_turns). undefined optional fields are
 *  omitted by JSON.stringify (not emitted as null), so legacy coding goals keep
 *  a noise-free output. */
export function serializeGoalText(goal: SerializableGoal): string {
	return JSON.stringify({
		objective: goal.objective, status: goal.status,
		criteria: goal.criteria.map((c) => ({ id: c.id, description: c.description, done: c.evidence.length > 0, evidence: c.evidence })),
		constraints: goal.constraints, tokens_used: goal.tokensUsed, token_budget: goal.tokenBudget,
		remaining_tokens: goal.tokenBudget !== null ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : null,
		time_used_seconds: Math.floor(goal.timeUsedMs / 1000), auto_turns: goal.autoTurnCount,
		task_type: goal.taskType,
		reviewer_passed: goal.reviewerPassed,
		execution_mode: goal.executionMode,
	}, null, 2);
}

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
			verifyTimeoutMs: typeof raw.verifyTimeoutMs === "number" ? raw.verifyTimeoutMs : undefined,
			forceTaskType: typeof raw.forceTaskType === "string" ? raw.forceTaskType : undefined,
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
