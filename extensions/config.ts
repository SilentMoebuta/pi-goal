import * as fs from "node:fs";
import * as path from "node:path";
import { checkCitationTraceability, checkSourceDiversity, checkConfidenceAnnotation } from "./quality-gates";

export type TaskKind = "general" | "coding" | "research" | "pm" | "review";
export type ExecutionPreference = "auto" | "direct" | "specialist" | "team";
export type ReviewPolicy = "risk_based" | "always" | "never";
export type CompletionPolicy = "legacy" | "shadow" | "v2";

export interface GoalConfig {
	/** Config schema. Omitted means the legacy flat schema. */
	schemaVersion?: 2;

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

	/** V2 name for judgeModel. When both are present evaluatorModel wins. */
	evaluatorModel?: string;

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

	/** Independent assurance is selected by risk, unless explicitly overridden. */
	reviewPolicy?: ReviewPolicy;

	/** Topology preference for newly drafted goals. */
	defaultExecution?: ExecutionPreference;

	/** Controls whether the legacy or V2 evaluator may change goal state. */
	completionPolicy?: CompletionPolicy;

	/** 目录（相对 cwd 或绝对），goal 启动时把完整 spec 写成 md 供用户微调。 */
	goalSpecDir?: string;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
	schemaVersion: 2,
	superpowersIntegration: true,
	judgeModel: undefined,
	evaluatorModel: undefined,
	verifyCommand: undefined,
	stuckEscalateModel: undefined,
	verifyTimeoutMs: undefined,
	forceTaskType: undefined,
	reviewPolicy: "risk_based",
	defaultExecution: "auto",
	completionPolicy: "v2",
	/** 目录（相对 cwd 或绝对），goal 启动时把完整 spec 写成 md 供用户微调。 */
	goalSpecDir: "docs/goals",
};

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
		"Classify the task, then choose the least expensive topology that is sufficient.\n" +
		"Execution topology and completion assurance are separate decisions. Risk alone never requires a team.\n\n" +
		overrideNote +
		"direct: one clear workstream that the main agent can complete.\n" +
		"specialist: one dominant specialist capability or a low-confidence probe; use one registered foreground role.\n" +
		"team: at least two genuinely independent workstreams or useful separation of duties.\n" +
		"Use dag_execute only when real dependencies, parallel work, branching, or responsibility isolation justify a graph.\n" +
		"If a specialist role is unavailable, fall back to direct and reassess on scope expansion.\n" +
		"A new independent workstream may upgrade the route; convergence to one path may downgrade it unless the user locked a preference.\n\n" +
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
 *  G7 (single 自批禁): single 模式可保留,但 singleRationale 须交 reviewer 预审+终审,
 *  不得自给理由自过 — 在 single+非 coding 时也注入提示 (不再空串).
 *  Returns empty string for coding/undefined (no constraint, backward-compat). */
export function orchestratorConstraintBlock(executionMode?: string, taskType?: string, singleRationale?: string, singleRationaleStatus?: string): string {
	const nonCoding = taskType && taskType !== "coding";
	if (!nonCoding) return ""; // coding/undefined: 无约束 (backward-compat)
	if (executionMode === "orchestrated") {
		return "\n\n## Orchestrated 模式约束 (executionMode=orchestrated)\n" +
			"你是编排者。执行工作必须 spawn role (researcher/coder/pm/reviewer)。\n" +
			"直接调 web_search/write/edit 执行实质工作 = 违约 (可被 reviewer 检测)。\n" +
			"违约检测靠 reviewer 事后审查 + judge turn 级评估 — 不硬 deny 工具 (执行权与验收权正交)。\n" +
			"例外: 读文件/跑测试等编排辅助操作可直接调 (非实质执行工作)。\n";
	}
	// G7: single 模式提示 — 须执行前预审 singleRationale, 不得自批.
	const status = singleRationaleStatus ?? "pending";
	if (status === "approved") {
		return "\n\n## Single 模式约束 (executionMode=single, taskType=" + taskType + ", 预审已通过)\n" +
			"singleRationale 已预审通过: " + (singleRationale ? "" + singleRationale : "(未提供)") + "\n" +
			"你可开始实质执行 (main agent 直执)。但终局 complete 仍须 spawn reviewer 验收, reviewer 会再次确认 singleRationaleApproved — 不得自给理由自过。\n" +
			"若执行中发现该任务不该 single (复杂度超预期/需多角度), 降级: update_goal({ executionMode: \"orchestrated\" })。\n";
	}
	if (status === "rejected") {
		return "\n\n## Single 模式约束 (executionMode=single, taskType=" + taskType + ", 预审被拒)\n" +
			"⚠️ singleRationale 预审被 reviewer 拒绝 — 该任务不该 single, 不得开始实质执行。\n" +
			"必须降级: 调 update_goal({ executionMode: \"orchestrated\" }) 改用 spawn role 编排重做。\n" +
			"降级后 singleRationaleStatus/singleRationale 自动清空, 转入 orchestrated 约束。\n";
	}
	// pending (默认)
	return "\n\n## Single 模式约束 (executionMode=single, taskType=" + taskType + ", 待预审)\n" +
		"你选择 single 模式 (main agent 直执)。理由已声明: " + (singleRationale ? "" + singleRationale : "(未提供)") + "\n" +
		"⚠️ 该理由须先 spawn reviewer 预审 — 预审通过前不得开始实质执行 (防自己做完后才发现不该 single, 浪费 work)。\n" +
		"预审流程: spawn reviewer 审 singleRationale → reviewer 返回 singleRationaleApproved → 调 update_goal({ singleRationalePreApproved: true, singleRationaleReviewer: {model, thinkingLevel} }) 写入。\n" +
			"false → status=rejected, 须降级 orchestrated。\n" +
		"不得自给理由自过 (handoff §八: 不能自己给理由自己过)。\n";
}

export function executionDecisionBlock(execution: {
	selected: "direct" | "specialist" | "team";
	role?: string;
	source: "auto" | "user" | "legacy";
	reasons: string[];
}): string {
	const reason = execution.reasons.length > 0 ? execution.reasons.join("; ") : "No route rationale recorded.";
	if (execution.selected === "direct") {
		return "\n\n## Execution route: direct\nWork in the main session. Reassess if scope expands, a new independent workstream appears, evidence conflicts, or progress stalls.\nReason: " + reason + "\n";
	}
	if (execution.selected === "specialist") {
		return "\n\n## Execution route: specialist\nUse one foreground spawn_role" + (execution.role ? " with registered role `" + execution.role + "`" : " after selecting a registered role") + ". Do not silently use an unknown/default full-tool role.\nReason: " + reason + "\n";
	}
	return "\n\n## Execution route: team\nUse dag_execute only for real dependencies, parallel work, conditional branches, or responsibility isolation. Nodes must name independent outputs and consumers; avoid setup-only and text-stitching nodes.\nReason: " + reason + "\n";
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

/** 教训14 (§十三 v2 abort→v3 聚焦): reviewer roleDef prompt 聚焦规范避 doom-loop.
 *  v2 (含 curl/dig URL probing + ls/find 目录探索) 触发 doom-loop detector 误报 abort;
 *  v3 (聚焦: read 指定段 + grep + report_role_result, 无探索) completed 干净. 注入三块非 coding governance. */
const REVIEWER_ROLEDEF_HINT =
	"\n   ⚠️ reviewer roleDef 聚焦规范 (教训14, 避 doom-loop): 明确限定工具调用序列 (如 read 指定段 + grep + report_role_result), 禁探索性调用 (curl/dig URL probing / ls/find 目录探索会触发 doom-loop detector 误报 abort), maxTurns 适中 (15-30; 复杂审计≥25). report_role_result.findings[0] 必须精确写 `✅ Ready` 或 `❌ Not ready`; 每条阻塞发现还必须在后续 finding 中写出 code、criterion/claim/constraint subjectId，以及 evidenceRefs 或 missingEvidenceKind，供 Goal V2 绑定审计。";

const RESEARCH_GOVERNANCE =
	"\n\n## Research 模式规则 (taskType=research)\n" +
	"调研类任务不套 superpowers coding 门（无 TDD）。先识别会影响结论的 material claims，再为每条 claim 记录可定位证据。\n" +
	"普通 claim 可由一个权威 primary source 支持；只有 high-risk、争议、冲突 claim 才要求不同 independenceKey 的独立佐证。\n" +
	"supporting claim 的证据缺口只产生 advisory，不得阻塞完成。URL 数、引用率和来源数仅是 diagnostics，禁止为凑数量补低质量来源。\n" +
	"综合时明确区分事实、推断和未知项。只有风险策略触发或用户明确要求时才 spawn 独立 reviewer。\n" +
	"禁止的反模式：用来源数量代替证据质量、忽略冲突证据、把 advisory 当完成门禁。\n" + REVIEWER_ROLEDEF_HINT;

const PM_GOVERNANCE =
	"\n\n## PM 模式规则 (taskType=pm)\n" +
	"产品方向类任务不套 superpowers coding 门，按 PM Discovery SOP 走：\n" +
	"1. 盘点：领域现状 + 竞品格局\n" +
	"2. 痛点：用数据说话（来源+置信度），区分 AI 能解 vs 流程/治理问题\n" +
	"3. 机会：3-5 个，每个含技术可行性/业界现状/差异化/风险\n" +
	"4. 优先级：用户价值×可行性×差异化，MVP 边界（做/不做）+ 成功指标（领域特化）\n" +
	"5. assurance：风险策略触发时由独立 reviewer 审机会是否有据、优先级是否合理、假设是否标注\n\n" +
	"禁止的反模式：纯口号式建议（如\"用 AI 做合同管理\"）、无数据支撑的判断、自评自审。\n" + REVIEWER_ROLEDEF_HINT;

const REVIEW_GOVERNANCE =
	"\n\n## Review 模式规则 (taskType=review)\n" +
	"审查/审计类任务不套 superpowers coding 门，按 review workflow 走：\n" +
	"1. 审计清单：按正确性/安全/可维护/迁移风险维度逐项查\n" +
	"2. 证据：每条发现附文件行号/源码/测试输出\n" +
	"3. 分级：critical/major/minor/nit，给修改建议\n" +
	"4. assurance：风险策略触发或用户要求时由独立 reviewer 复核覆盖度与分级\n\n" +
	"禁止的反模式：只夸不批、无证据的主观判断、跳过分级。\n" + REVIEWER_ROLEDEF_HINT;

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
	/** Legacy reviewer result. V2 consults it only when assurance selected required review. */
	reviewerPassed?: boolean;
	/** V2 assurance decision. Reviewer is a gate only when this is true. */
	reviewRequired?: boolean;
	/** 第2条: 结构化验收凭证, 替代裸布尔. 非 coding goal reviewerPassed=true 时
	 *  必须携带, canComplete 验契约满足. undefined = 未提供 (非 coding 拒, coding 忽略). */
	reviewerVerdict?: ReviewerVerdict;
	/** G7 (single 自批禁): single 模式的理由, 起草时声明, 交 reviewer 审核. */
	singleRationale?: string;
	/** 深修 A: execution mode. single = main agent 直执 (须 singleRationale); orchestrated = spawn role. */
	executionMode?: "single" | "orchestrated";
	/** G7 (执行前预审): single+非coding goal 的 singleRationale 预审进度.
	 *  pending = 刚创建未预审 (不得开始实质执行);
	 *  approved = 预审通过可执行 (终局仍须 reviewer 验收);
	 *  rejected = 预审拒绝 (须降级 orchestrated, update_goal 改 executionMode).
	 *  undefined = coding/legacy/orchestrated (无预审流程, backward-compat). */
	singleRationaleStatus?: "pending" | "approved" | "rejected";
	/** Criteria with their collected evidence (existing field). */
	criteria: { evidence: string[] }[];
}

/** Legacy report diagnostics. These metrics remain visible for audit but never
 * reject a non-empty report. Empty content is still a real blocking failure. */
export const QUALITY_GATE_THRESHOLDS = { citationTraceability: 0.3, sourceDiversity: 3 } as const;

// G4 (CLM 二次 live 测试复盘): citation-traceability bar graded by taskType.
// research reports are data-dense (high citation bar); pm reports are analysis-dense
// (PRD/roadmap/优先级 legitimately cite fewer external sources) — a single 0.3 bar
// mis-scores analysis-heavy work and traps it below the gate (the CLM failure mode).
// review keeps 0.3 (review work should cite what it checks against). undefined/legacy
// falls back to QUALITY_GATE_THRESHOLDS.citationTraceability (0.3) for backward-compat.
export const CITATION_TRACEABILITY_BY_TASK_TYPE: Record<string, number> = {
	research: 0.3,
	pm: 0.2,
	review: 0.3,
};

export interface QualityGateMetrics {
	citationTraceability: number;
	sourceDiversity: number;
	confidenceAnnotated: boolean;
}

export function verifyQualityGates(reportText: string, taskType?: string): { ok: boolean; blocking?: boolean; reason?: string; metrics?: QualityGateMetrics } {
	if (!reportText || reportText.trim().length === 0) return { ok: false, blocking: true, reason: "Report text is empty — nothing to verify." };
	const citationTraceability = checkCitationTraceability(reportText);
	const sourceDiversity = checkSourceDiversity(reportText);
	const confidenceAnnotated = checkConfidenceAnnotation(reportText);
	const metrics: QualityGateMetrics = { citationTraceability, sourceDiversity, confidenceAnnotated };
	const citationBar = taskType ? (CITATION_TRACEABILITY_BY_TASK_TYPE[taskType] ?? QUALITY_GATE_THRESHOLDS.citationTraceability) : QUALITY_GATE_THRESHOLDS.citationTraceability;
	if (citationTraceability < citationBar) {
		return { ok: false, blocking: false, reason: "Citation traceability " + citationTraceability.toFixed(2) + " < threshold " + citationBar + " (taskType=" + (taskType ?? "undefined") + ") — diagnostic warning only; reviewer must judge whether sources actually support the work.", metrics };
	}
	if (sourceDiversity < QUALITY_GATE_THRESHOLDS.sourceDiversity) {
		return { ok: false, blocking: false, reason: "Source diversity " + sourceDiversity + " < threshold " + QUALITY_GATE_THRESHOLDS.sourceDiversity + " — diagnostic warning only; reviewer must judge whether the source set is sufficient for this task.", metrics };
	}
	if (!confidenceAnnotated) {
		return { ok: false, blocking: false, reason: "No confidence/evidence annotation found — diagnostic warning only; reviewer must judge whether uncertainty is honestly labeled.", metrics };
	}
	return { ok: true, blocking: false, metrics };
}

/** Legacy structured reviewer audit. Model, thinking level, source count, and
 * report checks are diagnostics rather than completion quotas. Authenticity
 * comes from the spawned-session transcript. */
export interface ReviewerVerdict {
	/** Diagnostic reviewer model. */
	model?: string;
	/** Diagnostic thinking level. */
	thinkingLevel?: string;
	/** Diagnostic count of sources inspected. */
	verifiedSources?: number;
	/** Legacy report-diagnostic result. */
	checksPassed?: boolean;
	/** 报告产物路径, update_goal handler 读它重跑 quality-gates 验 checksPassed 真伪. */
	reportPath?: string;
	/** reviewer 主观判断 (判断可信度/循环论证等不可机器验项). */
	notes?: string;
	/** G7 (single 自批禁): single 模式时 reviewer 须独立审核 singleRationale 是否成立.
	 *  true = reviewer 认可该任务确可由 main agent 单独完成 (理由充分且非自批).
	 *  缺失/false = reviewer 认为该任务不该 single (须 spawn), canComplete 拒. */
	singleRationaleApproved?: boolean;
}

/** 第2条: validate reviewer verdict 契约. Pure + unit-testable. Returns {ok, reason?}.
 *  Empty/undefined verdict → ok=false (caller 区分 "未传" vs "传了但不达标"). */
export function validateReviewerVerdict(v: ReviewerVerdict): { ok: boolean; reason?: string } {
	if (!v || typeof v !== "object") return { ok: false, reason: "Reviewer verdict must be an object." };
	if (v.verifiedSources !== undefined && (!Number.isFinite(v.verifiedSources) || v.verifiedSources < 0)) {
		return { ok: false, reason: "Reviewer verifiedSources is diagnostic and must be a non-negative number when supplied." };
	}
	return { ok: true };
}

/** G7 (single 自批禁): single 模式的 singleRationale 须由独立 reviewer 审核, 不得自批.
 *  返回 {ok} 表示 verdict 契约满足且 (若 goal 是 single 模式) rationale 已被 reviewer 认可.
 *  呼叫方先调 validateReviewerVerdict 验契约, 再调此函数验 singleRationaleApproved. */
export function validateSingleRationaleApproved(goal: CompletableGoal, verdict: ReviewerVerdict): { ok: boolean; reason?: string } {
	if (goal.taskType && goal.taskType !== "coding" && goal.executionMode === "single") {
		if (!verdict.singleRationaleApproved) {
			return {
				ok: false,
				reason: "single executionMode requires the independent reviewer to approve singleRationaleApproved=true (the reviewer must independently judge the singleRationale is sound — not self-approved). Got false/missing. Root cause (handoff §八): 不能自己给理由自己过.",
			};
		}
	}
	return { ok: true };
}

/** G7 预审契约 (执行前预审, A): 预审 reviewer 只审 singleRationale 合理性, 无产物可验源/跑 gate.
 *  Compatibility contract: only the actual decision is structural. Model and
 *  thinking level remain diagnostics and never decide whether review counts.
 *  不要求 verifiedSources/checksPassed (预审阶段无 sources/产物 — 与终审 validateReviewerVerdict 区别). */
export function validateSingleRationalePreApproval(r: { model?: string; thinkingLevel?: string; singleRationaleApproved?: boolean }): { ok: boolean; reason?: string } {
	if (typeof r.singleRationaleApproved !== "boolean") return { ok: false, reason: "singleRationaleReviewer.singleRationaleApproved must be a boolean (reviewer's verdict on whether the task can be single)." };
	return { ok: true };
}

/** Extract the reviewer's accepted report_role_result from its child-session transcript.
 *  New pi-roles sessions carry spawn provenance and a matching accepted tool result;
 *  schema-mismatched/rejected calls are ignored. Old transcripts without provenance
 *  retain the call-only fallback for one compatibility cycle.
 *
 *  Cross-extension reality: pi-goal cannot read pi-roles' in-memory ReportState, so
 *  the runtime-persisted sessionFile is the available audit bridge. Pure + unit-testable
 *  (no fs); the handler does the file read and calls this. Returns {found, findings?}:
 *  found=true means an accepted report was bound, or the legacy fallback parsed one. */
export interface ReviewerTranscriptEvidence {
	found: boolean;
	findings?: unknown;
	spawnedSession: boolean;
	parentSession?: string;
	sessionId?: string;
	provenance?: {
		schemaVersion: 1;
		agentId: string;
		role: string;
		sessionId: string;
		parentSession: string | null;
	};
}

export interface ReviewerSourceExpectation {
	parentSession: string;
	role: "reviewer";
	sessionId?: string;
}

/** Registered report reviewers are specialized reviewer roles. They retain
 * the same provenance contract as the generic reviewer role. */
function reviewerRoleMatches(actual: string, expected: ReviewerSourceExpectation["role"]): boolean {
	return actual === expected || (expected === "reviewer" && actual === "report-reviewer");
}

export function extractReviewerFindings(jsonlText: string): ReviewerTranscriptEvidence {
	if (!jsonlText || jsonlText.trim().length === 0) return { found: false, spawnedSession: false };
	const lines = jsonlText.split("\n");
	const reportCalls: Array<{ id?: string; findings: unknown }> = [];
	const acceptedCallIds = new Set<string>();
	let reportResultObserved = false;
	let parentSession: string | undefined;
	let sessionId: string | undefined;
	let provenance: ReviewerTranscriptEvidence["provenance"];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: any;
		try { parsed = JSON.parse(trimmed); } catch { continue; } // skip malformed lines
		if (parsed?.type === "session") {
			if (typeof parsed.parentSession === "string" && parsed.parentSession.trim()) parentSession = parsed.parentSession.trim();
			if (typeof parsed.id === "string" && parsed.id.trim()) sessionId = parsed.id.trim();
		}
		if (parsed?.type === "custom" && parsed.customType === "pi-roles:spawn-provenance") {
			const data = parsed.data;
			if (data?.schemaVersion === 1
				&& typeof data.agentId === "string" && data.agentId.trim()
				&& typeof data.role === "string" && data.role.trim()
				&& typeof data.sessionId === "string" && data.sessionId.trim()
				&& (data.parentSession === null || (typeof data.parentSession === "string" && data.parentSession.trim()))) {
				provenance = {
					schemaVersion: 1,
					agentId: data.agentId.trim(),
					role: data.role.trim(),
					sessionId: data.sessionId.trim(),
					parentSession: typeof data.parentSession === "string" ? data.parentSession.trim() : null,
				};
			}
		}
		const msg = parsed && typeof parsed === "object" ? parsed.message : undefined;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c && typeof c === "object" && c.type === "toolCall" && c.name === "report_role_result") {
					const args = c.arguments && typeof c.arguments === "object" ? c.arguments : {};
					const callId = c.id ?? c.toolCallId;
					reportCalls.push({
						...(typeof callId === "string" ? { id: callId } : {}),
						findings: args.findings,
					});
				}
			}
			continue;
		}
		if (msg?.role === "toolResult" && msg.toolName === "report_role_result") {
			reportResultObserved = true;
			const accepted = msg.isError !== true
				&& msg.details?.errorType === undefined
				&& Array.isArray(msg.content)
				&& msg.content.some((part: any) => part?.type === "text"
					&& typeof part.text === "string"
					&& part.text.includes("[pi-roles] report accepted"));
			if (accepted && typeof msg.toolCallId === "string") acceptedCallIds.add(msg.toolCallId);
		}
	}
	const selected = reportResultObserved
		? reportCalls.find((call) => call.id !== undefined && acceptedCallIds.has(call.id))
		: provenance ? undefined : reportCalls.at(-1);
	const found = selected !== undefined;
	return {
		found,
		...(found ? { findings: selected.findings } : {}),
		spawnedSession: Boolean(parentSession && sessionId),
		...(parentSession ? { parentSession } : {}),
		...(sessionId ? { sessionId } : {}),
		...(provenance ? { provenance } : {}),
	};
}

/** G3 helper: are the extracted findings non-empty? (array with items, or non-empty
 *  string). Pure. */
export function findingsAreNonEmpty(findings: unknown): boolean {
	if (Array.isArray(findings)) return findings.length > 0;
	if (typeof findings === "string") return findings.trim().length > 0;
	return false;
}

/** G3 helper: pure decision over whether a reviewer verdict is source-authentic, given
 *  the caller-supplied agentId/sessionFile and the findings extracted from the jsonl.
 *  Tested directly (no fs) — the handler does the file read + extractReviewerFindings,
 *  then calls this. Returns {ok, reason}. Closing 教训6: a verdict with no real reviewer
 *  session (no agentId/sessionFile, or no report_role_result, or empty findings) is
 *  rejected — main agent cannot fabricate a reviewer. */
export function verifyReviewerSource(
	agentId: string | undefined,
	sessionFile: string | undefined,
	extracted: ReviewerTranscriptEvidence,
	expected?: ReviewerSourceExpectation,
): { ok: boolean; reason?: string } {
	if (!agentId || !sessionFile) {
		return { ok: false, reason: "reviewerPassed=true for non-coding goal requires reviewerAgentId + reviewerSessionFile (G3: verdict source authenticity). The verdict must come from a real spawned reviewer session, not a self-constructed JSON. Re-spawn a reviewer and pass its agentId + sessionFile." };
	}
	if (!/^sub_\d+_\d+$/.test(agentId)) {
		return { ok: false, reason: "reviewerAgentId does not match a pi-roles spawned-session id." };
	}
	if (!extracted.spawnedSession || !extracted.parentSession || !extracted.sessionId) {
		return { ok: false, reason: "reviewerSessionFile is not a spawned child session: its session header must include id and parentSession." };
	}
	if (expected) {
		const provenance = extracted.provenance;
		if (!provenance) {
			return { ok: false, reason: "Reviewer session has no pi-roles spawn provenance; spawn a fresh registered reviewer with the current pi-roles extension." };
		}
		if (provenance.agentId !== agentId) {
			return { ok: false, reason: "Reviewer agentId does not match the trusted child-session provenance." };
		}
		if (!reviewerRoleMatches(provenance.role, expected.role)) {
			return { ok: false, reason: "The supplied child session was spawned as role '" + provenance.role + "', not reviewer or report-reviewer." };
		}
		if (provenance.sessionId !== extracted.sessionId || (expected.sessionId && expected.sessionId !== extracted.sessionId)) {
			return { ok: false, reason: "Reviewer sessionId does not match its header/provenance." };
		}
		if (extracted.parentSession !== expected.parentSession || provenance.parentSession !== expected.parentSession) {
			return { ok: false, reason: "Reviewer session is not a child of the current goal session." };
		}
	}
	if (!extracted.found) {
		return { ok: false, reason: extracted.provenance
			? "No accepted report_role_result found in reviewerSessionFile; schema-mismatched or rejected calls cannot authorize a review verdict. Re-spawn or let the reviewer retry successfully."
			: "No report_role_result found in reviewerSessionFile (G3: the referenced session did not actually report — verdict not sourced from a real reviewer). Re-spawn and ensure the reviewer calls report_role_result." };
	}
	if (!findingsAreNonEmpty(extracted.findings)) {
		return { ok: false, reason: "reviewerSessionFile contains report_role_result but findings are empty (G3: a rubber-stamp reviewer with no substantive report). Re-spawn a reviewer that reports substantive findings." };
	}
	return { ok: true };
}

/** 第1条 (CLM run 复盘): validate a goal proposal BEFORE setGoal. Pure + unit-
 *  testable. Root cause: executionMode 缺省=undefined=single, 非 coding 任务默认走
 *  single, orchestratorConstraintBlock 不触发, main agent 直执成默认——"把复杂任务
 *  判成简单"的结构性偏见 (handoff §八 根因1+3). Fix: 非 coding taskType 时
 *  executionMode 不可缺省, 必须显式选 single|orchestrated. coding/undefined 不变
 *  (backward-compat). 不硬 deny single — 执行权保留, 但逼 main agent 做这个判断.
 *  Returns {ok, reason?}. Empty input (legacy coding goal) → ok. */
export interface GoalProposalValidationInput {
	objective?: string;
	taskType?: string;
	executionMode?: string;
	executionPreference?: string;
	criteria?: Array<string | { description: string; level?: "blocking" | "advisory" }>;
	constraints?: string[];
	researchClaims?: Array<{ id: string; text?: string; evidenceRefs?: string[] }>;
	singleRationale?: string;
}

export function validateGoalProposal(input: GoalProposalValidationInput): { ok: boolean; reason?: string } {
	if (input.objective !== undefined && input.objective.trim().length === 0) {
		return { ok: false, reason: "Goal objective must not be empty or blank." };
	}
	if (input.criteria && input.criteria.length === 0) return { ok: false, reason: "At least one outcome criterion is required." };
	const criteria = input.criteria?.map((criterion) => typeof criterion === "string"
		? { description: criterion, level: "blocking" as const }
		: { description: criterion.description, level: criterion.level ?? "blocking" as const });
	if (criteria?.some((criterion) => criterion.description.trim().length === 0)) return { ok: false, reason: "Outcome criteria must not be blank." };
	if (criteria && !criteria.some((criterion) => criterion.level === "blocking")) {
		return { ok: false, reason: "At least one blocking outcome criterion is required; advisory criteria cannot define success by themselves." };
	}
	if (input.constraints !== undefined && input.constraints.length === 0) {
		return { ok: false, reason: "Omit constraints when there are none; a provided constraints array must not be empty." };
	}
	if (input.constraints?.some((constraint) => constraint.trim().length === 0)) {
		return { ok: false, reason: "Goal constraints must not contain empty or blank values." };
	}
	const claimIds = new Set<string>();
	for (const [index, claim] of (input.researchClaims ?? []).entries()) {
		const normalizedId = claim.id.trim();
		if (!normalizedId) return { ok: false, reason: `researchClaims[${index}].id must not be empty or blank.` };
		if (claim.text !== undefined && !claim.text.trim()) {
			return { ok: false, reason: `researchClaims[${index}].text must not be empty or blank.` };
		}
		if (claimIds.has(normalizedId)) {
			return { ok: false, reason: `researchClaims contains duplicate claim id: ${normalizedId || "<blank>"}.` };
		}
		claimIds.add(normalizedId);
		const evidenceRefs = claim.evidenceRefs ?? [];
		if (evidenceRefs.length > 0) {
			const refs = evidenceRefs.map((ref) => ref.trim() || "<blank>");
			return {
				ok: false,
				reason: `researchClaims[${index}].evidenceRefs references unknown draft evidence: ${refs.join(", ")}. The draft evidence ledger is empty; record evidence after the goal starts.`,
			};
		}
	}
	if (input.executionMode && input.executionPreference) {
		return { ok: false, reason: "Use executionPreference or legacy executionMode, not both." };
	}
	return { ok: true };
}

/** Draft criteria that assert a repository/environment state instead of a task
 *  outcome (UX finding: the draft writer repeatedly generated "git status
 *  --porcelain must be empty" / "tracked changes must be zero" gates, which are
 *  unsatisfiable on a dirty worktree and unrelated to the real objective,
 *  causing REVISE loops). Such gates are downgraded to advisory: they keep
 *  their text (visible in the review UI) but can no longer block completion.
 *  When the objective itself is about the environment state (e.g. "clean up
 *  the worktree"), the gate is kept blocking. Pure and unit-testable. */
export interface DraftCriterionInput {
	description: string;
	level: "blocking" | "advisory";
}

const ENV_STATE_GATE_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\bgit\s+status\b/i, label: "git status" },
	{ re: /\bporcelain\b/i, label: "porcelain" },
	{ re: /\b(working\s*tree|worktree)\b/i, label: "worktree" },
	{ re: /\btracked\s+changes\b/i, label: "tracked changes" },
	{ re: /\b(untracked|modified|uncommitted)\s+(files?|changes?)?\b/i, label: "files state" },
	{ re: /\b(repo|repository)\b/i, label: "repository" },
	{ re: /(仓库|工作区|工作树|git 状态|git\s*状态)/i, label: "repo (zh)" },
];

const ENV_STATE_GATE_STATE_WORDS = /(clean|empty|dirty|zero|none|no\s+(modified|untracked|uncommitted|changes|new\s+files)|must\s+not|干净|为空|无修改|没有修改|无改动|没有改动|无未提交|没有未提交|脏)/i;

function matchesEnvironmentStateGate(description: string): boolean {
	const env = ENV_STATE_GATE_PATTERNS.some(({ re }) => re.test(description));
	if (!env) return false;
	return ENV_STATE_GATE_STATE_WORDS.test(description);
}

export function downgradeEnvironmentStateGates(
	criteria: readonly DraftCriterionInput[],
	objective: string,
): { criteria: DraftCriterionInput[]; downgraded: string[] } {
	const objectiveIsEnvState = matchesEnvironmentStateGate(objective);
	const downgraded: string[] = [];
	const result = criteria.map((criterion) => {
		const isEnvGate = criterion.level === "blocking"
			&& matchesEnvironmentStateGate(criterion.description)
			&& !objectiveIsEnvState;
		if (!isEnvGate) return criterion;
		downgraded.push(criterion.description);
		return { ...criterion, level: "advisory" as const };
	});
	return { criteria: result, downgraded };
}

/** Assess a newly submitted evidence string against a criterion's existing
 *  evidence entries. Returns whether the new evidence is a near-duplicate of
 *  an existing one (caller should skip recording) and/or a contradiction
 *  warning string (caller records anyway, but warns).
 *
 *  Dedup rule (dedup wins over conflict): the new text is a duplicate of an
 *  existing entry when, after lowercasing and stripping ALL whitespace:
 *    - one normalized string is a substring of the other, OR
 *    - the Levenshtein distance is < 10% of the shorter normalized length.
 *  Whitespace/case-only differences and trivial typos carry no new
 *  information, so recording them just adds noise to the evidence list.
 *
 *  Conflict rule: the new and an existing entry take opposing polarity on the
 *  same outcome - one carries a positive marker (passed/success/通过/✅) and
 *  the other a negative one (failed/not/失败/❌). This is advisory only: the
 *  agent may legitimately be correcting an earlier claim, so we surface a
 *  warning but do NOT block the record.
 *
 *  Pure + unit-testable; called from update_goal's criterionId+evidence branch. */
export function assessEvidence(newEvidence: string, existing: string[]): { duplicate: boolean; conflict?: string } {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
	const a = norm(newEvidence);
	if (existing.length === 0 || a.length === 0) return { duplicate: false };

	// ponytail: classic 2-row DP Levenshtein. O(m*n) is fine for evidence strings
	// (short prose); upgrade to a banded/Myers diff only if evidence grows huge.
	const lev = (x: string, y: string): number => {
		if (x === y) return 0;
		const m = x.length, n = y.length;
		let prev = new Array<number>(n + 1);
		let curr = new Array<number>(n + 1);
		for (let j = 0; j <= n; j++) prev[j] = j;
		for (let i = 1; i <= m; i++) {
			curr[0] = i;
			for (let j = 1; j <= n; j++) {
				const cost = x.charCodeAt(i - 1) === y.charCodeAt(j - 1) ? 0 : 1;
				curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			}
			[prev, curr] = [curr, prev];
		}
		return prev[n];
	};

	for (const raw of existing) {
		const b = norm(raw);
		if (b.length === 0) continue;
		// Dedup: substring either way, or Levenshtein < 10% of the shorter length.
		const isDup = a.includes(b) || b.includes(a) || lev(a, b) < 0.1 * Math.min(a.length, b.length);
		if (isDup) return { duplicate: true };
	}

	// Conflict: opposing polarity on the same outcome. Positive vs negative
	// marker pairs. Advisory - does not block recording.
	const POS = /\b(passed|succeed|success|succeeded)\b|通过|✅/i;
	const NEG = /\b(failed|fail)\b|\bnot\b|不|失败|❌/i;
	for (const raw of existing) {
		const oldHasPos = POS.test(raw), oldHasNeg = NEG.test(raw);
		const newHasPos = POS.test(newEvidence), newHasNeg = NEG.test(newEvidence);
		const opposed = (newHasPos && oldHasNeg) || (newHasNeg && oldHasPos);
		if (opposed) {
			return { duplicate: false, conflict: `New evidence may contradict an earlier entry ("${raw.slice(0, 60)}"). Recording anyway.` };
		}
	}
	return { duplicate: false };
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
	const uncovered = goal.criteria.filter((c) => c.evidence.length === 0);
	if (uncovered.length > 0) {
		return { ok: false, reason: uncovered.length + " criteria lack evidence" };
	}
	if (goal.reviewRequired && !goal.reviewerPassed) {
		return {
			ok: false,
			reason: "This goal's risk-based assurance decision requires an independent reviewer before completion.",
		};
	}
	if (goal.reviewRequired && goal.reviewerPassed) {
		if (!goal.reviewerVerdict) {
			return { ok: false, reason: "A required independent review must include a structured verdict." };
		}
		const v = validateReviewerVerdict(goal.reviewerVerdict);
		if (!v.ok) return { ok: false, reason: "Reviewer verdict contract not satisfied: " + (v.reason ?? "unknown") };
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

export interface ParsedGoalConfig {
	config: GoalConfig;
	warnings: string[];
}

const TASK_KINDS = new Set<TaskKind>(["general", "coding", "research", "pm", "review"]);
const EXECUTION_PREFERENCES = new Set<ExecutionPreference>(["auto", "direct", "specialist", "team"]);
const REVIEW_POLICIES = new Set<ReviewPolicy>(["risk_based", "always", "never"]);
const COMPLETION_POLICIES = new Set<CompletionPolicy>(["legacy", "shadow", "v2"]);

/** Parse both the legacy flat config and schema v2 without silently accepting
 * invalid policy values. Invalid fields fall back individually and are
 * reported as warnings; a future schema falls back as a whole. */
export function parseGoalConfig(input: unknown): ParsedGoalConfig {
	const warnings: string[] = [];
	const config: GoalConfig = { ...DEFAULT_GOAL_CONFIG };
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { config, warnings: ["goal config must be a JSON object; using defaults"] };
	}
	const raw = input as Record<string, unknown>;
	if (typeof raw.schemaVersion === "number" && raw.schemaVersion > 2) {
		return { config, warnings: ["goal config schemaVersion " + raw.schemaVersion + " is newer than supported version 2; using defaults"] };
	}
	if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
		warnings.push("invalid schemaVersion; treating config as legacy")
	}

	if (raw.superpowersIntegration !== undefined) {
		if (typeof raw.superpowersIntegration === "boolean") config.superpowersIntegration = raw.superpowersIntegration;
		else warnings.push("superpowersIntegration must be boolean; using true");
	}

	const nonEmptyString = (key: string): string | undefined => {
		const value = raw[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.trim().length === 0) {
			warnings.push(key + " must be a non-empty string; ignoring it");
			return undefined;
		}
		return value.trim();
	};
	const evaluatorModel = nonEmptyString("evaluatorModel");
	const legacyJudgeModel = nonEmptyString("judgeModel");
	if (evaluatorModel && legacyJudgeModel && evaluatorModel !== legacyJudgeModel) {
		warnings.push("evaluatorModel overrides deprecated judgeModel");
	}
	const selectedEvaluator = evaluatorModel ?? legacyJudgeModel;
	config.evaluatorModel = selectedEvaluator;
	// Keep the legacy runtime field populated for one compatibility cycle.
	config.judgeModel = selectedEvaluator;
	config.verifyCommand = nonEmptyString("verifyCommand");
	config.stuckEscalateModel = nonEmptyString("stuckEscalateModel");

	if (raw.verifyTimeoutMs !== undefined) {
		if (typeof raw.verifyTimeoutMs === "number" && Number.isFinite(raw.verifyTimeoutMs) && raw.verifyTimeoutMs > 0) {
			config.verifyTimeoutMs = Math.floor(raw.verifyTimeoutMs);
		} else {
			warnings.push("verifyTimeoutMs must be a positive finite number; using the default")
		}
	}

	const parseEnum = <T extends string>(key: string, values: Set<T>, fallback: T | undefined): T | undefined => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value === "string" && values.has(value as T)) return value as T;
		warnings.push(key + " has an invalid value; using " + (fallback ?? "auto"));
		return fallback;
	};
	config.forceTaskType = parseEnum("forceTaskType", TASK_KINDS, undefined);
	config.reviewPolicy = parseEnum("reviewPolicy", REVIEW_POLICIES, "risk_based");
	config.defaultExecution = parseEnum("defaultExecution", EXECUTION_PREFERENCES, "auto");
	config.completionPolicy = parseEnum("completionPolicy", COMPLETION_POLICIES, "v2");
	const specDir = typeof raw.goalSpecDir === "string" ? raw.goalSpecDir.trim() : "";
	config.goalSpecDir = specDir || "docs/goals";

	const knownKeys = new Set([
		"schemaVersion", "superpowersIntegration", "evaluatorModel", "judgeModel",
		"verifyCommand", "stuckEscalateModel", "verifyTimeoutMs", "forceTaskType",
		"reviewPolicy", "defaultExecution", "completionPolicy", "goalSpecDir",
	]);
	for (const key of Object.keys(raw)) {
		if (!knownKeys.has(key)) warnings.push("unknown goal config key: " + key);
	}
	return { config, warnings };
}

/** Load optional config from <cwd>/.pi/goal.json (trusted projects only). */
export function loadGoalConfig(cwd: string, trusted: boolean): GoalConfig {
	if (!trusted) return { ...DEFAULT_GOAL_CONFIG };
	const cfgPath = path.join(cwd, ".pi", "goal.json");
	try {
		if (!fs.existsSync(cfgPath)) return { ...DEFAULT_GOAL_CONFIG };
		const parsed = parseGoalConfig(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
		for (const warning of parsed.warnings) console.warn("[pi-goal] " + warning);
		return parsed.config;
	} catch (error) {
		console.warn("[pi-goal] failed to parse " + cfgPath + ": " + (error instanceof Error ? error.message : String(error)));
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
