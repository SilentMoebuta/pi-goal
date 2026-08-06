/**
 * Goal Spec 文档：把一次 goal draft 序列化为用户可直接编辑的 markdown，
 * 并支持从 markdown 解析回 proposal（供 review UI 的完整编辑、/goal apply 使用）。
 *
 * UX 背景：用户两三句话的目标会被 agent 展开成大量理解（criteria、constraints、
 * claims、execution），旧 review UI 只能逐行编辑 objective/criteria，展开的细节
 * 无法精细修改。Spec 文档把完整理解落成可读可改的 md（参考 Claude Code
 * .claude/plans/、Cursor plan、google-agents-cli spec.md 的共识形态）。
 *
 * 设计：
 * - 文本部分（目标/验收标准/约束/研究声明）从 md 直接解析，用户改 md 即改 proposal。
 * - 机器字段（taskKind/execution/assurance）嵌入 JSON 块，编辑 md 时通常不动；
 *   解析时用 JSON 恢复这些字段，文本冲突时以 md 文本为准。
 * - 纯函数、无 IO，IO（读/写 docs/goals/*.md）由 index.ts 负责。
 */

export interface SpecCriterion {
	description: string;
	level: "blocking" | "advisory";
}

export interface SpecClaim {
	id: string;
	text: string;
	materiality: "material" | "supporting";
	risk?: "ordinary" | "high";
	evidenceRefs?: string[];
}

export interface SpecMachine {
	taskKind?: string;
	execution?: {
		preference?: string;
		selected?: string;
		role?: string;
		source?: string;
		reasons?: string[];
	};
	assurance?: {
		reviewRequirement?: string;
		reviewStatus?: string;
		depth?: string;
		reasons?: string[];
	};
	tokenBudget?: number | null;
}

export interface GoalSpecDoc {
	title: string;
	/** 用户原始描述，保留原话。 */
	original: string;
	objective: string;
	criteria: SpecCriterion[];
	constraints: string[];
	claims: SpecClaim[];
	machine: SpecMachine;
	/** 决策记录：澄清对话的 Q/A 轨迹。 */
	decisions: Array<{ question: string; answer: string }>;
	createdAt?: number;
}

const CRITERION_RE = /^[-*]\s+\[( |x|X)\]\s+`?(blocking|advisory)`?\s*(?:[-:：]\s*)?(.*)$/;
const CONSTRAINT_RE = /^[-*]\s+(.+)$/;
const CLAIM_RE = /^[-*]\s+`([^`]+)`\s*\(([a-z]+)(?:\s*·\s*([a-z]+))?\)\s*(.*)$/;
const DECISION_RE = /^[-*]\s+\*\*Q:\*\*\s*(.*)$/;

function findSection(lines: string[], heading: string): number {
	return lines.findIndex((line) => line.trim().replace(/^#{1,6}\s*/, "") === heading);
}

function sectionLines(lines: string[], heading: string): string[] {
	const start = findSection(lines, heading);
	if (start < 0) return [];
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^#{1,6}\s+\S/.test(line)) break;
		body.push(line);
	}
	return body;
}

function extractJsonBlock(text: string): unknown | null {
	const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!match) return null;
	try {
		return JSON.parse(match[1]);
	} catch {
		return null;
	}
}

function slugifyTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "goal";
}

/** GoalProposal → md。machine 字段以 JSON 块嵌入保证无损恢复。 */
export function proposalToMarkdown(input: {
	original: string;
	objective: string;
	criteria: SpecCriterion[];
	constraints: string[];
	claims: SpecClaim[];
	decisions?: Array<{ question: string; answer: string }>;
	machine?: SpecMachine;
	createdAt?: number;
}): string {
	const title = input.objective.replace(/\s+/g, " ").slice(0, 60) || "Goal";
	const lines: string[] = [];
	lines.push("# Goal: " + title);
	lines.push("");
	lines.push("> 状态: draft");
	if (input.createdAt) lines.push("> 创建: " + new Date(input.createdAt).toISOString().slice(0, 10));
	lines.push("");
	lines.push("## 原始描述");
	lines.push("");
	lines.push("> " + input.original.replace(/\n+/g, "\n> "));
	lines.push("");
	lines.push("## 目标");
	lines.push("");
	lines.push(input.objective);
	lines.push("");
	lines.push("## 验收标准");
	lines.push("");
	for (const criterion of input.criteria) {
		lines.push("- [ ] `" + criterion.level + "` " + criterion.description);
	}
	lines.push("");
	lines.push("## 约束");
	lines.push("");
	if (input.constraints.length === 0) lines.push("_无_");
	for (const constraint of input.constraints) lines.push("- " + constraint);
	lines.push("");
	lines.push("## 研究声明");
	lines.push("");
	if (input.claims.length === 0) lines.push("_无_");
	for (const claim of input.claims) {
		const risk = claim.risk ? " · " + claim.risk : "";
		lines.push("- `" + claim.id + "` (" + claim.materiality + risk + ") " + claim.text);
	}
	lines.push("");
	lines.push("## 执行策略");
	lines.push("");
	const execution = input.machine?.execution;
	if (execution) {
		lines.push("- topology: " + (execution.selected ?? execution.preference ?? "auto"));
		if (execution.role) lines.push("- role: " + execution.role);
		if (execution.reasons && execution.reasons.length > 0) lines.push("- 理由: " + execution.reasons.join("; "));
	} else {
		lines.push("- topology: auto");
	}
	lines.push("");
	if (input.decisions && input.decisions.length > 0) {
		lines.push("## 决策记录");
		lines.push("");
		for (const decision of input.decisions) {
			lines.push("- **Q:** " + decision.question);
			lines.push("  - **A:** " + decision.answer);
		}
		lines.push("");
	}
	lines.push("## 机器字段");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(input.machine ?? {}, null, 2));
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

export interface ParseGoalSpecResult {
	ok: boolean;
	doc?: GoalSpecDoc;
	error?: string;
}

/** md → GoalSpecDoc。文本部分以 md 为准；机器字段从 JSON 块恢复。 */
export function parseGoalSpecMarkdown(text: string): ParseGoalSpecResult {
	const lines = text.split(/\r?\n/);
	const titleLine = lines.find((line) => line.startsWith("# Goal:"));
	const title = titleLine ? titleLine.replace(/^# Goal:\s*/, "").trim() : "Goal";

	const originalLines = sectionLines(lines, "原始描述")
		.map((line) => line.replace(/^>\s?/, "").trim())
		.filter(Boolean);
	const objectiveLines = sectionLines(lines, "目标")
		.map((line) => line.trim())
		.filter(Boolean);
	if (objectiveLines.length === 0) {
		return { ok: false, error: "Spec 文档缺少 '## 目标' 段落，无法解析。" };
	}

	const criteria: SpecCriterion[] = [];
	for (const line of sectionLines(lines, "验收标准")) {
		const match = line.match(CRITERION_RE);
		if (!match) continue;
		const level = match[2] === "advisory" ? "advisory" : "blocking";
		const description = (match[3] ?? "").trim();
		if (description) criteria.push({ description, level });
	}
	if (criteria.length === 0) {
		return { ok: false, error: "Spec 文档的 '## 验收标准' 中没有可解析的 criterion（格式: - [ ] `blocking` 描述）。" };
	}

	const constraints: string[] = [];
	for (const line of sectionLines(lines, "约束")) {
		const match = line.match(CONSTRAINT_RE);
		if (!match) continue;
		const value = match[1].trim();
		if (value && value !== "_无_") constraints.push(value);
	}

	const claims: SpecClaim[] = [];
	for (const line of sectionLines(lines, "研究声明")) {
		const match = line.match(CLAIM_RE);
		if (!match) continue;
		const materiality = match[2] === "supporting" ? "supporting" : "material";
		const risk = match[3] === "high" ? "high" : match[3] === "ordinary" ? "ordinary" : undefined;
		const text = (match[4] ?? "").trim();
		if (text && text !== "_无_") claims.push({ id: match[1], text, materiality, ...(risk ? { risk } : {}) });
	}

	const decisions: Array<{ question: string; answer: string }> = [];
	const decisionLines = sectionLines(lines, "决策记录");
	let currentQuestion: string | null = null;
	for (const line of decisionLines) {
		const question = line.match(DECISION_RE);
		if (question) { currentQuestion = question[1].trim(); continue; }
		const answer = line.match(/^\s*[-*]\s+\*\*A:\*\*\s*(.*)$/);
		if (answer && currentQuestion) {
			decisions.push({ question: currentQuestion, answer: answer[1].trim() });
			currentQuestion = null;
		}
	}

	const rawMachine = extractJsonBlock(text);
	const machine: SpecMachine = isRecord(rawMachine) ? (rawMachine as SpecMachine) : {};

	return {
		ok: true,
		doc: {
			title,
			original: originalLines.join("\n"),
			objective: objectiveLines.join("\n"),
			criteria,
			constraints,
			claims,
			decisions,
			machine,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { slugifyTitle };
