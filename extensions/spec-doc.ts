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
	contractVersion?: number;
	taskKind?: string;
	profile?: string;
	inputs?: Array<{ uri: string; description: string; mediaType?: string; required?: boolean }>;
	outputs?: Array<{ uri: string; description: string; mediaType?: string; required?: boolean }>;
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
	/** Headless 蓝图（见 docs/design/2026-08-06-headless-goal-blueprint.md）。 */
	blueprint?: HeadlessBlueprint;
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
	/** 深层目标（设计/架构/多子系统）的实现结构理解：模块划分、数据流、
	 *  关键路径、契约、失败模式。markdown 原样保留，供用户在文档里直接微调。 */
	structure?: string;
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
		// 只认二级标题（## X）作为段落边界，允许段落内含 ### 子标题（如实现结构）。
		if (/^##\s+\S/.test(line)) break;
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
	/** 深层目标的实现结构理解（markdown 原样）。 */
	structure?: string;
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
	if (input.structure && input.structure.trim()) {
		lines.push("## 实现结构");
		lines.push("");
		lines.push(input.structure.trim());
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

	const structureLines = sectionLines(lines, "实现结构").map((line) => line.trim());
	const structure = structureLines.filter(Boolean).join("\n") || undefined;

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
			...(structure ? { structure } : {}),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { slugifyTitle };

// ═══════════════════════════════════════════════════════════════════
// Headless Blueprint（机器块扩展）
// ═══════════════════════════════════════════════════════════════════
// 设计见 docs/design/2026-08-06-headless-goal-blueprint.md。
// 纯函数、无 IO：parseBlueprint 只做形状 + 蓝图内部交叉引用校验；
// 与 criteria/claims 的交叉校验和信任门（verifyCommand）在 headless.ts 的
// validateBlueprint 完成。

/** 与 pi-roles spawn_role roleDef / dag_execute node.roleDef 对齐的临时角色定义。 */
export interface BlueprintRoleDef {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	maxTurns?: number;
	model?: string;
	thinkingLevel?: string;
}

export interface BlueprintDagNode {
	id: string;
	task: string;
	/** 引用 execution.roleDefs 里的名字；与 role 二选一或都不填（主 agent 执行）。 */
	roleDef?: string;
	/** 已注册角色目录里的角色名（与 roleDef 二选一）。 */
	role?: string;
	expected_output?: string;
	consumers?: string[];
	depends_on?: string[];
	write_scope?: string[];
}

export interface BlueprintDag {
	nodes: BlueprintDagNode[];
	maxConcurrent?: number;
}

/** 每条 criterion/claim 的证据期望（诊断级，不阻塞完成）。 */
export interface BlueprintEvidenceExpectation {
	id: string;
	kinds?: string[];
	minCount?: number;
	verification?: "verified" | "unverified";
	note?: string;
}

/** 蓝图节点（DAG 节点或 roleDef 名）必须产出某类证据挂到某条 criterion。 */
export interface BlueprintNodeEvidence {
	id: string;
	evidenceKind: string;
	attachTo: string;
}

export interface BlueprintReview {
	requirement?: "none" | "advisory" | "required";
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	checklist: string[];
	maxTurns?: number;
}

export interface BlueprintVerification {
	command: string;
	timeoutMs?: number;
}

export interface BlueprintBudget {
	tokens?: number;
}

export interface BlueprintCompletion {
	policy?: "legacy" | "shadow" | "v2";
	maxAutoTurns?: number;
}

export interface HeadlessBlueprint {
	entry?: { prompt?: string };
	execution: {
		topology: "direct" | "specialist" | "team";
		/** specialist 时已注册目录里的角色名。 */
		role?: string;
		roleDefs?: BlueprintRoleDef[];
		dag?: BlueprintDag;
	};
	evidence?: {
		criteria?: BlueprintEvidenceExpectation[];
		nodes?: BlueprintNodeEvidence[];
	};
	review?: BlueprintReview;
	verification?: BlueprintVerification;
	budget?: BlueprintBudget;
	completion?: BlueprintCompletion;
}

export type ParseBlueprintResult =
	| { ok: true; blueprint: HeadlessBlueprint }
	| { ok: false; errors: string[] };

const BLUEPRINT_TOPOLOGIES = new Set(["direct", "specialist", "team"]);
const BLUEPRINT_REVIEW_REQUIREMENTS = new Set(["none", "advisory", "required"]);
const BLUEPRINT_POLICIES = new Set(["legacy", "shadow", "v2"]);

function shapeError(errors: string[], field: string, message: string): void {
	errors.push(field + " " + message);
}

function parseRoleDefs(value: unknown, errors: string[]): BlueprintRoleDef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		shapeError(errors, "blueprint.execution.roleDefs", "must be an array");
		return [];
	}
	const names = new Set<string>();
	const roleDefs: BlueprintRoleDef[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) {
			shapeError(errors, `blueprint.execution.roleDefs[${index}]`, "must be an object");
			continue;
		}
		const name = typeof raw.name === "string" ? raw.name.trim() : "";
		const description = typeof raw.description === "string" ? raw.description.trim() : "";
		const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
		if (!name) shapeError(errors, `blueprint.execution.roleDefs[${index}].name`, "is required");
		if (!description) shapeError(errors, `blueprint.execution.roleDefs[${index}].description`, "is required");
		if (!prompt) shapeError(errors, `blueprint.execution.roleDefs[${index}].prompt`, "is required");
		if (name && names.has(name)) shapeError(errors, `blueprint.execution.roleDefs[${index}].name`, `duplicates ${name}`);
		if (name) names.add(name);
		if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.some((tool) => typeof tool !== "string" || !tool.trim()))) {
			shapeError(errors, `blueprint.execution.roleDefs[${index}].tools`, "must be an array of non-empty strings");
		}
		if (raw.maxTurns !== undefined && (typeof raw.maxTurns !== "number" || !Number.isInteger(raw.maxTurns) || raw.maxTurns <= 0)) {
			shapeError(errors, `blueprint.execution.roleDefs[${index}].maxTurns`, "must be a positive integer");
		}
		if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model.trim())) {
			shapeError(errors, `blueprint.execution.roleDefs[${index}].model`, "must be a non-empty string");
		}
		if (raw.thinkingLevel !== undefined && (typeof raw.thinkingLevel !== "string" || !raw.thinkingLevel.trim())) {
			shapeError(errors, `blueprint.execution.roleDefs[${index}].thinkingLevel`, "must be a non-empty string");
		}
		const tools = raw.tools !== undefined && Array.isArray(raw.tools) && raw.tools.every((tool) => typeof tool === "string" && tool.trim())
			? raw.tools.map((tool: unknown) => String(tool).trim())
			: undefined;
		const maxTurns = typeof raw.maxTurns === "number" && Number.isInteger(raw.maxTurns) && raw.maxTurns > 0 ? raw.maxTurns : undefined;
		const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
		const thinkingLevel = typeof raw.thinkingLevel === "string" && raw.thinkingLevel.trim() ? raw.thinkingLevel.trim() : undefined;
		roleDefs.push({
			name,
			description,
			prompt,
			...(tools ? { tools } : {}),
			...(maxTurns !== undefined ? { maxTurns } : {}),
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
		});
	}
	return roleDefs;
}

function parseDag(value: unknown, roleDefNames: Set<string>, errors: string[]): BlueprintDag | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Array.isArray(value.nodes)) {
		shapeError(errors, "blueprint.execution.dag", "must be an object with a nodes array");
		return undefined;
	}
	const maxConcurrent = typeof value.maxConcurrent === "number" && Number.isInteger(value.maxConcurrent) && value.maxConcurrent > 0 ? value.maxConcurrent : undefined;
	if (value.maxConcurrent !== undefined && maxConcurrent === undefined) {
		shapeError(errors, "blueprint.execution.dag.maxConcurrent", "must be a positive integer");
	}
	const nodeIds = new Set<string>();
	const nodes: BlueprintDagNode[] = [];
	// 两趟：先收集全部 id 与节点，再校验引用（允许前向引用）。
	for (const [index, raw] of value.nodes.entries()) {
		if (!isRecord(raw)) {
			shapeError(errors, `blueprint.execution.dag.nodes[${index}]`, "must be an object");
			continue;
		}
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) shapeError(errors, `blueprint.execution.dag.nodes[${index}].id`, "is required");
		if (id && nodeIds.has(id)) shapeError(errors, `blueprint.execution.dag.nodes[${index}].id`, `duplicates ${id}`);
		if (id) nodeIds.add(id);
	}
	for (const [index, raw] of value.nodes.entries()) {
		if (!isRecord(raw)) {
			shapeError(errors, `blueprint.execution.dag.nodes[${index}]`, "must be an object");
			continue;
		}
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		const task = typeof raw.task === "string" ? raw.task.trim() : "";
		const roleDef = typeof raw.roleDef === "string" ? raw.roleDef.trim() : undefined;
		const role = typeof raw.role === "string" ? raw.role.trim() : undefined;
		if (!task) shapeError(errors, `blueprint.execution.dag.nodes[${index}].task`, "is required");
		if (roleDef && role) shapeError(errors, `blueprint.execution.dag.nodes[${index}]`, "roleDef and role are mutually exclusive");
		if (roleDef && !roleDefNames.has(roleDef)) {
			shapeError(errors, `blueprint.execution.dag.nodes[${index}].roleDef`, `references unknown roleDef ${roleDef}`);
		}
		const refArray = (field: string): string[] | undefined => {
			const rawValue = raw[field];
			if (rawValue === undefined) return undefined;
			if (!Array.isArray(rawValue) || rawValue.some((item) => typeof item !== "string" || !item.trim())) {
				shapeError(errors, `blueprint.execution.dag.nodes[${index}].${field}`, "must be an array of non-empty strings");
				return undefined;
			}
			return rawValue.map((item: unknown) => String(item).trim());
		};
		const consumers = refArray("consumers");
		const dependsOn = refArray("depends_on");
		const writeScope = refArray("write_scope");
		for (const consumer of consumers ?? []) {
			if (consumer !== "$result" && !nodeIds.has(consumer)) {
				shapeError(errors, `blueprint.execution.dag.nodes[${index}].consumers`, `references unknown node ${consumer}`);
			}
		}
		for (const dependency of dependsOn ?? []) {
			if (!nodeIds.has(dependency)) {
				shapeError(errors, `blueprint.execution.dag.nodes[${index}].depends_on`, `references unknown node ${dependency}`);
			}
		}
		nodes.push({
			id,
			task,
			...(roleDef ? { roleDef } : {}),
			...(role ? { role } : {}),
			...(typeof raw.expected_output === "string" && raw.expected_output.trim() ? { expected_output: raw.expected_output.trim() } : {}),
			...(consumers ? { consumers } : {}),
			...(dependsOn ? { depends_on: dependsOn } : {}),
			...(writeScope ? { write_scope: writeScope } : {}),
		});
	}
	return { nodes, ...(maxConcurrent !== undefined ? { maxConcurrent } : {}) };
}

function parseEvidenceExpectations(value: unknown, errors: string[]): BlueprintEvidenceExpectation[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		shapeError(errors, "blueprint.evidence.criteria", "must be an array");
		return [];
	}
	const ids = new Set<string>();
	const result: BlueprintEvidenceExpectation[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) {
			shapeError(errors, `blueprint.evidence.criteria[${index}]`, "must be an object");
			continue;
		}
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) shapeError(errors, `blueprint.evidence.criteria[${index}].id`, "is required");
		if (id && ids.has(id)) shapeError(errors, `blueprint.evidence.criteria[${index}].id`, `duplicates ${id}`);
		if (id) ids.add(id);
		const rawKinds = raw.kinds;
		const kinds = Array.isArray(rawKinds) && rawKinds.every((item) => typeof item === "string" && item.trim())
			? rawKinds.map((item: unknown) => String(item).trim())
			: undefined;
		if (rawKinds !== undefined && kinds === undefined) {
			shapeError(errors, `blueprint.evidence.criteria[${index}].kinds`, "must be an array of non-empty strings");
		}
		const minCount = typeof raw.minCount === "number" && Number.isInteger(raw.minCount) && raw.minCount > 0 ? raw.minCount : undefined;
		if (raw.minCount !== undefined && minCount === undefined) {
			shapeError(errors, `blueprint.evidence.criteria[${index}].minCount`, "must be a positive integer");
		}
		const verification = raw.verification === "verified" || raw.verification === "unverified" ? raw.verification : undefined;
		if (raw.verification !== undefined && verification === undefined) {
			shapeError(errors, `blueprint.evidence.criteria[${index}].verification`, "must be verified or unverified");
		}
		const note = typeof raw.note === "string" ? raw.note : undefined;
		if (raw.note !== undefined && note === undefined) {
			shapeError(errors, `blueprint.evidence.criteria[${index}].note`, "must be a string");
		}
		result.push({
			id,
			...(kinds ? { kinds } : {}),
			...(minCount !== undefined ? { minCount } : {}),
			...(verification ? { verification } : {}),
			...(note !== undefined ? { note } : {}),
		});
	}
	return result;
}

function parseNodeEvidence(value: unknown, nodeOrRoleNames: Set<string>, errors: string[]): BlueprintNodeEvidence[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		shapeError(errors, "blueprint.evidence.nodes", "must be an array");
		return [];
	}
	const result: BlueprintNodeEvidence[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isRecord(raw)) {
			shapeError(errors, `blueprint.evidence.nodes[${index}]`, "must be an object");
			continue;
		}
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		const evidenceKind = typeof raw.evidenceKind === "string" ? raw.evidenceKind.trim() : "";
		const attachTo = typeof raw.attachTo === "string" ? raw.attachTo.trim() : "";
		if (!id) shapeError(errors, `blueprint.evidence.nodes[${index}].id`, "is required");
		if (!evidenceKind) shapeError(errors, `blueprint.evidence.nodes[${index}].evidenceKind`, "is required");
		if (!attachTo) shapeError(errors, `blueprint.evidence.nodes[${index}].attachTo`, "is required");
		if (id && !nodeOrRoleNames.has(id)) {
			shapeError(errors, `blueprint.evidence.nodes[${index}].id`, `references unknown node/roleDef ${id}`);
		}
		result.push({ id, evidenceKind, attachTo });
	}
	return result;
}

/** 从 machine 机器块解析 HeadlessBlueprint（形状 + 蓝图内部交叉引用）。 */
export function parseBlueprint(value: unknown): ParseBlueprintResult {
	const errors: string[] = [];
	if (value === undefined) return { ok: true, blueprint: { execution: { topology: "direct" } } };
	if (!isRecord(value)) return { ok: false, errors: ["blueprint must be an object"] };

	const execution = isRecord(value.execution) ? value.execution : {};
	const topology = execution.topology === undefined
		? "direct"
		: typeof execution.topology === "string" && BLUEPRINT_TOPOLOGIES.has(execution.topology)
			? execution.topology as "direct" | "specialist" | "team"
			: (shapeError(errors, "blueprint.execution.topology", "must be direct, specialist, or team"), "direct");
	const roleDefs = parseRoleDefs(execution.roleDefs, errors);
	const roleDefNames = new Set(roleDefs.map((roleDef) => roleDef.name));
	const dag = parseDag(execution.dag, roleDefNames, errors);
	const role = typeof execution.role === "string" && execution.role.trim() ? execution.role.trim() : undefined;
	if (topology !== "specialist" && execution.role !== undefined && !role) {
		shapeError(errors, "blueprint.execution.role", "must be a non-empty string");
	}

	const evidenceValue = isRecord(value.evidence) ? value.evidence : value.evidence !== undefined ? (shapeError(errors, "blueprint.evidence", "must be an object"), {}) : {};
	const nodeOrRoleNames = new Set([...(dag?.nodes ?? []).map((node) => node.id), ...roleDefNames]);
	const criteriaExpectations = parseEvidenceExpectations(evidenceValue.criteria, errors);
	const nodeEvidence = parseNodeEvidence(evidenceValue.nodes, nodeOrRoleNames, errors);

	let review: BlueprintReview | undefined;
	if (value.review !== undefined) {
		if (!isRecord(value.review)) {
			shapeError(errors, "blueprint.review", "must be an object");
		} else {
			const requirement = value.review.requirement === undefined
				? undefined
				: typeof value.review.requirement === "string" && BLUEPRINT_REVIEW_REQUIREMENTS.has(value.review.requirement)
					? value.review.requirement as "none" | "advisory" | "required"
					: (shapeError(errors, "blueprint.review.requirement", "must be none, advisory, or required"), undefined);
			const rawReviewMaxTurns = value.review.maxTurns;
			const reviewMaxTurns = typeof rawReviewMaxTurns === "number" && Number.isInteger(rawReviewMaxTurns) && rawReviewMaxTurns > 0 ? rawReviewMaxTurns : undefined;
			if (rawReviewMaxTurns !== undefined && reviewMaxTurns === undefined) {
				shapeError(errors, "blueprint.review.maxTurns", "must be a positive integer");
			}
			if (value.review.checklist !== undefined && (!Array.isArray(value.review.checklist) || value.review.checklist.some((item) => typeof item !== "string"))) {
				shapeError(errors, "blueprint.review.checklist", "must be an array of strings");
			}
			review = {
				...(requirement ? { requirement } : {}),
				...(typeof value.review.model === "string" && value.review.model.trim() ? { model: value.review.model.trim() } : {}),
				...(typeof value.review.thinkingLevel === "string" && value.review.thinkingLevel.trim() ? { thinkingLevel: value.review.thinkingLevel.trim() } : {}),
				...(Array.isArray(value.review.tools) ? { tools: value.review.tools.map((item: unknown) => String(item).trim()) } : {}),
				checklist: Array.isArray(value.review.checklist) ? value.review.checklist.map((item: unknown) => String(item)) : [],
				...(reviewMaxTurns !== undefined ? { maxTurns: reviewMaxTurns } : {}),
			};
		}
	}

	let verification: BlueprintVerification | undefined;
	if (value.verification !== undefined) {
		if (!isRecord(value.verification)) {
			shapeError(errors, "blueprint.verification", "must be an object");
		} else {
			const command = typeof value.verification.command === "string" ? value.verification.command.trim() : "";
			if (!command) shapeError(errors, "blueprint.verification.command", "is required");
			const rawTimeoutMs = value.verification.timeoutMs;
			const timeoutMs = typeof rawTimeoutMs === "number" && rawTimeoutMs > 0 ? rawTimeoutMs : undefined;
			if (rawTimeoutMs !== undefined && timeoutMs === undefined) {
				shapeError(errors, "blueprint.verification.timeoutMs", "must be a positive number");
			}
			verification = { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
		}
	}

	let budget: BlueprintBudget | undefined;
	if (value.budget !== undefined) {
		if (!isRecord(value.budget)) {
			shapeError(errors, "blueprint.budget", "must be an object");
		} else {
			const rawTokens = value.budget.tokens;
			const tokens = typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0 ? rawTokens : undefined;
			if (rawTokens !== undefined && tokens === undefined) {
				shapeError(errors, "blueprint.budget.tokens", "must be a positive number");
			}
			budget = tokens !== undefined ? { tokens } : {};
		}
	}

	let completion: BlueprintCompletion | undefined;
	if (value.completion !== undefined) {
		if (!isRecord(value.completion)) {
			shapeError(errors, "blueprint.completion", "must be an object");
		} else {
			const policy = value.completion.policy === undefined
				? undefined
				: typeof value.completion.policy === "string" && BLUEPRINT_POLICIES.has(value.completion.policy)
					? value.completion.policy as "legacy" | "shadow" | "v2"
					: (shapeError(errors, "blueprint.completion.policy", "must be legacy, shadow, or v2"), undefined);
			const rawAutoTurns = value.completion.maxAutoTurns;
			const maxAutoTurns = typeof rawAutoTurns === "number" && Number.isInteger(rawAutoTurns) && rawAutoTurns > 0 ? rawAutoTurns : undefined;
			if (rawAutoTurns !== undefined && maxAutoTurns === undefined) {
				shapeError(errors, "blueprint.completion.maxAutoTurns", "must be a positive integer");
			}
			completion = {
				...(policy ? { policy } : {}),
				...(maxAutoTurns !== undefined ? { maxAutoTurns } : {}),
			};
		}
	}

	let entry: { prompt?: string } | undefined;
	if (value.entry !== undefined) {
		if (!isRecord(value.entry)) {
			shapeError(errors, "blueprint.entry", "must be an object");
		} else if (typeof value.entry.prompt === "string" && value.entry.prompt.trim()) {
			entry = { prompt: value.entry.prompt.trim() };
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	const blueprint: HeadlessBlueprint = {
		...(entry ? { entry } : {}),
		execution: {
			topology,
			...(role ? { role } : {}),
			...(roleDefs.length > 0 ? { roleDefs } : {}),
			...(dag ? { dag } : {}),
		},
		...(criteriaExpectations.length > 0 || nodeEvidence.length > 0 ? {
			evidence: {
				...(criteriaExpectations.length > 0 ? { criteria: criteriaExpectations } : {}),
				...(nodeEvidence.length > 0 ? { nodes: nodeEvidence } : {}),
			},
		} : {}),
		...(review ? { review } : {}),
		...(verification ? { verification } : {}),
		...(budget && Object.keys(budget).length > 0 ? { budget } : {}),
		...(completion && Object.keys(completion).length > 0 ? { completion } : {}),
	};
	return { ok: true, blueprint };
}
