/**
 * Headless goal blueprint — 设计见 docs/design/2026-08-06-headless-goal-blueprint.md。
 *
 * 职责（纯逻辑 + 文件 IO，不依赖 pi ExtensionAPI）：
 *   - validateBlueprint：蓝图与 criteria/claims 的交叉校验 + 信任门（verifyCommand）。
 *   - createGoalFromBlueprint：蓝图 → GoalStateV2（跳过 LLM 起草与 review UI）。
 *   - buildGoalResultView / writeGoalResult：终态结果文件契约（§7.1）。
 *   - appendGoalLog：追加式 JSONL 实时日志（§7.2，含 10MB 截断保护）。
 * 事件回显（pi-goal:headless_event）由 index.ts 负责发送。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createGoalStateV2, type GoalStateV2, type TaskKind } from "./state";
import type { ExecutionDecision, AssuranceDecision, EvidenceRef, GoalHeadlessMeta } from "./state";
import type { GoalSpecDoc, HeadlessBlueprint } from "./spec-doc";

export const GOAL_HEADLESS_EVENT_TYPE = "pi-goal:headless_event";
export const GOAL_HEADLESS_RESULT_TYPE = "pi-goal:headless_result";

export const HEADLESS_LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_TRUNCATED_PATHS = new Set<string>();

const HEADLESS_EVIDENCE_KINDS = new Set([
	"source", "artifact", "command", "tool_result", "observation", "user_confirmation", "legacy_text",
]);

/** Spec 文档的 criterion 无 id 字段：按文档顺序生成稳定 id（c1..cN）。
 *  校验与创建必须用同一规则，蓝图 evidence 期望即引用这些 id。 */
export function specCriterionId(index: number): string {
	return "c" + (index + 1);
}

function knownOutcomeIds(doc: GoalSpecDoc): Set<string> {
	const ids = new Set(doc.criteria.map((_criterion, index) => specCriterionId(index)));
	for (const claim of doc.claims) ids.add(claim.id);
	return ids;
}

// ═══════════════════════════════════════════════════════════════════
// 蓝图校验
// ═══════════════════════════════════════════════════════════════════

export interface ValidateBlueprintOptions {
	/** verifyCommand 是任意 shell 执行，仅 trusted project 允许。 */
	trusted: boolean;
}

export type ValidateBlueprintResult =
	| { ok: true }
	| { ok: false; errors: string[] };

/** 蓝图与 goal spec 的交叉校验（形状校验已在 spec-doc.parseBlueprint 完成）。 */
export function validateBlueprint(
	blueprint: HeadlessBlueprint,
	doc: GoalSpecDoc,
	options: ValidateBlueprintOptions,
): ValidateBlueprintResult {
	const errors: string[] = [];
	const knownIds = knownOutcomeIds(doc);

	const evidence = blueprint.evidence;
	if (evidence) {
		for (const expectation of evidence.criteria ?? []) {
			if (!knownIds.has(expectation.id)) {
				errors.push(`blueprint.evidence.criteria: ${expectation.id} does not match any criterion or claim id`);
			}
			for (const kind of expectation.kinds ?? []) {
				if (!HEADLESS_EVIDENCE_KINDS.has(kind)) {
					errors.push(`blueprint.evidence.criteria: ${expectation.id} uses unknown evidence kind ${kind}`);
				}
			}
		}
		for (const node of evidence.nodes ?? []) {
			if (!knownIds.has(node.attachTo)) {
				errors.push(`blueprint.evidence.nodes: ${node.id} attaches to unknown criterion/claim ${node.attachTo}`);
			}
			if (!HEADLESS_EVIDENCE_KINDS.has(node.evidenceKind)) {
				errors.push(`blueprint.evidence.nodes: ${node.id} uses unknown evidence kind ${node.evidenceKind}`);
			}
		}
	}

	if (blueprint.execution.topology === "specialist"
		&& !blueprint.execution.role
		&& !(blueprint.execution.roleDefs && blueprint.execution.roleDefs.length > 0)) {
		errors.push("blueprint.execution: specialist topology requires a registered role or at least one roleDef");
	}

	if (blueprint.verification && blueprint.verification.command && !options.trusted) {
		errors.push(
			"blueprint.verification.command requires a trusted project: run with --approve or trust the project first (arbitrary shell execution)",
		);
	}

	if (blueprint.budget?.tokens !== undefined && !Number.isFinite(blueprint.budget.tokens)) {
		errors.push("blueprint.budget.tokens must be a finite number");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// 蓝图 → GoalStateV2
// ═══════════════════════════════════════════════════════════════════

export interface CreateGoalFromBlueprintInput {
	id: string;
	doc: GoalSpecDoc;
	blueprint: HeadlessBlueprint;
	specPath: string;
	outputPath: string;
	logPath: string;
	now: number;
}

function blueprintExecution(blueprint: HeadlessBlueprint): ExecutionDecision {
	const topology = blueprint.execution.topology;
	return {
		preference: topology,
		selected: topology,
		source: "user",
		confidence: 1,
		reasons: ["Headless blueprint declares the execution topology."],
		// 蓝图锁定：不因运行期信号自动改道（guided 模式由 agent 记录偏离而非重路由）。
		reassessOn: [],
	};
}

function blueprintAssurance(blueprint: HeadlessBlueprint, now: number): AssuranceDecision {
	const requirement = blueprint.review?.requirement ?? "advisory";
	return {
		reviewRequirement: requirement,
		reviewStatus: requirement === "none" ? "not_required" : "pending",
		independent: requirement !== "none",
		depth: requirement === "required" ? "deep" : requirement === "advisory" ? "standard" : "light",
		source: "user",
		reasons: ["Headless blueprint declares the assurance policy."],
		decidedAt: now,
	};
}

/** 蓝图 + spec 文档 → 新的 GoalStateV2（无 UI、无 LLM 起草）。 */
export function createGoalFromBlueprint(input: CreateGoalFromBlueprintInput): GoalStateV2 {
	const doc = input.doc;
	const headless: GoalHeadlessMeta = {
		specPath: input.specPath,
		outputPath: input.outputPath,
		logPath: input.logPath,
		startedAt: input.now,
	};
	const goal = createGoalStateV2({
		id: input.id,
		objective: doc.objective,
		criteria: doc.criteria.map((criterion, index) => ({
			id: specCriterionId(index),
			description: criterion.description,
			level: criterion.level,
		})),
		constraints: doc.constraints,
		taskKind: (doc.machine.taskKind as TaskKind | undefined) ?? "general",
		execution: blueprintExecution(input.blueprint),
		assurance: blueprintAssurance(input.blueprint, input.now),
		tokenBudget: input.blueprint.budget?.tokens ?? null,
		blueprint: input.blueprint,
		headless,
		now: input.now,
	});
	goal.claims = doc.claims.map((claim) => ({
		id: claim.id,
		text: claim.text,
		materiality: claim.materiality,
		...(claim.risk ? { risk: claim.risk } : {}),
		evidenceRefs: [],
	}));
	return goal;
}

// ═══════════════════════════════════════════════════════════════════
// 结果视图与文件（§7.1 / §7.2）
// ═══════════════════════════════════════════════════════════════════

export type CriterionResultStatus = "pending" | "evidenced" | "verified" | "blocked";

function criterionStatus(goal: GoalStateV2, evidenceRefs: readonly string[]): CriterionResultStatus {
	if (evidenceRefs.length === 0) return "pending";
	const entries = evidenceRefs
		.map((ref) => goal.evidenceLedger.find((item) => item.id === ref))
		.filter((entry): entry is EvidenceRef => entry !== undefined);
	if (entries.length === 0) return "pending";
	if (entries.some((entry) => entry.verification === "rejected")) return "blocked";
	if (entries.every((entry) => entry.verification === "verified")) return "verified";
	return "evidenced";
}

/** 与 get_goal public view 同构的终态结果视图（§7.1 契约）。 */
export function buildGoalResultView(goal: GoalStateV2, now: number): Record<string, unknown> {
	const wallMs = goal.createdAt != null ? Math.max(0, now - goal.createdAt) : 0;
	const evaluation = goal.completion.lastEvaluation;
	const complete = goal.status === "complete";
	return {
		schemaVersion: 1,
		specPath: goal.headless?.specPath ?? null,
		startedAt: goal.createdAt,
		endedAt: goal.endedAt ?? now,
		status: goal.status,
		objective: goal.objective,
		taskKind: goal.taskKind,
		criteria: goal.criteria.map((criterion) => ({
			id: criterion.id,
			description: criterion.description,
			level: criterion.level,
			status: criterionStatus(goal, criterion.evidenceRefs),
			evidenceRefs: [...criterion.evidenceRefs],
		})),
		evidenceLedger: goal.evidenceLedger.map((entry) => ({
			id: entry.id,
			kind: entry.kind,
			summary: entry.summary,
			...(entry.locator === undefined ? {} : { locator: entry.locator }),
			verification: entry.verification,
			...(entry.verificationNote === undefined ? {} : { verificationNote: entry.verificationNote }),
		})),
		claims: goal.claims.map((claim) => ({
			id: claim.id,
			text: claim.text,
			materiality: claim.materiality,
			...(claim.risk ? { risk: claim.risk } : {}),
			evidenceRefs: [...claim.evidenceRefs],
		})),
		deviations: goal.deviations.map((deviation) => ({
			id: deviation.id,
			...(deviation.subjectId === undefined ? {} : { subjectId: deviation.subjectId }),
			description: deviation.description,
			reason: deviation.reason,
			...(deviation.impact === undefined ? {} : { impact: deviation.impact }),
			recordedAt: deviation.recordedAt,
			origin: deviation.origin,
		})),
		execution: {
			topology: goal.execution.selected,
			...(goal.execution.role === undefined ? {} : { role: goal.execution.role }),
			source: goal.execution.source,
			reasons: goal.execution.reasons,
		},
		review: {
			requirement: goal.assurance.reviewRequirement,
			status: goal.assurance.reviewStatus,
			...(goal.blueprint?.review?.checklist ? { checklist: goal.blueprint.review.checklist } : {}),
		},
		completion: {
			decision: evaluation?.decision ?? null,
			...(evaluation ? { findings: evaluation.findings } : {}),
			...(evaluation ? { advisories: evaluation.advisories } : {}),
			...(evaluation?.evaluator ? { evaluator: { kind: evaluation.evaluator.kind, model: evaluation.evaluator.model } } : {}),
		},
		resources: {
			tokensUsed: goal.tokensUsed,
			tokenBudget: goal.tokenBudget,
			activeMs: goal.timeUsedMs,
			wallMs,
		},
		exit: {
			code: complete ? 0 : 1,
			message: complete ? "Goal achieved." : `Goal ended with status ${goal.status}${goal.pausedReason ? ": " + goal.pausedReason : goal.blocker ? ": " + goal.blocker : ""}`,
		},
	};
}

/** 写入终态结果文件；已存在时备份为 <path>.prev。IO 失败不抛（尽力而为）。 */
export function writeGoalResult(outputPath: string, view: Record<string, unknown>): void {
	try {
		fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
		if (fs.existsSync(outputPath)) {
			try { fs.renameSync(outputPath, outputPath + ".prev"); } catch { /* 忽略备份失败 */ }
		}
		fs.writeFileSync(outputPath, JSON.stringify(view, null, 2) + "\n");
	} catch {
		// result 写入失败不应破坏 goal 状态机；调用方可通过日志/事件获取结果。
	}
}

// ═══════════════════════════════════════════════════════════════════
// 实时日志（JSONL，§7.2）
// ═══════════════════════════════════════════════════════════════════

export interface GoalLogEntry {
	v: 1;
	ts: number;
	goalId: string;
	type: string;
	[key: string]: unknown;
}

/** 工具参数/结果摘要：JSON 安全序列化 + 截断（防日志爆炸，保留关键信息）。 */
export function summarizeValue(value: unknown, max = 300): string {
	if (value === undefined || value === null) return "";
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text.length <= max) return text;
	return text.slice(0, max) + "…(" + text.length + " chars)";
}

export function buildGoalLogEntry(goalId: string, type: string, payload: Record<string, unknown>, ts: number): GoalLogEntry {
	return { v: 1, ts, goalId, type, ...payload };
}

/** 追加一条 JSONL 日志；文件超 10MB 后写 log_truncated 标记并停止。IO 失败不抛。 */
export function appendGoalLog(logPath: string, entry: GoalLogEntry): void {
	if (LOG_TRUNCATED_PATHS.has(logPath)) return;
	try {
		const absolute = path.resolve(logPath);
		if (fs.existsSync(absolute) && fs.statSync(absolute).size > HEADLESS_LOG_MAX_BYTES) {
			LOG_TRUNCATED_PATHS.add(logPath);
			fs.appendFileSync(absolute, JSON.stringify({
				v: 1,
				ts: entry.ts,
				goalId: entry.goalId,
				type: "log_truncated",
				note: "log exceeded 10MB; appending stopped",
			}) + "\n");
			return;
		}
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.appendFileSync(absolute, JSON.stringify(entry) + "\n");
	} catch {
		// 日志失败不阻断 goal。
	}
}

/** 终态：写结果文件 + terminal 日志条目。返回 terminal 条目供事件回显。 */
export function finalizeHeadlessGoal(goal: GoalStateV2, now: number): GoalLogEntry {
	const view = buildGoalResultView(goal, now);
	if (goal.headless) writeGoalResult(goal.headless.outputPath, view);
	const entry = buildGoalLogEntry(goal.id, "terminal", { result: view }, now);
	if (goal.headless) appendGoalLog(goal.headless.logPath, entry);
	return entry;
}

/** Persist a non-terminal process-exit snapshot without claiming terminality. */
export function snapshotActiveHeadlessGoal(goal: GoalStateV2, now: number): GoalLogEntry {
	const view = buildGoalResultView(goal, now);
	if (goal.headless) writeGoalResult(goal.headless.outputPath, view);
	const entry = buildGoalLogEntry(goal.id, "snapshot", { result: view, terminal: false }, now);
	if (goal.headless) appendGoalLog(goal.headless.logPath, entry);
	return entry;
}
