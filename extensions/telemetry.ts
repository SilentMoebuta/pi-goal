/**
 * Goal telemetry（审计 P0）：goal 到达终态时追加一条结构化记录（jsonl），
 * 供策略校准（路由/审查/拒绝门槛的真实效果数据）。与 spec 文档同目录：
 * <goalSpecDir>/telemetry.jsonl。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalStateV2 } from "./state";
import type { GoalConfig } from "./config";

export interface GoalTelemetryEntry {
	/** telemetry schema 版本 */
	schemaVersion: 1;
	goalId: string;
	endedAt: number;
	createdAt: number;
	outcome: GoalStateV2["status"];
	objective: string;
	taskKind: GoalStateV2["taskKind"];
	execution: {
		topology: GoalStateV2["execution"]["selected"];
		role?: string;
		source: GoalStateV2["execution"]["source"];
		confidence: number;
	};
	assurance: {
		requirement: GoalStateV2["assurance"]["reviewRequirement"];
		status: GoalStateV2["assurance"]["reviewStatus"];
	};
	resources: {
		tokensUsed: number;
		tokenBudget: number | null;
		activeMs: number;
		wallMs: number;
	};
	outcomeShape: {
		criteriaTotal: number;
		criteriaBlocking: number;
		claims: number;
		evidence: number;
	};
	rejections: {
		count: number;
		historyLength: number;
		fingerprints: string[];
	};
	pausedReason: string | null;
}

/** 纯函数：goal 状态 → telemetry 条目。 */
export function buildGoalTelemetryEntry(goal: GoalStateV2, now: number): GoalTelemetryEntry {
	const wallMs = goal.createdAt != null ? Math.max(0, now - goal.createdAt) : 0;
	return {
		schemaVersion: 1,
		goalId: goal.id,
		endedAt: now,
		createdAt: goal.createdAt ?? now,
		outcome: goal.status,
		objective: goal.objective.slice(0, 500),
		taskKind: goal.taskKind,
		execution: {
			topology: goal.execution.selected,
			...(goal.execution.role ? { role: goal.execution.role } : {}),
			source: goal.execution.source,
			confidence: goal.execution.confidence,
		},
		assurance: {
			requirement: goal.assurance.reviewRequirement,
			status: goal.assurance.reviewStatus,
		},
		resources: {
			tokensUsed: goal.tokensUsed,
			tokenBudget: goal.tokenBudget,
			activeMs: goal.timeUsedMs,
			wallMs,
		},
		outcomeShape: {
			criteriaTotal: goal.criteria.length,
			criteriaBlocking: goal.criteria.filter((c) => c.level === "blocking").length,
			claims: goal.claims.length,
			evidence: goal.evidenceLedger.length,
		},
		rejections: {
			count: goal.completion.rejectionCount,
			historyLength: goal.completion.rejectionHistory.length,
			fingerprints: goal.completion.rejectionHistory.slice(-5),
		},
		pausedReason: goal.pausedReason,
	};
}

/** 追加一条 telemetry（jsonl，append）。创建目录失败/写入失败仅告警，不阻断 goal。 */
export function appendGoalTelemetry(entry: GoalTelemetryEntry, specDir: string, cwd: string): string | null {
	try {
		const dir = specDir ?? "docs/goals";
		const absoluteDir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
		fs.mkdirSync(absoluteDir, { recursive: true });
		const filePath = path.join(absoluteDir, "telemetry.jsonl");
		fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
		return filePath;
	} catch (error) {
		console.warn("[pi-goal] telemetry write failed:", error);
		return null;
	}
}

/** 读取最近 N 条 telemetry（供 /goal telemetry 展示）。 */
export function readGoalTelemetry(specDir: string, cwd: string, limit = 20): GoalTelemetryEntry[] {
	try {
		const dir = specDir ?? "docs/goals";
		const absoluteDir = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
		const filePath = path.join(absoluteDir, "telemetry.jsonl");
		if (!fs.existsSync(filePath)) return [];
		const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		return lines.slice(-limit).map((line) => {
			try { return JSON.parse(line) as GoalTelemetryEntry; } catch { return null; }
		}).filter((entry): entry is GoalTelemetryEntry => entry !== null);
	} catch {
		return [];
	}
}

export type { GoalConfig };
