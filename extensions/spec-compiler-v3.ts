import {
	parseBlueprint,
	parseGoalSpecMarkdown,
	proposalToMarkdown,
	type BlueprintBudget,
	type BlueprintCompletion,
	type BlueprintEvidenceExpectation,
	type BlueprintNodeEvidence,
	type BlueprintReview,
	type BlueprintRetry,
	type BlueprintVerification,
	type GoalSpecDoc,
	type HeadlessBlueprint,
	type SpecClaim,
	type SpecCriterion,
} from "./spec-doc";
import { TASK_KINDS, type TaskKind } from "./state";

export const GOAL_PROJECT_SPEC_VERSION = 3 as const;

export interface GoalProjectArtifactSpecV3 {
	uri: string;
	description: string;
	mediaType?: string;
	required?: boolean;
}

export interface GoalProjectSpecV3 {
	schemaVersion: typeof GOAL_PROJECT_SPEC_VERSION;
	objective: string;
	original?: string;
	criteria: Array<SpecCriterion & { id?: string }>;
	constraints?: string[];
	claims?: SpecClaim[];
	taskKind?: string;
	profile?: string;
	inputs?: GoalProjectArtifactSpecV3[];
	outputs?: GoalProjectArtifactSpecV3[];
	instructions?: string;
	execution?: HeadlessBlueprint["execution"];
	evidence?: {
		criteria?: BlueprintEvidenceExpectation[];
		nodes?: BlueprintNodeEvidence[];
	};
	review?: BlueprintReview;
	verification?: BlueprintVerification;
	budget?: BlueprintBudget;
	retry?: BlueprintRetry;
	completion?: Omit<BlueprintCompletion, "policy">;
}

export interface GoalSpecLintIssueV3 {
	path: string;
	code: "required" | "invalid" | "duplicate" | "unknown_reference" | "legacy_protocol";
	severity: "error" | "warning";
	message: string;
}

export type ParseGoalProjectSpecResultV3 =
	| { ok: true; spec: GoalProjectSpecV3; issues: GoalSpecLintIssueV3[] }
	| { ok: false; issues: GoalSpecLintIssueV3[] };

export interface CompiledGoalSpecV3 {
	contractVersion: typeof GOAL_PROJECT_SPEC_VERSION;
	source: GoalProjectSpecV3;
	doc: GoalSpecDoc;
	markdown: string;
	issues: GoalSpecLintIssueV3[];
}

export interface MigratedGoalSpecV3 {
	sourceVersion: 2;
	spec: GoalProjectSpecV3;
	warnings: GoalSpecLintIssueV3[];
}

const LEGACY_PROTOCOL_MARKERS = [
	"request_completion",
	"record_review",
	"reviewersession",
	"sessionfile",
	"ready/not ready",
	"✅ ready",
	"❌ not ready",
];

export function parseGoalProjectSpecV3(value: unknown): ParseGoalProjectSpecResultV3 {
	const issues: GoalSpecLintIssueV3[] = [];
	if (!isRecord(value)) {
		return { ok: false, issues: [issue("$", "invalid", "error", "Goal project spec must be an object.")] };
	}
	if (value.schemaVersion !== GOAL_PROJECT_SPEC_VERSION) {
		issues.push(issue("schemaVersion", "invalid", "error", "schemaVersion must be 3."));
	}
	const objective = requiredString(value.objective, "objective", issues);
	const criteria = parseCriteria(value.criteria, issues);
	const constraints = stringArray(value.constraints, "constraints", issues, true);
	const claims = parseClaims(value.claims, issues);
	const taskKind = optionalString(value.taskKind, "taskKind", issues);
	if (taskKind && !TASK_KINDS.includes(taskKind as TaskKind)) {
		issues.push(issue("taskKind", "invalid", "error", `taskKind must be one of: ${TASK_KINDS.join(", ")}.`));
	}
	const profile = optionalString(value.profile, "profile", issues);
	const inputs = parseArtifacts(value.inputs, "inputs", issues);
	const outputs = parseArtifacts(value.outputs, "outputs", issues);
	const instructions = optionalString(value.instructions, "instructions", issues);
	const original = optionalString(value.original, "original", issues);

	const rawBlueprint: Record<string, unknown> = {
		execution: value.execution ?? { topology: "direct" },
		...(value.evidence === undefined ? {} : { evidence: value.evidence }),
		...(value.review === undefined ? {} : { review: value.review }),
		...(value.verification === undefined ? {} : { verification: value.verification }),
		...(value.budget === undefined ? {} : { budget: value.budget }),
		...(value.retry === undefined ? {} : { retry: value.retry }),
		...(value.completion === undefined ? {} : { completion: { ...(isRecord(value.completion) ? value.completion : {}), policy: "v2" } }),
	};
	const parsedBlueprint = parseBlueprint(rawBlueprint);
	if (!parsedBlueprint.ok) {
		for (const message of parsedBlueprint.errors) {
			issues.push(issue("blueprint", "invalid", "error", message));
		}
	}
	if (instructions && containsLegacyProtocol(instructions)) {
		issues.push(issue(
			"instructions",
			"legacy_protocol",
			"error",
			"Project instructions must not restate reviewer/session/completion protocol; the compiler injects it.",
		));
	}
	const errors = issues.filter((entry) => entry.severity === "error");
	if (errors.length > 0 || !parsedBlueprint.ok || !objective || criteria.length === 0) return { ok: false, issues };
	return {
		ok: true,
		issues,
		spec: {
			schemaVersion: GOAL_PROJECT_SPEC_VERSION,
			objective,
			criteria,
			...(original ? { original } : {}),
			...(constraints.length > 0 ? { constraints } : {}),
			...(claims.length > 0 ? { claims } : {}),
			...(taskKind ? { taskKind } : {}),
			...(profile ? { profile } : {}),
			...(inputs.length > 0 ? { inputs } : {}),
			...(outputs.length > 0 ? { outputs } : {}),
			...(instructions ? { instructions } : {}),
			execution: parsedBlueprint.blueprint.execution,
			...(parsedBlueprint.blueprint.evidence ? { evidence: parsedBlueprint.blueprint.evidence } : {}),
			...(parsedBlueprint.blueprint.review ? { review: parsedBlueprint.blueprint.review } : {}),
			...(parsedBlueprint.blueprint.verification ? { verification: parsedBlueprint.blueprint.verification } : {}),
			...(parsedBlueprint.blueprint.budget ? { budget: parsedBlueprint.blueprint.budget } : {}),
			...(parsedBlueprint.blueprint.retry ? { retry: parsedBlueprint.blueprint.retry } : {}),
			...(parsedBlueprint.blueprint.completion ? { completion: { maxAutoTurns: parsedBlueprint.blueprint.completion.maxAutoTurns } } : {}),
		},
	};
}

export function compileGoalProjectSpecV3(value: unknown): CompiledGoalSpecV3 {
	const parsed = parseGoalProjectSpecV3(value);
	if (!parsed.ok) throw new GoalSpecCompileError(parsed.issues);
	const source = parsed.spec;
	const blueprint: HeadlessBlueprint = {
		entry: { prompt: buildContractV3EntryPrompt(source) },
		execution: source.execution ?? { topology: "direct" },
		...(source.evidence ? { evidence: source.evidence } : {}),
		...(source.review ? { review: source.review } : {}),
		...(source.verification ? { verification: source.verification } : {}),
		...(source.budget ? { budget: source.budget } : {}),
		...(source.retry ? { retry: source.retry } : {}),
		completion: { policy: "v2", ...(source.completion ?? {}) },
	};
	const doc: GoalSpecDoc = {
		title: source.objective.replace(/\s+/g, " ").slice(0, 60) || "Goal",
		original: source.original ?? source.objective,
		objective: source.objective,
		criteria: source.criteria.map(({ description, level }) => ({ description, level })),
		constraints: [...(source.constraints ?? [])],
		claims: [...(source.claims ?? [])],
		decisions: [],
		machine: {
			contractVersion: GOAL_PROJECT_SPEC_VERSION,
			...(source.taskKind ? { taskKind: source.taskKind } : {}),
			...(source.profile ? { profile: source.profile } : {}),
			...(source.inputs ? { inputs: source.inputs } : {}),
			...(source.outputs ? { outputs: source.outputs } : {}),
			blueprint,
		},
	};
	return {
		contractVersion: GOAL_PROJECT_SPEC_VERSION,
		source,
		doc,
		markdown: proposalToMarkdown(doc),
		issues: parsed.issues,
	};
}

export function migrateGoalSpecMarkdownV2ToV3(markdown: string): MigratedGoalSpecV3 {
	const parsed = parseGoalSpecMarkdown(markdown);
	if (!parsed.ok || !parsed.doc) {
		throw new Error(parsed.error ?? "Goal V2 spec could not be parsed.");
	}
	const blueprintResult = parseBlueprint(parsed.doc.machine.blueprint);
	if (!blueprintResult.ok) throw new Error(blueprintResult.errors.join("\n"));
	const blueprint = blueprintResult.blueprint;
	const warnings: GoalSpecLintIssueV3[] = [];
	const legacyPrompt = blueprint.entry?.prompt?.trim();
	const instructions = legacyPrompt && !containsLegacyProtocol(legacyPrompt) ? legacyPrompt : undefined;
	if (legacyPrompt && containsLegacyProtocol(legacyPrompt)) {
		warnings.push(issue(
			"machine.blueprint.entry.prompt",
			"legacy_protocol",
			"warning",
			"The V2 entry prompt contained session/reviewer/completion protocol and was omitted. Re-add only domain instructions after reviewing the semantic diff.",
		));
	}
	return {
		sourceVersion: 2,
		warnings,
		spec: {
			schemaVersion: GOAL_PROJECT_SPEC_VERSION,
			objective: parsed.doc.objective,
			...(parsed.doc.original ? { original: parsed.doc.original } : {}),
			criteria: parsed.doc.criteria.map((criterion, index) => ({ ...criterion, id: `c${index + 1}` })),
			...(parsed.doc.constraints.length > 0 ? { constraints: parsed.doc.constraints } : {}),
			...(parsed.doc.claims.length > 0 ? { claims: parsed.doc.claims } : {}),
			...(parsed.doc.machine.taskKind ? { taskKind: parsed.doc.machine.taskKind } : {}),
			...(instructions ? { instructions } : {}),
			execution: blueprint.execution,
			...(blueprint.evidence ? { evidence: blueprint.evidence } : {}),
			...(blueprint.review ? { review: blueprint.review } : {}),
			...(blueprint.verification ? { verification: blueprint.verification } : {}),
			...(blueprint.budget ? { budget: blueprint.budget } : {}),
			...(blueprint.retry ? { retry: blueprint.retry } : {}),
			...(blueprint.completion?.maxAutoTurns ? { completion: { maxAutoTurns: blueprint.completion.maxAutoTurns } } : {}),
		},
	};
}

export function buildContractV3EntryPrompt(spec: GoalProjectSpecV3): string {
	const lines = [
		"Execute the declared Goal Contract V3 outcome and constraints.",
		"Persist criterion and claim evidence with structured update_goal actions while working.",
	];
	if (spec.profile) lines.push(`Load the project profile named ${spec.profile} through the host's profile/policy layer; it is not a core runtime rule.`);
	for (const input of spec.inputs ?? []) lines.push(`Input${input.required === false ? " (optional)" : ""}: ${input.uri} - ${input.description}`);
	for (const output of spec.outputs ?? []) lines.push(`Output${output.required === false ? " (optional)" : ""}: ${output.uri} - ${output.description}`);
	if (spec.instructions) lines.push("Project instructions: " + spec.instructions);
	if ((spec.review?.requirement ?? "advisory") !== "none") {
		lines.push("At completion, compute lowercase SHA-256 digests and byte sizes for every submitted local artifact.");
		lines.push("Spawn the goal-reviewer role with the exact criteria, evidence IDs, deterministic check results, and artifact paths; use its returned immutable resultRef.");
		lines.push("Submit artifacts, evidence, checks, and reviewerResultRef atomically with update_goal action=submit_completion_bundle. Do not inspect child session files or use symbolic verdict text.");
	} else {
		lines.push("When blocking criteria are evidenced, request the configured deterministic completion evaluation with update_goal action=request_completion.");
	}
	return lines.join("\n");
}

export function containsLegacyProtocol(value: string): boolean {
	const normalized = value.toLowerCase();
	return LEGACY_PROTOCOL_MARKERS.some((marker) => normalized.includes(marker));
}

export class GoalSpecCompileError extends Error {
	constructor(public readonly issues: GoalSpecLintIssueV3[]) {
		super(issues.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
		this.name = "GoalSpecCompileError";
	}
}

function parseCriteria(value: unknown, issues: GoalSpecLintIssueV3[]): Array<SpecCriterion & { id?: string }> {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push(issue("criteria", "required", "error", "At least one criterion is required."));
		return [];
	}
	const ids = new Set<string>();
	return value.flatMap((entry, index) => {
		if (!isRecord(entry)) {
			issues.push(issue(`criteria[${index}]`, "invalid", "error", "Criterion must be an object."));
			return [];
		}
		const description = requiredString(entry.description, `criteria[${index}].description`, issues);
		const level = entry.level === undefined || entry.level === "blocking" ? "blocking" : entry.level === "advisory" ? "advisory" : null;
		if (!level) issues.push(issue(`criteria[${index}].level`, "invalid", "error", "level must be blocking or advisory."));
		const id = optionalString(entry.id, `criteria[${index}].id`, issues);
		if (id && ids.has(id)) issues.push(issue(`criteria[${index}].id`, "duplicate", "error", `Duplicate criterion id ${id}.`));
		if (id) ids.add(id);
		return description && level ? [{ description, level, ...(id ? { id } : {}) }] : [];
	});
}

function parseClaims(value: unknown, issues: GoalSpecLintIssueV3[]): SpecClaim[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push(issue("claims", "invalid", "error", "claims must be an array."));
		return [];
	}
	const ids = new Set<string>();
	return value.flatMap((entry, index) => {
		if (!isRecord(entry)) {
			issues.push(issue(`claims[${index}]`, "invalid", "error", "Claim must be an object."));
			return [];
		}
		const id = requiredString(entry.id, `claims[${index}].id`, issues);
		const text = requiredString(entry.text, `claims[${index}].text`, issues);
		const materiality = entry.materiality === "material" || entry.materiality === "supporting" ? entry.materiality : null;
		if (!materiality) issues.push(issue(`claims[${index}].materiality`, "invalid", "error", "materiality must be material or supporting."));
		if (id && ids.has(id)) issues.push(issue(`claims[${index}].id`, "duplicate", "error", `Duplicate claim id ${id}.`));
		if (id) ids.add(id);
		const risk = entry.risk === undefined || entry.risk === "ordinary" || entry.risk === "high" ? entry.risk : null;
		if (risk === null) issues.push(issue(`claims[${index}].risk`, "invalid", "error", "risk must be ordinary or high."));
		return id && text && materiality ? [{ id, text, materiality, ...(risk ? { risk } : {}), evidenceRefs: [] }] : [];
	});
}

function parseArtifacts(value: unknown, path: string, issues: GoalSpecLintIssueV3[]): GoalProjectArtifactSpecV3[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push(issue(path, "invalid", "error", `${path} must be an array.`));
		return [];
	}
	const uris = new Set<string>();
	return value.flatMap((entry, index) => {
		if (!isRecord(entry)) {
			issues.push(issue(`${path}[${index}]`, "invalid", "error", "Artifact declaration must be an object."));
			return [];
		}
		const uri = requiredString(entry.uri, `${path}[${index}].uri`, issues);
		const description = requiredString(entry.description, `${path}[${index}].description`, issues);
		const mediaType = optionalString(entry.mediaType, `${path}[${index}].mediaType`, issues);
		if (entry.required !== undefined && typeof entry.required !== "boolean") {
			issues.push(issue(`${path}[${index}].required`, "invalid", "error", "required must be boolean."));
		}
		if (uri && uris.has(uri)) issues.push(issue(`${path}[${index}].uri`, "duplicate", "error", `Duplicate artifact URI ${uri}.`));
		if (uri) uris.add(uri);
		return uri && description ? [{ uri, description, ...(mediaType ? { mediaType } : {}), ...(typeof entry.required === "boolean" ? { required: entry.required } : {}) }] : [];
	});
}

function stringArray(value: unknown, path: string, issues: GoalSpecLintIssueV3[], optional: boolean): string[] {
	if (value === undefined && optional) return [];
	if (!Array.isArray(value)) {
		issues.push(issue(path, "invalid", "error", `${path} must be an array of non-empty strings.`));
		return [];
	}
	return value.flatMap((entry, index) => {
		const parsed = requiredString(entry, `${path}[${index}]`, issues);
		return parsed ? [parsed] : [];
	});
}

function requiredString(value: unknown, path: string, issues: GoalSpecLintIssueV3[]): string {
	if (typeof value !== "string" || !value.trim()) {
		issues.push(issue(path, "required", "error", `${path} must be a non-empty string.`));
		return "";
	}
	return value.trim();
}

function optionalString(value: unknown, path: string, issues: GoalSpecLintIssueV3[]): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, path, issues) || undefined;
}

function issue(path: string, code: GoalSpecLintIssueV3["code"], severity: GoalSpecLintIssueV3["severity"], message: string): GoalSpecLintIssueV3 {
	return { path, code, severity, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
