import type { CompletionFinding, GoalStateV2 } from "./state";

export type OutcomeProgressStatus = "pending" | "evidenced" | "verified" | "blocked";
export type RuntimeActivityPhase = "idle" | "thinking" | "tool" | "specialist" | "dag" | "evaluating" | "waiting";

export interface OutcomeProgressItem {
	id: string;
	kind: "criterion" | "constraint" | "claim";
	label: string;
	level: "blocking" | "advisory";
	status: OutcomeProgressStatus;
	evidenceRefs: string[];
	reason?: string;
}

export interface OutcomeProgressCounts {
	total: number;
	pending: number;
	evidenced: number;
	verified: number;
	blocked: number;
}

export interface RuntimeToolActivity {
	toolCallId: string;
	toolName: string;
	label: string;
	role?: string;
	startedAt: number;
	updatedAt: number;
}

export interface DagRuntimeProgress {
	toolCallId: string;
	dagId: string;
	scheduler: "ready" | "wave" | "unknown";
	active: boolean;
	total: number;
	running: string[];
	ready: string[];
	blocked: string[];
	critical: string[];
	waitingOn: Record<string, string[]>;
	settled: number;
	completed: number;
	failed: number;
	skipped: number;
	generated: number;
	routes: number;
	termination?: "all_terminal" | "aborted" | "blocked";
	updatedAt: number;
}

export interface GoalRuntimeActivity {
	phase: RuntimeActivityPhase;
	label: string;
	turnStartedAt: number | null;
	tools: RuntimeToolActivity[];
	dag: DagRuntimeProgress | null;
	/** Active DAGs, or the most recent terminal DAG when none remain active. */
	dags: DagRuntimeProgress[];
	failures: Array<{ toolName: string; status: string; message: string; at: number }>;
	lastActivityAt: number;
	lastOutcomeDeltaAt: number;
}

export interface GoalProgressSnapshot {
	version: 1;
	goalId: string;
	status: GoalStateV2["status"];
	generatedAt: number;
	goal: {
		objective: string;
		taskKind: GoalStateV2["taskKind"];
	};
	route: {
		preference: GoalStateV2["execution"]["preference"];
		topology: GoalStateV2["execution"]["selected"];
		role?: string;
		confidence: number;
		reasons: string[];
	};
	outcomes: {
		revision: number;
		items: OutcomeProgressItem[];
		counts: OutcomeProgressCounts;
		blocking: { total: number; open: number; blocked: number };
	};
	activity: GoalRuntimeActivity;
	evidence: {
		total: number;
		verified: number;
		unverified: number;
		rejected: number;
		independentSources: number;
	};
	assurance: {
		requirement: GoalStateV2["assurance"]["reviewRequirement"];
		status: GoalStateV2["assurance"]["reviewStatus"];
		depth: GoalStateV2["assurance"]["depth"];
		reasons: string[];
		completionDecision: "accept" | "revise" | "blocked" | null;
		completionPending: boolean;
		evaluationFresh: boolean;
		blockingFindings: CompletionFinding[];
		advisories: string[];
	};
	health: {
		state: "healthy" | "attention" | "blocked";
		issues: Array<{ code: string; message: string; blocking: boolean }>;
		noProgressTurns: number;
		repeatedRejections: number;
		activityWithoutOutcomeMs: number;
	};
	resources: {
		tokensUsed: number;
		tokenBudget: number | null;
		activeMs: number;
		wallMs: number;
	};
	timestamps: {
		lastActivityAt: number;
		lastOutcomeDeltaAt: number;
	};
}

interface TrackerTool extends RuntimeToolActivity {
	args: unknown;
}

interface DagNodeLike {
	status?: unknown;
	deps?: unknown;
	route?: unknown;
	waitingOn?: unknown;
}

const TERMINAL_DAG_STATES = new Set(["completed", "failed", "skipped"]);
const DAG_STATES = new Set(["queued", "running", ...TERMINAL_DAG_STATES]);

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstLine(value: unknown): string | undefined {
	const text = stringValue(value);
	return text?.split(/\r?\n/, 1)[0]?.trim();
}

function shortText(value: string, max = 42): string {
	return value.length <= max ? value : value.slice(0, Math.max(0, max - 3)) + "...";
}

export function toolActivityLabel(toolName: string, args: unknown): { label: string; role?: string } {
	const input = objectValue(args) ?? {};
	if (toolName === "spawn_role") {
		const role = stringValue(input.role) ?? "specialist";
		return { label: "role " + shortText(role, 28), role };
	}
	if (toolName === "dag_execute" || toolName === "dag_resume") return { label: "DAG execution" };
	const locator = firstLine(input.path)
		?? firstLine(input.file_path)
		?? firstLine(input.query)
		?? firstLine(input.pattern);
	const readableName = toolName.replaceAll("_", " ");
	return { label: locator ? readableName + " " + shortText(locator) : readableName };
}

function nodeRecord(value: unknown): Record<string, DagNodeLike> {
	const object = objectValue(value);
	if (!object) return {};
	const nodes: Record<string, DagNodeLike> = {};
	for (const [id, node] of Object.entries(object)) {
		const parsed = objectValue(node);
		if (parsed) nodes[id] = parsed;
	}
	return nodes;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function collectNodeStatuses(nodes: Record<string, DagNodeLike>): Map<string, string> {
	const statuses = new Map<string, string>();
	for (const [id, node] of Object.entries(nodes)) {
		const candidate = stringValue(objectValue(node)?.status);
		statuses.set(id, candidate && DAG_STATES.has(candidate) ? candidate : "queued");
	}
	return statuses;
}

function depsOf(node: DagNodeLike | undefined, originalNode: unknown): string[] {
	const direct = stringList(objectValue(node)?.deps);
	return direct.length > 0 ? direct : stringList(objectValue(originalNode)?.depends_on);
}

function countByStatus(statuses: Map<string, string>, status: string): number {
	let count = 0;
	for (const value of statuses.values()) if (value === status) count += 1;
	return count;
}

interface DagFrontierProjection {
	running: string[];
	ready: string[];
	blocked: string[];
	critical: string[];
	waitingOn: Record<string, string[]>;
	/** ids with terminal states, only available when the event carries a frontier. */
	settledIds: string[];
	failedIds: string[];
}

function projectDagFrontier(
	nodes: Record<string, DagNodeLike>,
	statuses: Map<string, string>,
	originalNodes: Record<string, unknown>,
	source: Record<string, unknown>,
	active: boolean,
): DagFrontierProjection {
	const frontier = objectValue(source.frontier);
	const knownIds = (value: unknown) => [...new Set(stringList(value).filter((id) => statuses.has(id)))];
	const projectedRunning = knownIds(frontier?.running);
	const projectedReady = knownIds(frontier?.ready);
	const projectedBlocked = knownIds(frontier?.blocked);
	const projectedCritical = knownIds(frontier?.critical);
	const projectedSettled = knownIds(frontier?.settled);
	const projectedFailed = knownIds(frontier?.failed);
	const running = active
		? (frontier ? projectedRunning : Object.keys(nodes).filter((id) => statuses.get(id) === "running"))
		: [];
	const computedReady = Object.keys(nodes).filter((id) => {
		if (statuses.get(id) !== "queued") return false;
		return depsOf(nodes[id], originalNodes[id]).every((dep) => TERMINAL_DAG_STATES.has(statuses.get(dep) ?? "queued"));
	});
	const ready = active ? (frontier ? projectedReady : computedReady) : [];
	const blocked = active
		? (frontier ? projectedBlocked : Object.keys(nodes).filter((id) => statuses.get(id) === "queued" && !computedReady.includes(id)))
		: [];
	const critical = active && frontier ? projectedCritical : [];
	const waitingOn: Record<string, string[]> = {};
	for (const id of blocked) {
		const explicit = stringList(objectValue(nodes[id])?.waitingOn);
		const deps = depsOf(nodes[id], originalNodes[id]);
		waitingOn[id] = explicit.length > 0
			? explicit.filter((dep) => statuses.has(dep))
			: deps.filter((dep) => !TERMINAL_DAG_STATES.has(statuses.get(dep) ?? "queued"));
	}
	return { running, ready, blocked, critical, waitingOn, settledIds: projectedSettled, failedIds: projectedFailed };
}

function extractDagProgress(
	tool: TrackerTool,
	payload: unknown,
	now: number,
	active: boolean,
	previous: DagRuntimeProgress | null,
): DagRuntimeProgress | null {
	const result = objectValue(payload);
	if (!result) return previous;
	const details = objectValue(result.details) ?? result;
	const progress = objectValue(details.progress);
	const isProgressUpdate = details.kind === "dag-progress" && progress !== null;
	if (active && !isProgressUpdate) return previous;
	const source = isProgressUpdate ? progress! : details;
	const nodes = nodeRecord(source.nodes ?? source.nodeStates);
	const args = objectValue(tool.args);
	const originalSpec = objectValue(args?.spec);
	const originalNodes = objectValue(originalSpec?.nodes) ?? {};
	const nodeIds = Object.keys(nodes);
	if (nodeIds.length === 0 && !previous && tool.toolName !== "dag_execute" && tool.toolName !== "dag_resume") return null;

	const statuses = collectNodeStatuses(nodes);
	const frontier = objectValue(source.frontier);
	const projection = projectDagFrontier(nodes, statuses, originalNodes, source, active);
	const metrics = objectValue(details.metrics);
	const total = nodeIds.length > 0 ? nodeIds.length : nonNegativeInteger(metrics?.totalNodes) ?? previous?.total ?? 0;
	const boundedCount = (value: unknown, fallback: number) => Math.min(total, nonNegativeInteger(value) ?? fallback);
	const completed = boundedCount(metrics?.completed, countByStatus(statuses, "completed"));
	const failed = boundedCount(metrics?.failed, countByStatus(statuses, "failed"));
	const skipped = boundedCount(metrics?.skipped, countByStatus(statuses, "skipped"));
	const scheduler = source.scheduler === "ready" || source.scheduler === "wave"
		? source.scheduler
		: previous?.scheduler ?? "unknown";
	const terminationValue = source.termination ?? details.termination;
	const termination = terminationValue === "all_terminal" || terminationValue === "aborted" || terminationValue === "blocked"
		? terminationValue
		: details.status === "failed" || details.status === "error" ? "blocked"
		: previous?.termination;
	const dagId = stringValue(source.dagId) ?? previous?.dagId ?? "";
	const routes = Object.keys(nodes).filter((id) => Boolean(stringValue(objectValue(nodes[id])?.route))).length;
	const routeDecisions = objectValue(source.routeDecisions);
	const generatedNodes = objectValue(source.generatedNodes);
	const generated = generatedNodes
		? Object.keys(generatedNodes).length
		: originalSpec ? nodeIds.filter((id) => !(id in originalNodes)).length : previous?.generated ?? 0;
	return {
		toolCallId: tool.toolCallId,
		dagId,
		scheduler,
		active,
		total,
		running: projection.running,
		ready: projection.ready,
		blocked: projection.blocked,
		critical: projection.critical,
		waitingOn: projection.waitingOn,
		settled: frontier ? projection.settledIds.length : Math.min(total, completed + failed + skipped),
		completed,
		failed: frontier ? projection.failedIds.length : failed,
		skipped,
		generated,
		routes: nonNegativeInteger(metrics?.routeCount) ?? Math.max(Object.keys(routeDecisions ?? {}).length, routes, previous?.routes ?? 0),
		...(termination ? { termination } : {}),
		updatedAt: now,
	};
}

export class GoalRuntimeTracker {
	private readonly activeTools = new Map<string, TrackerTool>();
	private readonly dagProgressByTool = new Map<string, DagRuntimeProgress>();
	private hasTurn = false;
	private state: GoalRuntimeActivity;

	constructor(now = 0, outcomeAt = now) {
		this.state = {
			phase: "idle",
			label: "idle",
			turnStartedAt: null,
			tools: [],
			dag: null,
			dags: [],
			failures: [],
			lastActivityAt: now,
			lastOutcomeDeltaAt: outcomeAt,
		};
	}

	reset(now: number, outcomeAt = now): void {
		this.activeTools.clear();
		this.dagProgressByTool.clear();
		this.hasTurn = false;
		this.state = {
			phase: "idle",
			label: "idle",
			turnStartedAt: null,
			tools: [],
			dag: null,
			dags: [],
			failures: [],
			lastActivityAt: now,
			lastOutcomeDeltaAt: outcomeAt,
		};
	}

	markOutcomeDelta(now: number): void {
		this.state.lastOutcomeDeltaAt = Math.max(this.state.lastOutcomeDeltaAt, now);
	}

	turnStarted(now: number): void {
		this.hasTurn = true;
		this.activeTools.clear();
		this.dagProgressByTool.clear();
		this.state.dag = null;
		this.state.dags = [];
		this.state.failures = [];
		this.state.turnStartedAt = now;
		this.state.lastActivityAt = now;
		this.refreshActivity("thinking", "thinking");
	}

	turnEnded(now: number): void {
		this.activeTools.clear();
		this.dagProgressByTool.clear();
		this.hasTurn = false;
		this.state.turnStartedAt = null;
		if (this.state.dag) {
			this.state.dag.active = false;
			this.state.dag.running = [];
			this.state.dag.ready = [];
			this.state.dag.critical = [];
		}
		this.state.lastActivityAt = now;
		this.refreshActivity("waiting", "waiting");
	}

	evaluationStarted(now: number): void {
		this.state.lastActivityAt = now;
		this.refreshActivity("evaluating", "evaluating completion");
	}

	evaluationEnded(now: number): void {
		this.state.lastActivityAt = now;
		this.refreshActivity(this.hasTurn ? "thinking" : "waiting", this.hasTurn ? "thinking" : "waiting");
	}

	toolStarted(toolCallId: string, toolName: string, args: unknown, now: number): void {
		const display = toolActivityLabel(toolName, args);
		this.activeTools.set(toolCallId, { toolCallId, toolName, args, ...display, startedAt: now, updatedAt: now });
		if (toolName === "dag_execute" || toolName === "dag_resume") {
			this.dagProgressByTool.delete(toolCallId);
			const hasOtherDagProgress = [...this.activeTools.values()].some((candidate) =>
				candidate.toolCallId !== toolCallId
				&& (candidate.toolName === "dag_execute" || candidate.toolName === "dag_resume")
				&& this.dagProgressByTool.has(candidate.toolCallId));
			if (!hasOtherDagProgress) this.state.dag = null;
		}
		this.state.lastActivityAt = now;
		this.refreshActivity();
	}

	toolUpdated(toolCallId: string, toolName: string, partialResult: unknown, now: number): void {
		const tool = this.activeTools.get(toolCallId);
		if (!tool) return;
		tool.updatedAt = now;
		if (toolName === "dag_execute" || toolName === "dag_resume") {
			const dag = extractDagProgress(tool, partialResult, now, true, this.dagProgressByTool.get(toolCallId) ?? null);
			if (dag) {
				this.dagProgressByTool.set(toolCallId, dag);
				this.state.dag = dag;
			}
		}
		this.state.lastActivityAt = now;
		this.refreshActivity();
	}

	toolEnded(toolCallId: string, result: unknown, isError: boolean, now: number): void {
		const tool = this.activeTools.get(toolCallId);
		if (!tool) return;
		let endedDag: DagRuntimeProgress | null = null;
		if (tool.toolName === "dag_execute" || tool.toolName === "dag_resume") {
			endedDag = extractDagProgress(tool, result, now, false, this.dagProgressByTool.get(toolCallId) ?? null);
			if (endedDag) {
				endedDag.active = false;
				endedDag.running = [];
				endedDag.ready = [];
				endedDag.critical = [];
				if (isError && !endedDag.termination) endedDag.termination = "aborted";
				this.dagProgressByTool.set(toolCallId, endedDag);
			}
		}
		const resultObject = objectValue(result);
		const details = objectValue(resultObject?.details) ?? resultObject;
		const businessStatus = stringValue(details?.status);
		const unsuccessful = isError
			|| businessStatus === "error"
			|| businessStatus === "failed"
			|| businessStatus === "aborted"
			|| businessStatus === "blocked"
			|| businessStatus === "partial";
		if (unsuccessful) {
			const partialMessage = businessStatus === "partial" && endedDag?.failed
				? endedDag.failed + " DAG node(s) failed"
				: undefined;
			const message = stringValue(details?.reason)
				?? stringValue(details?.error)
				?? partialMessage
				?? (isError ? "tool execution failed" : businessStatus!);
			this.state.failures = [
				...this.state.failures,
				{ toolName: tool.toolName, status: businessStatus ?? "error", message, at: now },
			].slice(-3);
		}
		this.activeTools.delete(toolCallId);
		if (tool.toolName === "dag_execute" || tool.toolName === "dag_resume") {
			this.dagProgressByTool.delete(toolCallId);
			const activeDag = [...this.activeTools.values()]
				.filter((candidate) => candidate.toolName === "dag_execute" || candidate.toolName === "dag_resume")
				.map((candidate) => this.dagProgressByTool.get(candidate.toolCallId))
				.filter((candidate): candidate is DagRuntimeProgress => candidate !== undefined)
				.sort((a, b) => a.updatedAt - b.updatedAt)
				.at(-1);
			this.state.dag = activeDag ?? endedDag;
		}
		this.state.lastActivityAt = now;
		this.refreshActivity();
	}

	snapshot(): GoalRuntimeActivity {
		return {
			...this.state,
			tools: this.state.tools.map((tool) => ({ ...tool })),
			failures: this.state.failures.map((failure) => ({ ...failure })),
			dag: this.state.dag ? {
				...this.state.dag,
				running: [...this.state.dag.running],
				ready: [...this.state.dag.ready],
				blocked: [...this.state.dag.blocked],
				critical: [...this.state.dag.critical],
				waitingOn: Object.fromEntries(Object.entries(this.state.dag.waitingOn).map(([id, deps]) => [id, [...deps]])),
			} : null,
			dags: this.state.dags.map((dag) => ({
				...dag,
				running: [...dag.running],
				ready: [...dag.ready],
				blocked: [...dag.blocked],
				critical: [...dag.critical],
				waitingOn: Object.fromEntries(Object.entries(dag.waitingOn).map(([id, deps]) => [id, [...deps]])),
			})),
		};
	}

	private refreshActivity(fallbackPhase?: RuntimeActivityPhase, fallbackLabel?: string): void {
		const tools = [...this.activeTools.values()].sort((a, b) => a.startedAt - b.startedAt || a.toolCallId.localeCompare(b.toolCallId));
		this.state.tools = tools.map(({ args: _args, ...tool }) => ({ ...tool }));
		const dagTools = tools.filter((tool) => tool.toolName === "dag_execute" || tool.toolName === "dag_resume");
		const roleTools = tools.filter((tool) => tool.toolName === "spawn_role");
		const activeDags = dagTools
			.map((tool) => this.dagProgressByTool.get(tool.toolCallId))
			.filter((dag): dag is DagRuntimeProgress => dag !== undefined);
		this.state.dags = activeDags.length > 0 ? activeDags : (this.state.dag ? [this.state.dag] : []);
		if (dagTools.length > 0) {
			const running = activeDags.reduce((sum, dag) => sum + dag.running.length, 0);
			const ready = activeDags.reduce((sum, dag) => sum + dag.ready.length, 0);
			this.state.phase = "dag";
			this.state.label = activeDags.length > 0
				? (dagTools.length > 1 ? dagTools.length + " DAGs, " : "DAG ") + running + " running, " + ready + " ready"
				: (dagTools.length > 1 ? dagTools.length + " DAGs starting" : "DAG starting");
			return;
		}
		if (roleTools.length > 0) {
			this.state.phase = "specialist";
			this.state.label = roleTools.length === 1 ? roleTools[0].label : roleTools.length + " specialists running";
			return;
		}
		if (tools.length > 0) {
			this.state.phase = "tool";
			this.state.label = tools.length === 1 ? tools[0].label : tools.length + " tools running";
			return;
		}
		this.state.phase = fallbackPhase ?? (this.hasTurn ? "thinking" : "waiting");
		this.state.label = fallbackLabel ?? (this.hasTurn ? "thinking" : "waiting");
	}
}

function countStatuses(items: readonly OutcomeProgressItem[]): OutcomeProgressCounts {
	const counts: OutcomeProgressCounts = { total: items.length, pending: 0, evidenced: 0, verified: 0, blocked: 0 };
	for (const item of items) counts[item.status] += 1;
	return counts;
}

function latestOutcomeAt(goal: GoalStateV2): number {
	if (goal.progress.lastOutcomeDeltaAt >= goal.createdAt) return goal.progress.lastOutcomeDeltaAt;
	const timestamps = [
		goal.createdAt,
		goal.assurance.decidedAt,
		goal.completion.requestedAt ?? 0,
		goal.completion.lastEvaluation?.evaluatedAt ?? 0,
		...goal.evidenceLedger.map((item) => item.recordedAt),
	];
	if (goal.status === "complete" || goal.status === "unmet") timestamps.push(goal.endedAt ?? 0);
	return Math.max(...timestamps);
}

export function deriveLastOutcomeDeltaAt(goal: GoalStateV2): number {
	return latestOutcomeAt(goal);
}

export function outcomeSignature(goal: GoalStateV2): string {
	return JSON.stringify({
		terminal: goal.status === "complete" || goal.status === "unmet" ? goal.status : null,
		blocker: goal.status === "unmet" ? goal.blocker : null,
		criteria: goal.criteria.map(({ id, description, level, evidenceRefs }) => ({ id, description, level, evidenceRefs })),
		claims: goal.claims,
		evidenceLedger: goal.evidenceLedger,
		assurance: goal.assurance,
		completion: goal.completion,
	});
}

function outcomeItems(goal: GoalStateV2, evaluationFresh: boolean): OutcomeProgressItem[] {
	const evaluation = evaluationFresh ? goal.completion.lastEvaluation : null;
	const criterionCoverage = new Map(evaluation?.criterionCoverage.map((item) => [item.criterionId, item]) ?? []);
	const claimCoverage = new Map(evaluation?.claimCoverage.map((item) => [item.claimId, item]) ?? []);
	const findings = new Map<string, CompletionFinding>();
	for (const finding of evaluation?.findings ?? []) if (!findings.has(finding.subjectId)) findings.set(finding.subjectId, finding);

	const criteria: OutcomeProgressItem[] = goal.criteria.map((criterion) => {
		const coverage = criterionCoverage.get(criterion.id);
		const finding = findings.get(criterion.id);
		let status: OutcomeProgressStatus = criterion.evidenceRefs.length > 0 ? "evidenced" : "pending";
		if (coverage?.status === "satisfied") status = "verified";
		else if (coverage?.status === "blocked" || (finding && criterion.level === "blocking")) status = "blocked";
		return {
			id: criterion.id,
			kind: "criterion",
			label: criterion.description,
			level: criterion.level,
			status,
			evidenceRefs: [...criterion.evidenceRefs],
			...(finding?.reason || coverage?.reason ? { reason: finding?.reason ?? coverage?.reason } : {}),
		};
	});
	const constraints: OutcomeProgressItem[] = goal.constraints.map((constraint, index) => {
		const id = "$constraint:" + index;
		const coverage = criterionCoverage.get(id);
		const finding = findings.get(id);
		const evidenceRefs = coverage?.evidenceRefs ?? finding?.evidenceRefs ?? [];
		let status: OutcomeProgressStatus = evidenceRefs.length > 0 ? "evidenced" : "pending";
		if (coverage?.status === "satisfied") status = "verified";
		else if (coverage?.status === "blocked" || coverage?.status === "unsatisfied" || finding) status = "blocked";
		return {
			id,
			kind: "constraint",
			label: constraint,
			level: "blocking",
			status,
			evidenceRefs: [...evidenceRefs],
			...(finding?.reason || coverage?.reason ? { reason: finding?.reason ?? coverage?.reason } : {}),
		};
	});
	const claims: OutcomeProgressItem[] = goal.claims.map((claim) => {
		const coverage = claimCoverage.get(claim.id);
		const finding = findings.get(claim.id);
		let status: OutcomeProgressStatus = claim.evidenceRefs.length > 0 ? "evidenced" : "pending";
		if (coverage?.status === "sufficient") status = "verified";
		else if (coverage?.status === "conflicted" || (finding && claim.materiality === "material")) status = "blocked";
		return {
			id: claim.id,
			kind: "claim",
			label: claim.text,
			level: claim.materiality === "material" ? "blocking" : "advisory",
			status,
			evidenceRefs: [...claim.evidenceRefs],
			...(finding?.reason || coverage?.reason ? { reason: finding?.reason ?? coverage?.reason } : {}),
		};
	});
	return [...criteria, ...constraints, ...claims];
}

export function deriveGoalProgress(
	goal: GoalStateV2,
	runtime: GoalRuntimeActivity | null,
	input: { now: number; activeMs?: number },
): GoalProgressSnapshot {
	const now = input.now;
	const fallbackOutcomeAt = latestOutcomeAt(goal);
	const activity: GoalRuntimeActivity = runtime ? {
		...runtime,
		tools: runtime.tools.map((tool) => ({ ...tool })),
		dag: runtime.dag ? {
			...runtime.dag,
			running: [...runtime.dag.running],
			ready: [...runtime.dag.ready],
			blocked: [...runtime.dag.blocked],
			critical: [...runtime.dag.critical],
			waitingOn: Object.fromEntries(Object.entries(runtime.dag.waitingOn).map(([id, deps]) => [id, [...deps]])),
		} : null,
		dags: runtime.dags.map((dag) => ({
			...dag,
			running: [...dag.running],
			ready: [...dag.ready],
			blocked: [...dag.blocked],
			critical: [...dag.critical],
			waitingOn: Object.fromEntries(Object.entries(dag.waitingOn).map(([id, deps]) => [id, [...deps]])),
		})),
	} : {
		phase: "idle",
		label: "idle",
		turnStartedAt: null,
		tools: [],
		dag: null,
		dags: [],
		failures: [],
		lastActivityAt: goal.updatedAt,
		lastOutcomeDeltaAt: fallbackOutcomeAt,
	};
	if (goal.status !== "active") {
		activity.phase = "idle";
		activity.label = goal.status;
		activity.tools = [];
		if (activity.dag) {
			activity.dag.active = false;
			activity.dag.running = [];
			activity.dag.ready = [];
			activity.dag.critical = [];
		}
		activity.dags = activity.dags.map((dag) => ({ ...dag, active: false, running: [], ready: [], critical: [] }));
	}
	const evaluation = goal.completion.lastEvaluation;
	const evaluationFresh = evaluation !== null
		&& goal.progress.lastEvaluatedOutcomeRevision === goal.progress.outcomeRevision;
	const items = outcomeItems(goal, evaluationFresh);
	const counts = countStatuses(items);
	const blockingItems = items.filter((item) => item.level === "blocking");
	const completionPending = goal.completion.requestedAt !== null
		&& (evaluation === null || evaluation.evaluatedAt < goal.completion.requestedAt);
	if (completionPending && goal.status === "active" && activity.phase === "waiting") {
		activity.phase = "evaluating";
		activity.label = "completion requested";
	}
	const issues: GoalProgressSnapshot["health"]["issues"] = [];
	if (goal.status === "blocked" || goal.status === "unmet") {
		issues.push({ code: goal.status, message: goal.blocker ?? "Goal cannot continue.", blocking: true });
	} else if (goal.status === "paused" || goal.status === "budget_limited" || goal.status === "usage_limited") {
		issues.push({ code: goal.status, message: goal.pausedReason ?? goal.status.replaceAll("_", " "), blocking: false });
	}
	for (const finding of evaluationFresh ? evaluation?.findings ?? [] : []) {
		issues.push({ code: finding.code, message: finding.reason, blocking: evaluation?.decision === "blocked" });
	}
	if (evaluation && !evaluationFresh) {
		issues.push({ code: "reevaluation_needed", message: "Outcome evidence changed after the last completion evaluation.", blocking: false });
	}
	if (goal.noProgressCount > 0) {
		issues.push({ code: "no_progress", message: goal.noProgressCount + " turn(s) without measured progress", blocking: false });
	}
	if (goal.completion.rejectionCount > 0) {
		issues.push({ code: "completion_rejected", message: goal.completion.rejectionCount + " repeated completion rejection(s)", blocking: false });
	}
	// Once completion is accepted, the completion audit is authoritative. A
	// transient runtime failure from the final turn remains visible in activity
	// history but must not make an achieved goal look unhealthy.
	if (goal.status !== "complete") {
		for (const failure of activity.failures) {
			issues.push({ code: "tool_" + failure.status, message: failure.toolName + ": " + failure.message, blocking: false });
		}
		const dagFailureAlreadyReported = activity.failures.some((failure) => failure.toolName === "dag_execute" || failure.toolName === "dag_resume");
		const failedDagNodes = activity.dags.reduce((sum, dag) => sum + dag.failed, 0);
		if (failedDagNodes > 0 && !dagFailureAlreadyReported) {
			issues.push({ code: "dag_failed_nodes", message: failedDagNodes + " DAG node(s) failed.", blocking: false });
		}
		const abnormalTermination = activity.dags.find((dag) => dag.termination === "blocked" || dag.termination === "aborted")?.termination;
		if (abnormalTermination === "blocked" || abnormalTermination === "aborted") {
			issues.push({ code: "dag_" + abnormalTermination, message: "DAG execution " + abnormalTermination + ".", blocking: false });
		}
	}
	const healthState = issues.some((item) => item.blocking) || goal.status === "blocked" || goal.status === "unmet"
		? "blocked"
		: issues.length > 0 ? "attention" : "healthy";
	const evidenceVerification = (verification: GoalStateV2["evidenceLedger"][number]["verification"]) =>
		goal.evidenceLedger.filter((item) => item.verification === verification).length;
	const lastActivityAt = activity.lastActivityAt || goal.updatedAt;
	const lastOutcomeDeltaAt = activity.lastOutcomeDeltaAt || fallbackOutcomeAt;
	const wallEnd = goal.endedAt ?? now;
	return {
		version: 1,
		goalId: goal.id,
		status: goal.status,
		generatedAt: now,
		goal: { objective: goal.objective, taskKind: goal.taskKind },
		route: {
			preference: goal.execution.preference,
			topology: goal.execution.selected,
			...(goal.execution.role ? { role: goal.execution.role } : {}),
			confidence: goal.execution.confidence,
			reasons: [...goal.execution.reasons],
		},
		outcomes: {
			revision: goal.progress.outcomeRevision,
			items,
			counts,
			blocking: {
				total: blockingItems.length,
				open: blockingItems.filter((item) => item.status !== "verified").length,
				blocked: blockingItems.filter((item) => item.status === "blocked").length,
			},
		},
		activity,
		evidence: {
			total: goal.evidenceLedger.length,
			verified: evidenceVerification("verified"),
			unverified: evidenceVerification("unverified"),
			rejected: evidenceVerification("rejected"),
			independentSources: new Set(goal.evidenceLedger.map((item) => item.independenceKey).filter(Boolean)).size,
		},
		assurance: {
			requirement: goal.assurance.reviewRequirement,
			status: goal.assurance.reviewStatus,
			depth: goal.assurance.depth,
			reasons: [...goal.assurance.reasons],
			completionDecision: evaluation?.decision ?? null,
			completionPending,
			evaluationFresh,
			blockingFindings: evaluationFresh
				? evaluation?.findings.map((finding) => ({ ...finding, evidenceRefs: finding.evidenceRefs ? [...finding.evidenceRefs] : undefined })) ?? []
				: [],
			advisories: [...(evaluation?.advisories ?? [])],
		},
		health: {
			state: healthState,
			issues,
			noProgressTurns: goal.noProgressCount,
			repeatedRejections: goal.completion.rejectionCount,
			activityWithoutOutcomeMs: Math.max(0, (
				goal.status === "active" && activity.phase !== "waiting" && activity.phase !== "idle"
					? now
					: lastActivityAt
			) - lastOutcomeDeltaAt),
		},
		resources: {
			tokensUsed: goal.tokensUsed,
			tokenBudget: goal.tokenBudget,
			activeMs: input.activeMs ?? goal.timeUsedMs,
			wallMs: Math.max(0, wallEnd - goal.createdAt),
		},
		timestamps: { lastActivityAt, lastOutcomeDeltaAt },
	};
}

export function displayWidth(value: string): number {
	let width = 0;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		width += (code >= 0x1100 && (
			code <= 0x115f || code === 0x2329 || code === 0x232a
			|| (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
			|| (code >= 0xac00 && code <= 0xd7a3)
			|| (code >= 0xf900 && code <= 0xfaff)
			|| (code >= 0xfe10 && code <= 0xfe19)
			|| (code >= 0xfe30 && code <= 0xfe6f)
			|| (code >= 0xff00 && code <= 0xff60)
			|| (code >= 0xffe0 && code <= 0xffe6)
			|| (code >= 0x1f300 && code <= 0x1faff)
		)) ? 2 : 1;
	}
	return width;
}

export function truncateDisplay(value: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(value) <= width) return value;
	if (width === 1) return ".";
	let result = "";
	let used = 0;
	const budget = width - 1;
	for (const character of value) {
		const characterWidth = displayWidth(character);
		if (used + characterWidth > budget) break;
		result += character;
		used += characterWidth;
	}
	return result + "...".slice(0, 1);
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
	if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
	return String(value);
}

function formatTime(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return seconds + "s";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + "m" + String(seconds % 60).padStart(2, "0") + "s";
	const hours = Math.floor(minutes / 60);
	return hours + "h" + String(minutes % 60).padStart(2, "0") + "m";
}

function statusLabel(status: GoalStateV2["status"]): string {
	if (status === "complete") return "achieved";
	if (status === "budget_limited") return "budget limited";
	if (status === "usage_limited") return "usage limited";
	return status;
}

function blockingOutcomeSummary(progress: GoalProgressSnapshot): string {
	const blocking = progress.outcomes.blocking;
	if (blocking.total === 0) return "no blocking outcomes";
	if (blocking.open === 0) return blocking.total + " blocking verified";
	return blocking.open + " blocking open" + (blocking.blocked > 0 ? " (" + blocking.blocked + " blocked)" : "");
}

export function renderCompactGoalProgress(progress: GoalProgressSnapshot, width = 120): string {
	const resources = progress.resources;
	const tokens = formatNumber(resources.tokensUsed)
		+ (resources.tokenBudget === null ? "" : "/" + formatNumber(resources.tokenBudget))
		+ " tok";
	const parts = [
		"goal " + statusLabel(progress.status),
		blockingOutcomeSummary(progress),
	];
	parts.push(tokens, "active " + formatTime(resources.activeMs), "wall " + formatTime(resources.wallMs));
	if (progress.health.state !== "healthy") parts.push("health " + progress.health.state);
	if (progress.status === "active") parts.push(progress.activity.label);
	else if (progress.health.issues[0]) parts.push(shortText(progress.health.issues[0].message, 30));
	return truncateDisplay(parts.join(" | "), width);
}

function ageLabel(timestamp: number, now: number): string {
	if (!timestamp || timestamp > now) return "just now";
	return formatTime(now - timestamp) + " ago";
}

export function renderGoalProgressLines(progress: GoalProgressSnapshot, width = 100): string[] {
	const line = (value: string) => truncateDisplay(value, Math.max(1, width));
	const blockingVerified = progress.outcomes.blocking.total - progress.outcomes.blocking.open;
	const advisoryItems = progress.outcomes.items.filter((item) => item.level === "advisory");
	const advisoryOpen = advisoryItems.filter((item) => item.status !== "verified").length;
	const lines = [
		line("Goal " + statusLabel(progress.status) + " | " + blockingOutcomeSummary(progress)),
		line("  Objective: " + progress.goal.objective),
		line("  Route: " + progress.goal.taskKind + " | " + progress.route.topology
			+ (progress.route.role ? " | " + progress.route.role : "")
			+ " | confidence " + progress.route.confidence.toFixed(2)),
		line("  Activity: " + progress.activity.label),
	];
	for (const reason of progress.route.reasons.slice(0, 2)) lines.push(line("    route: " + reason));
	const dags = progress.activity.dags;
	const dag = progress.activity.dag;
	if (dags.length > 1) {
		const totals = dags.reduce((sum, item) => ({
			running: sum.running + item.running.length,
			ready: sum.ready + item.ready.length,
			blocked: sum.blocked + item.blocked.length,
			settled: sum.settled + item.settled,
			total: sum.total + item.total,
			failed: sum.failed + item.failed,
		}), { running: 0, ready: 0, blocked: 0, settled: 0, total: 0, failed: 0 });
		lines.push(line("  Frontiers: " + dags.length + " DAGs | " + totals.running + " running | " + totals.ready + " ready | "
			+ totals.blocked + " blocked | " + totals.settled + "/" + totals.total + " settled | " + totals.failed + " failed"));
		for (const item of dags.slice(0, 4)) {
			lines.push(line("    " + (item.dagId || item.toolCallId) + ": " + item.running.length + " running | " + item.ready.length
				+ " ready | " + item.blocked.length + " blocked | " + item.settled + "/" + item.total + " settled | " + item.failed + " failed | " + item.scheduler));
		}
		if (dags.length > 4) lines.push(line("    +" + (dags.length - 4) + " more DAGs"));
	} else if (dag) {
		lines.push(line("  Frontier: " + dag.running.length + " running | " + dag.ready.length + " ready | " + dag.blocked.length + " blocked | " + dag.settled + "/" + dag.total
			+ " settled (" + dag.completed + " done, " + dag.failed + " failed, " + dag.skipped + " skipped) | " + dag.scheduler));
		if (dag.critical.length > 0) lines.push(line("    critical frontier: " + dag.critical.join(", ")));
		for (const id of dag.blocked.slice(0, 4)) {
			const deps = dag.waitingOn[id] ?? [];
			lines.push(line("    waiting: " + id + (deps.length > 0 ? " <- " + deps.join(", ") : " <- scheduler barrier")));
		}
		if (dag.blocked.length > 4) lines.push(line("    +" + (dag.blocked.length - 4) + " more blocked nodes"));
		if (dag.generated > 0 || dag.routes > 0) {
			lines.push(line("    dynamic: " + dag.generated + " generated | " + dag.routes + " route decisions"));
		}
	}
	lines.push(line("  Outcomes: blocking " + blockingVerified + " verified | " + progress.outcomes.blocking.open + " open"
		+ (progress.outcomes.blocking.blocked > 0 ? " | " + progress.outcomes.blocking.blocked + " blocked" : "")
		+ " | advisory " + advisoryOpen + " open / " + advisoryItems.length + " total"));
	for (const item of progress.outcomes.items.slice(0, 14)) {
		const marker = item.status === "verified" ? "ok" : item.status === "evidenced" ? "ev" : item.status === "blocked" ? "!!" : "..";
		lines.push(line("    [" + marker + "] " + item.level + " " + item.kind + " " + item.id + ": " + item.label));
		if (item.reason) lines.push(line("         " + item.reason));
	}
	if (progress.outcomes.items.length > 14) lines.push(line("    +" + (progress.outcomes.items.length - 14) + " more outcomes"));
	lines.push(line("  Evidence: " + progress.evidence.total + " total | " + progress.evidence.verified + " verified | " + progress.evidence.unverified + " unverified | " + progress.evidence.rejected + " rejected"));
	const assurance = progress.assurance;
	lines.push(line("  Assurance: " + assurance.requirement + " | " + assurance.status + " | " + assurance.depth
		+ (assurance.completionPending ? " | completion pending" : assurance.completionDecision ? " | " + assurance.completionDecision : "")
			+ (!assurance.evaluationFresh && assurance.completionDecision ? " | stale" : "")));
	for (const reason of assurance.reasons.slice(0, 2)) lines.push(line("    assurance: " + reason));
	if (assurance.blockingFindings.length > 0) lines.push(line("  Blocking findings:"));
	for (const finding of assurance.blockingFindings.slice(0, 8)) {
		lines.push(line("    BLOCK " + finding.code + " [" + finding.subjectId + "]: " + finding.reason));
	}
	if (assurance.blockingFindings.length > 8) lines.push(line("    +" + (assurance.blockingFindings.length - 8) + " more blocking findings"));
	lines.push(line("  Health: " + progress.health.state + " | " + progress.health.noProgressTurns + " no-progress turns | " + progress.health.repeatedRejections + " repeated rejections"
		+ (progress.health.activityWithoutOutcomeMs > 0 ? " | " + formatTime(progress.health.activityWithoutOutcomeMs) + " activity without outcome change" : "")));
	for (const issue of progress.health.issues.slice(0, 4)) lines.push(line("    " + (issue.blocking ? "BLOCK " : "NOTE ") + issue.code + ": " + issue.message));
	for (const advisory of assurance.advisories.slice(0, 3)) lines.push(line("    ADVISORY: " + advisory));
	const resources = progress.resources;
	lines.push(line("  Resources: " + formatNumber(resources.tokensUsed)
		+ (resources.tokenBudget === null ? "" : "/" + formatNumber(resources.tokenBudget))
		+ " tokens | active " + formatTime(resources.activeMs) + " | wall " + formatTime(resources.wallMs)));
	lines.push(line("  Recency: activity " + ageLabel(progress.timestamps.lastActivityAt, progress.generatedAt)
		+ " | outcome " + ageLabel(progress.timestamps.lastOutcomeDeltaAt, progress.generatedAt)));
	return lines;
}
