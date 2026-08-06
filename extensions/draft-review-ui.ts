import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseGoalSpecMarkdown, proposalToMarkdown, slugifyTitle, type SpecCriterion } from "./spec-doc";
import type { AssuranceDecision, ExecutionDecision, GateLevel, GoalCriterionV2, ResearchClaim } from "./state";
import type { TaskKind, ExecutionPreference } from "./config";

export interface GoalCriterionDraft {
	description: string;
	level: GateLevel;
}

export interface GoalProposal {
	objective: string;
	criteria: GoalCriterionDraft[];
	constraints: string[];
	taskKind: TaskKind;
	executionPreference: ExecutionPreference;
	execution: ExecutionDecision;
	assurance: AssuranceDecision;
	claims: ResearchClaim[];
	/** 澄清对话的 Q/A 轨迹（写入 spec 文档，供用户回溯）。 */
	decisions?: Array<{ question: string; answer: string }>;
	/** 深层目标（设计/架构/多子系统）的实现结构理解，原样进出 spec 文档。 */
	structure?: string;
}

export type ReviewResult = "start" | "edit" | "execution" | "cancel";

// ═══════════════════════════════════════════════════════════════════════
// Goal Spec 文档（md）— 完整理解的序列化/恢复
// ═══════════════════════════════════════════════════════════════════════

export function proposalToSpecInput(proposal: GoalProposal) {
	return {
		original: proposal.objective,
		objective: proposal.objective,
		criteria: proposal.criteria as SpecCriterion[],
		constraints: proposal.constraints,
		claims: proposal.claims.map((claim) => ({
			id: claim.id, text: claim.text, materiality: claim.materiality,
			...(claim.risk ? { risk: claim.risk } : {}),
			evidenceRefs: claim.evidenceRefs ?? [],
		})),
		...(proposal.decisions ? { decisions: proposal.decisions } : {}),
		...(proposal.structure ? { structure: proposal.structure } : {}),
		machine: {
			taskKind: proposal.taskKind,
			execution: {
				preference: proposal.execution.preference,
				selected: proposal.execution.selected,
				...(proposal.execution.role ? { role: proposal.execution.role } : {}),
				source: proposal.execution.source,
				reasons: proposal.execution.reasons,
			},
			assurance: {
				reviewRequirement: proposal.assurance.reviewRequirement,
				reviewStatus: proposal.assurance.reviewStatus,
				depth: proposal.assurance.depth,
				reasons: proposal.assurance.reasons,
			},
		},
	};
}

export function specDocToProposal(doc: NonNullable<ReturnType<typeof parseGoalSpecMarkdown>["doc"]>, base: GoalProposal): GoalProposal {
	const taskKind = (doc.machine.taskKind as TaskKind | undefined) ?? base.taskKind;
	const machineExecution = doc.machine.execution;
	const execution: ExecutionDecision = machineExecution?.selected
		? {
			preference: (machineExecution.preference as ExecutionPreference) ?? "auto",
			selected: machineExecution.selected as "direct" | "specialist" | "team",
			...(machineExecution.role ? { role: machineExecution.role } : {}),
			source: "user",
			confidence: 1,
			reasons: machineExecution.reasons ?? ["The user edited the goal spec document."],
			reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
		}
		: base.execution;
	const machineAssurance = doc.machine.assurance;
	const assurance: AssuranceDecision = machineAssurance?.reviewRequirement
		? {
			reviewRequirement: machineAssurance.reviewRequirement as AssuranceDecision["reviewRequirement"],
			reviewStatus: (machineAssurance.reviewStatus as AssuranceDecision["reviewStatus"]) ?? "pending",
			independent: machineAssurance.reviewRequirement !== "none",
			depth: (machineAssurance.depth as AssuranceDecision["depth"]) ?? "light",
			source: "user",
			reasons: machineAssurance.reasons ?? ["The user edited the goal spec document."],
			decidedAt: Date.now(),
		}
		: base.assurance;
	return {
		objective: doc.objective,
		criteria: doc.criteria.map((criterion) => ({ description: criterion.description, level: criterion.level })),
		constraints: doc.constraints,
		claims: doc.claims.map((claim) => ({
			id: claim.id, text: claim.text, materiality: claim.materiality,
			...(claim.risk ? { risk: claim.risk } : {}),
			evidenceRefs: [],
		})),
		taskKind,
		executionPreference: machineExecution?.preference as ExecutionPreference | undefined ?? base.executionPreference,
		execution,
		assurance,
		decisions: doc.decisions,
		...(doc.structure ? { structure: doc.structure } : {}),
	};
}

export function writeGoalSpecDoc(proposal: GoalProposal, ctx: ExtensionContext, specDir: string | undefined, now: () => number): string | null {
	try {
		const dir = specDir ?? "docs/goals";
		const absoluteDir = path.isAbsolute(dir) ? dir : path.join(ctx.cwd, dir);
		fs.mkdirSync(absoluteDir, { recursive: true });
		const fileName = slugifyTitle(proposal.objective) + "-goal.md";
		const md = proposalToMarkdown({ ...proposalToSpecInput(proposal), createdAt: now() });
		fs.writeFileSync(path.join(absoluteDir, fileName), md, "utf8");
		return path.join(dir, fileName);
	} catch (error) {
		console.warn("[pi-goal] failed to write goal spec doc:", error);
		return null;
	}
}

export async function showGoalReview(
	proposal: GoalProposal,
	ctx: ExtensionContext,
): Promise<ReviewResult> {
	const items: SelectItem[] = [
		{ value: "start", label: "Start — begin working toward this goal" },
		{ value: "edit", label: "Edit — modify the objective or criteria" },
		{ value: "execution", label: "Execution — change auto/direct/specialist/team" },
		{ value: "cancel", label: "Cancel — discard this draft" },
	];

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const headerBorder = new DynamicBorder((s) => theme.fg("accent", s));
		container.addChild(headerBorder);
		container.addChild(new Text(theme.fg("accent", theme.bold(" Goal Draft Review "))));
		container.addChild(new Text(""));
		container.addChild(new Text(theme.fg("accent", theme.bold("Objective:"))));
		container.addChild(new Text(theme.fg("text", "  " + proposal.objective)));
		container.addChild(new Text(""));
		container.addChild(new Text(theme.fg("accent", theme.bold("Route:"))));
		container.addChild(new Text(theme.fg("text", "  " + proposal.taskKind + " · " + proposal.execution.selected + (proposal.execution.role ? " · " + proposal.execution.role : ""))));
		for (const reason of proposal.execution.reasons) container.addChild(new Text(theme.fg("dim", "  " + reason)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Assurance:"))));
		container.addChild(new Text(theme.fg("text", "  " + proposal.assurance.reviewRequirement + " · " + proposal.assurance.depth)));
		for (const reason of proposal.assurance.reasons) container.addChild(new Text(theme.fg("dim", "  " + reason)));
		container.addChild(new Text(""));

		if (proposal.decisions && proposal.decisions.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Clarifications:"))));
			for (const decision of proposal.decisions) {
				container.addChild(new Text(theme.fg("dim", "  Q: " + decision.question)));
				container.addChild(new Text(theme.fg("dim", "  A: " + decision.answer)));
			}
			container.addChild(new Text(""));
		}
		if (proposal.criteria.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Acceptance Criteria:"))));
			for (const c of proposal.criteria) {
				container.addChild(new Text(theme.fg("dim", "  \u2610 [" + c.level + "] " + c.description)));
			}
			container.addChild(new Text(""));
		}
		if (proposal.constraints.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Constraints:"))));
			for (const c of proposal.constraints) {
				container.addChild(new Text(theme.fg("dim", "  \u2022 " + c)));
			}
			container.addChild(new Text(""));
		}
		if (proposal.claims.length > 0) {
			container.addChild(new Text(theme.fg("accent", theme.bold("Research Claims:"))));
			for (const claim of proposal.claims) {
				container.addChild(new Text(theme.fg("dim", "  " + claim.id + " [" + claim.materiality + (claim.risk ? " · " + claim.risk : "") + "] " + claim.text)));
			}
			container.addChild(new Text(""));
		}

		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(""));
		container.addChild(new Text(theme.fg("dim", "  Enter: confirm  Esc: cancel")));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
		};
	});

	return (choice as ReviewResult) ?? "cancel";
}

