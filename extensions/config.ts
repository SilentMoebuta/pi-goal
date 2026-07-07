import * as fs from "node:fs";
import * as path from "node:path";
import { checkCitationTraceability, checkSourceDiversity, checkConfidenceAnnotation } from "./quality-gates";

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
 *  G7 (single 自批禁): single 模式可保留,但 singleRationale 须交 reviewer 审,
 *  不得自给理由自过 — 在 single+非 coding 时也注入提示 (不再空串).
 *  Returns empty string for coding/undefined (no constraint, backward-compat). */
export function orchestratorConstraintBlock(executionMode?: string, taskType?: string, singleRationale?: string): string {
	const nonCoding = taskType && taskType !== "coding";
	if (!nonCoding) return ""; // coding/undefined: 无约束 (backward-compat)
	if (executionMode === "orchestrated") {
		return "\n\n## Orchestrated 模式约束 (executionMode=orchestrated)\n" +
			"你是编排者。执行工作必须 spawn role (researcher/coder/pm/reviewer)。\n" +
			"直接调 web_search/write/edit 执行实质工作 = 违约 (可被 reviewer 检测)。\n" +
			"违约检测靠 reviewer 事后审查 + judge turn 级评估 — 不硬 deny 工具 (执行权与验收权正交)。\n" +
			"例外: 读文件/跑测试等编排辅助操作可直接调 (非实质执行工作)。\n";
	}
	// G7: single 模式提示 — 可直执但理由须交 reviewer 审, 不得自批.
	return "\n\n## Single 模式约束 (executionMode=single, taskType=" + taskType + ")\n" +
		"你选择 single 模式 (main agent 直执)。理由已声明: " + (singleRationale ? "" + singleRationale : "(未提供)") + "\n" +
		"该理由将由独立 reviewer 审核是否成立 — 不得自给理由自己通过 (handoff §八: 不能自己给理由自己过)。\n" +
		"若 reviewer 认为该任务不该 single (需 spawn 交叉验证/多角度), complete 会被拒。\n" +
		"实质执行工作尽量 spawn role; 单 agent 串行做完整个 workflow = 违约信号。\n";
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
	"\n   ⚠️ reviewer roleDef 聚焦规范 (教训14, 避 doom-loop): 明确限定工具调用序列 (如 read 指定段 + grep + report_role_result), 禁探索性调用 (curl/dig URL probing / ls/find 目录探索会触发 doom-loop detector 误报 abort), maxTurns 适中 (15-30; 复杂审计≥25).";

const RESEARCH_GOVERNANCE =
	"\n\n## Research 模式规则 (taskType=research)\n" +
	"调研类任务不套 superpowers coding 门（无 TDD），但 research workflow 阶段是 HARD-GATE：\n" +
	"1. 计划：列出 ≥3 个独立研究角度（多角度并发，单 agent 串行 = 偷懒信号）\n" +
	"2. 采集：每条数据标注来源（URL/文件路径）+ 置信度（高/中/低/猜测）\n" +
	"3. 交叉验证：关键数据用 ≥2 个独立来源佐证，二手编译数据追源头 — 跳过此阶段=违约\n" +
	"4. 综合：诚实标注数据/推理/假设的边界\n" +
	"5. reviewer 验引用：完成前 spawn 独立 reviewer 审引用可溯率 + 判断可信度（reviewer ≠ 产出者）\n\n" +
	"⚠️ 阶段 HARD-GATE: criteria 对应阶段产物, evidence 必须分阶段提交 (criterionId 标记阶段).\n" +
	"跳过交叉验证 (阶段 3) 直接综合 = 违约, reviewer 会拒 (第2条). 机器形式验: criteria>=3 +\n" +
	"evidence 全覆盖; 实质验 (per-claim >=2 源) 靠 reviewer, 不可机器化 (根因5残余, 诚实标注).\n\n" +
	"质量门（reviewer 检查清单 + update_goal 重跑验真伪）: 引用可溯率 (URL/路径占比 >=0.3)、来源多样性 (>=3)、置信度标注完整性、是否循环论证。\n" +
	"禁止的反模式：自评自己写的报告（循环论证）、单源断言、拍脑袋置信度、跳过交叉验证。\n" + REVIEWER_ROLEDEF_HINT;

const PM_GOVERNANCE =
	"\n\n## PM 模式规则 (taskType=pm)\n" +
	"产品方向类任务不套 superpowers coding 门，按 PM Discovery SOP 走：\n" +
	"1. 盘点：领域现状 + 竞品格局\n" +
	"2. 痛点：用数据说话（来源+置信度），区分 AI 能解 vs 流程/治理问题\n" +
	"3. 机会：3-5 个，每个含技术可行性/业界现状/差异化/风险\n" +
	"4. 优先级：用户价值×可行性×差异化，MVP 边界（做/不做）+ 成功指标（领域特化）\n" +
	"5. reviewer 验论证：完成前 spawn 独立 reviewer 审机会是否有据、优先级是否合理、假设是否标注\n\n" +
	"禁止的反模式：纯口号式建议（如\"用 AI 做合同管理\"）、无数据支撑的判断、自评自审。\n" + REVIEWER_ROLEDEF_HINT;

const REVIEW_GOVERNANCE =
	"\n\n## Review 模式规则 (taskType=review)\n" +
	"审查/审计类任务不套 superpowers coding 门，按 review workflow 走：\n" +
	"1. 审计清单：按正确性/安全/可维护/迁移风险维度逐项查\n" +
	"2. 证据：每条发现附文件行号/源码/测试输出\n" +
	"3. 分级：critical/major/minor/nit，给修改建议\n" +
	"4. reviewer 复核：完成前 spawn 独立 reviewer 复核审计覆盖度 + 分级合理性（reviewer ≠ 产出者）\n\n" +
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
	/** True only after an independent reviewer (subagent ≠ producer) has
	 *  APPROVED. Non-coding goals require this to complete. */
	reviewerPassed?: boolean;
	/** 第2条: 结构化验收凭证, 替代裸布尔. 非 coding goal reviewerPassed=true 时
	 *  必须携带, canComplete 验契约满足. undefined = 未提供 (非 coding 拒, coding 忽略). */
	reviewerVerdict?: ReviewerVerdict;
	/** G7 (single 自批禁): single 模式的理由, 起草时声明, 交 reviewer 审核. */
	singleRationale?: string;
	/** 深修 A: execution mode. single = main agent 直执 (须 singleRationale); orchestrated = spawn role. */
	executionMode?: "single" | "orchestrated";
	/** Criteria with their collected evidence (existing field). */
	criteria: { evidence: string[] }[];
}

/** 第3条 (CLM run 复盘): verifyQualityGates — 接线 quality-gates.ts 三个死函数.
 *  Root cause: checkCitationTraceability/checkSourceDiversity/checkConfidenceAnnotation
 *  定义了但无人调 (handoff §八 根因5 残余). Fix: 此纯函数调它们, update_goal handler
 *  在 reviewerPassed=true 时读 reportPath 重跑, 验 reviewer 自报 checksPassed 真伪.
 *  不信任 reviewer 自报 (第2条: reviewer 可廉价满足). 阈值: traceability>=0.3,
 *  diversity>=3, confidenceAnnotated=true. 阈值依据: 本次 CLM 报告实测 (15 URL,
 *  多源) 刚好过线; 过松=形同虚设, 过紧=误杀. 可调 (常量集中此处).
 *  Returns {ok, reason?, metrics?}. metrics 供 handler 写回 verdict 供审计. */
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

export function verifyQualityGates(reportText: string, taskType?: string): { ok: boolean; reason?: string; metrics?: QualityGateMetrics } {
	if (!reportText || reportText.trim().length === 0) return { ok: false, reason: "Report text is empty — nothing to verify." };
	const citationTraceability = checkCitationTraceability(reportText);
	const sourceDiversity = checkSourceDiversity(reportText);
	const confidenceAnnotated = checkConfidenceAnnotation(reportText);
	const metrics: QualityGateMetrics = { citationTraceability, sourceDiversity, confidenceAnnotated };
	const citationBar = taskType ? (CITATION_TRACEABILITY_BY_TASK_TYPE[taskType] ?? QUALITY_GATE_THRESHOLDS.citationTraceability) : QUALITY_GATE_THRESHOLDS.citationTraceability;
	if (citationTraceability < citationBar) {
		return { ok: false, reason: "Citation traceability " + citationTraceability.toFixed(2) + " < threshold " + citationBar + " (taskType=" + (taskType ?? "undefined") + ") — too few data points carry a URL/path citation.", metrics };
	}
	if (sourceDiversity < QUALITY_GATE_THRESHOLDS.sourceDiversity) {
		return { ok: false, reason: "Source diversity " + sourceDiversity + " < threshold " + QUALITY_GATE_THRESHOLDS.sourceDiversity + " — not enough distinct sources.", metrics };
	}
	if (!confidenceAnnotated) {
		return { ok: false, reason: "No confidence annotation found — report must mark 置信度 (高/中/低/猜测) on data points.", metrics };
	}
	return { ok: true, metrics };
}

/** 第2条 (CLM run 复盘): reviewer verdict — 结构化验收凭证, 替代裸布尔 reviewerPassed.
 *  Root cause: reviewerPassed 是裸布尔, main agent 说 true 就 true, 框架不知 reviewer 用了
 *  什么配置/验了多少源——reviewer 可被廉价满足 (浅模型+low thinking+不验源, 读结构 APPROVE).
 *  handoff §八 根因2. Fix: reviewerPassed=true 须携带此 verdict, canComplete 验契约满足.
 *  契约: thinking≥medium (独立验收要够思考), verifiedSources≥3 (验源下限), model 非空,
 *  checksPassed=true (第3条 quality-gates 机器项). notes=reviewer 主观判断 (不可机器验项).
 *  软约束: verdict 由 reviewer LLM 填, 但 update_goal handler 重跑 quality-gates 验真伪 (第3条). */
export interface ReviewerVerdict {
	/** reviewer 用的模型 (provider/model-id 或 bare id). 非空=声明用了真模型. */
	model?: string;
	/** thinking level: low/medium/high/xhigh. <medium 拒 (独立验收不能浅思考). */
	thinkingLevel?: string;
	/** reviewer 实际独立验源的 URL/路径数. <3 拒 (验源下限). */
	verifiedSources: number;
	/** quality-gates 机器项是否全过 (第3条). reviewer 报, handler 重跑验真伪. */
	checksPassed: boolean;
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
	if (!v.model) return { ok: false, reason: "Reviewer verdict missing model — cannot confirm a real model was used." };
	const thinkingOk = v.thinkingLevel && ["medium", "high", "xhigh"].includes(v.thinkingLevel);
	if (!thinkingOk) return { ok: false, reason: "Reviewer thinkingLevel must be >= medium (got " + (v.thinkingLevel ?? "undefined") + ") — independent review cannot be shallow (handoff §八 root cause 2)." };
	if (typeof v.verifiedSources !== "number" || v.verifiedSources < 3) return { ok: false, reason: "Reviewer verifiedSources must be >= 3 (got " + v.verifiedSources + ") — 验源下限, prevents rubber-stamp review." };
	if (!v.checksPassed) return { ok: false, reason: "Reviewer checksPassed=false — machine-verifiable quality gates (citation traceability / source diversity / confidence annotation) not satisfied." };
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

/** G3 (CLM 二次 live 测试复盘 / 教训6): extract the reviewer's actual report_role_result
 *  findings from a sub-session's .jsonl transcript. The sub-session jsonl is written by
 *  pi-core (not forgeable by the main agent) and contains ONLY that reviewer's turns,
 *  so finding a report_role_result toolCall with non-empty findings proves a real
 *  reviewer session existed and reported substantively — closing the "fabricated
 *  verdict with no real reviewer" gap that reviewerVerdict (结构合规) + reportPath
 *  re-run (报告内容真伪) alone could not close.
 *
 *  Cross-extension reality: pi-goal cannot read pi-roles' in-memory ReportState, so
 *  the sessionFile is the only independent ground-truth bridge. Pure + unit-testable
 *  (no fs); the handler does the file read and calls this. Returns {found, findings?}:
 *  found=true means a report_role_result toolCall was parsed; findings may still be
 *  empty (handler rejects empty findings even when found). */
export function extractReviewerFindings(jsonlText: string): { found: boolean; findings?: unknown } {
	if (!jsonlText || jsonlText.trim().length === 0) return { found: false };
	const lines = jsonlText.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: any;
		try { parsed = JSON.parse(trimmed); } catch { continue; } // skip malformed lines
		const msg = parsed && typeof parsed === "object" ? parsed.message : undefined;
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const c of msg.content) {
			if (c && typeof c === "object" && c.type === "toolCall" && c.name === "report_role_result") {
				const args = c.arguments && typeof c.arguments === "object" ? c.arguments : {};
				return { found: true, findings: args.findings };
			}
		}
	}
	return { found: false };
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
	extracted: { found: boolean; findings?: unknown },
): { ok: boolean; reason?: string } {
	if (!agentId || !sessionFile) {
		return { ok: false, reason: "reviewerPassed=true for non-coding goal requires reviewerAgentId + reviewerSessionFile (G3: verdict source authenticity). The verdict must come from a real spawned reviewer session, not a self-constructed JSON. Re-spawn a reviewer and pass its agentId + sessionFile." };
	}
	if (!extracted.found) {
		return { ok: false, reason: "No report_role_result found in reviewerSessionFile (G3: the referenced session did not actually report — verdict not sourced from a real reviewer). Re-spawn and ensure the reviewer calls report_role_result." };
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
export function validateGoalProposal(input: { taskType?: string; executionMode?: string; criteria?: string[]; singleRationale?: string }): { ok: boolean; reason?: string } {
	const nonCoding = input.taskType && input.taskType !== "coding";
	if (nonCoding && !input.executionMode) {
		return {
			ok: false,
			reason: "Non-coding taskType (" + input.taskType + ") requires an explicit executionMode (\"single\" for main-agent direct execution, or \"orchestrated\" for role-based delegation). Omitting it defaults to single — a structural bias toward treating complex tasks as simple (handoff §八). Choose explicitly.",
		};
	}
	// G7 (single 自批禁): single 模式须给出可独立审核的理由, 不得 main agent 自批自过.
	// 理由 ≠ 空话: ≥30 字且须含具体依据 (任务规模/单点性/无外部依赖等), 由 reviewer 审.
	if (input.taskType && input.taskType !== "coding" && input.executionMode === "single") {
		const r = (input.singleRationale ?? "").trim();
		if (r.length < 30) {
			return {
				ok: false,
				reason: "single executionMode requires a singleRationale (≥30 chars) explaining WHY this task can be done by the main agent alone without spawn — e.g. single-point lookup, trivial scope, no cross-validation needed. Empty/short rationale = self-approving without justification (handoff §八: 不能自己给理由自己过). The rationale will be independently audited by the reviewer.",
			};
		}
	}
	// 第5条: research 阶段 HARD-GATE (形式). criteria >=3 对应 plan/collect/cross-validate
	// 阶段产物. 诚实: 形式验非实质验, per-claim 交叉验证靠 reviewer (根因5残余).
	if (input.taskType === "research" && input.criteria && input.criteria.length < 3) {
		return {
			ok: false,
			reason: "Research goal requires >= 3 criteria (corresponding to plan/collect/cross-validate stage artifacts). Fewer = skipping research workflow stages (handoff §八 第5条).",
		};
	}
	return { ok: true };
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
	// 第2条: reviewerPassed=true 须携带结构化 verdict, 验契约满足. 裸布尔不再够
	// (CLM run 复盘: 浅 reviewer 橡皮图章 APPROVE). coding/undefined 无此检查 (backward-compat).
	if (goal.taskType && goal.taskType !== "coding" && goal.reviewerPassed) {
		if (!goal.reviewerVerdict) {
			return { ok: false, reason: "Non-coding goal reviewerPassed=true but no reviewerVerdict provided — a bare boolean is no longer sufficient (第2条: prevents rubber-stamp review). Re-spawn reviewer with a structured verdict (model/thinkingLevel>=medium/verifiedSources>=3/checksPassed)." };
		}
		const v = validateReviewerVerdict(goal.reviewerVerdict);
		if (!v.ok) return { ok: false, reason: "Reviewer verdict contract not satisfied: " + (v.reason ?? "unknown") };
		// G7 (single 自批禁): single 模式的 singleRationale 须由 reviewer 独立审核通过.
		// main agent 不得自给理由自过 — 执行权与验收权正交.
		const singleCheck = validateSingleRationaleApproved(goal, goal.reviewerVerdict);
		if (!singleCheck.ok) return { ok: false, reason: singleCheck.reason ?? "single rationale not approved by reviewer" };
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
