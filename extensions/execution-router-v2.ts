import type { ExecutionModeV2 } from "./state";

export type { ExecutionModeV2 } from "./state";
export type SemanticLevel = "low" | "medium" | "high";
export type SpecialistNeed = "none" | "helpful" | "required";
export type EstimatedEffort = "small" | "medium" | "large";

/** Produced by semantic task assessment; this module deliberately does no keyword matching. */
export interface ExecutionRoutingSignals {
	uncertainty: SemanticLevel;
	coupling: SemanticLevel;
	risk: SemanticLevel;
	specialistNeed: SpecialistNeed;
	independentWorkstreams: number;
	heterogeneousSkills: boolean;
	effort: EstimatedEffort;
	/** Confidence in the semantic route assessment, not confidence that the task can be completed. */
	confidence?: number;
	repeatedFailureCount?: number;
	remainingWorkstreams?: number;
	coordinationOverheadHigh?: boolean;
}

export interface ExecutionModeSelection {
	mode: ExecutionModeV2;
	/** A lock survives reassessment. An unavailable locked mode blocks instead of silently changing intent. */
	locked?: boolean;
}

export interface ExecutionRoutingInput {
	signals: ExecutionRoutingSignals;
	availableModes?: readonly ExecutionModeV2[];
	/** Non-binding preference produced by draft/config policy rather than a user interaction. */
	preferredMode?: ExecutionModeV2;
	userSelection?: ExecutionModeSelection;
	currentDecision?: ExecutionRoutingDecision;
}

export interface ExecutionRoutingDecision {
	mode: ExecutionModeV2;
	status: "ready" | "blocked";
	source: "auto" | "user" | "fallback" | "reassessment";
	locked: boolean;
	fallbackFrom?: ExecutionModeV2;
	reasons: string[];
	shouldReassess: boolean;
}

const ALL_MODES: readonly ExecutionModeV2[] = ["direct", "specialist", "team"];

function boundedWorkstreams(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function boundedConfidence(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(1, value))
		: 1;
}

function fallbackOrder(mode: ExecutionModeV2): ExecutionModeV2[] {
	switch (mode) {
		case "team": return ["team", "specialist", "direct"];
		case "specialist": return ["specialist", "direct", "team"];
		case "direct": return ["direct", "specialist", "team"];
	}
}

function chooseAvailable(
	preferred: ExecutionModeV2,
	available: ReadonlySet<ExecutionModeV2>,
): ExecutionModeV2 | null {
	return fallbackOrder(preferred).find((mode) => available.has(mode)) ?? null;
}

function baseRoute(signals: ExecutionRoutingSignals): { mode: ExecutionModeV2; reasons: string[] } {
	const workstreams = boundedWorkstreams(signals.independentWorkstreams);
	const meaningfulParallelism = workstreams >= 2
		&& signals.coupling !== "high"
		&& signals.effort !== "small"
		&& (signals.heterogeneousSkills || workstreams >= 3 || signals.uncertainty === "high");
	if (meaningfulParallelism) {
		return {
			mode: "team",
			reasons: ["Multiple sufficiently independent workstreams justify coordination overhead."],
		};
	}
	if (boundedConfidence(signals.confidence) < 0.6) {
		return {
			mode: "specialist",
			reasons: ["Low routing confidence calls for one bounded specialist probe before committing to a larger topology."],
		};
	}
	if (signals.specialistNeed !== "none") {
		return {
			mode: "specialist",
			reasons: [`Domain specialization is ${signals.specialistNeed}, while work remains tightly coupled or single-lane.`],
		};
	}
	return {
		mode: "direct",
		reasons: ["No specialist or meaningful parallel workstream is required."],
	};
}

function reassessedRoute(
	signals: ExecutionRoutingSignals,
	current: ExecutionRoutingDecision,
): { mode: ExecutionModeV2; reasons: string[] } {
	const failures = Math.max(0, Math.floor(signals.repeatedFailureCount ?? 0));
	const remaining = boundedWorkstreams(signals.remainingWorkstreams ?? signals.independentWorkstreams);

	if (current.mode === "team" && (signals.coordinationOverheadHigh || remaining <= 1)) {
		const mode: ExecutionModeV2 = signals.specialistNeed === "none" ? "direct" : "specialist";
		return {
			mode,
			reasons: [signals.coordinationOverheadHigh
				? "Team coordination overhead now exceeds its parallelism benefit."
				: "Only one workstream remains, so the team can be de-escalated."],
		};
	}

	if (failures >= 2 && current.mode === "direct") {
		return {
			mode: "specialist",
			reasons: ["Repeated direct-execution failure requires a different specialist strategy."],
		};
	}
	if (failures >= 2 && current.mode === "specialist" && remaining >= 2 && signals.coupling !== "high") {
		return {
			mode: "team",
			reasons: ["Repeated specialist failure exposed multiple independent workstreams."],
		};
	}

	const base = baseRoute({ ...signals, independentWorkstreams: remaining });
	if (base.mode !== current.mode) {
		return { mode: base.mode, reasons: [`Runtime evidence changed the cheapest sufficient mode.`, ...base.reasons] };
	}
	return { mode: current.mode, reasons: ["Runtime evidence still supports the current execution mode."] };
}

/** Choose the cheapest sufficient mode, while preserving explicit locked user intent. */
export function routeExecution(input: ExecutionRoutingInput): ExecutionRoutingDecision {
	const available = new Set(input.availableModes ?? ALL_MODES);
	const current = input.currentDecision;

	if (current?.locked) {
		if (!available.has(current.mode)) {
			return {
				mode: current.mode,
				status: "blocked",
				source: "user",
				locked: true,
				reasons: [`User-locked mode ${current.mode} is unavailable; explicit unlock is required.`],
				shouldReassess: false,
			};
		}
		return {
			...current,
			status: "ready",
			source: "user",
			reasons: [`User lock keeps executionMode=${current.mode}.`],
			shouldReassess: false,
		};
	}

	let preferred: ExecutionModeV2;
	let source: ExecutionRoutingDecision["source"];
	let locked = false;
	let reasons: string[];

	if (input.userSelection) {
		preferred = input.userSelection.mode;
		locked = input.userSelection.locked ?? false;
		source = "user";
		reasons = [`User selected executionMode=${preferred}${locked ? " with a lock" : ""}.`];
	} else if (input.preferredMode) {
		preferred = input.preferredMode;
		source = "auto";
		reasons = [`Draft policy preferred executionMode=${preferred}; the choice remains eligible for runtime reassessment.`];
	} else if (current) {
		const reassessed = reassessedRoute(input.signals, current);
		preferred = reassessed.mode;
		source = "reassessment";
		reasons = reassessed.reasons;
	} else {
		const automatic = baseRoute(input.signals);
		preferred = automatic.mode;
		source = "auto";
		reasons = automatic.reasons;
	}

	if (locked && !available.has(preferred)) {
		return {
			mode: preferred,
			status: "blocked",
			source,
			locked: true,
			reasons: [...reasons, `Locked mode ${preferred} is unavailable; fallback is not allowed.`],
			shouldReassess: false,
		};
	}

	const selected = chooseAvailable(preferred, available);
	if (!selected) {
		return {
			mode: preferred,
			status: "blocked",
			source,
			locked,
			reasons: [...reasons, "No execution mode is currently available."],
			shouldReassess: true,
		};
	}

	const fellBack = selected !== preferred;
	return {
		mode: selected,
		status: "ready",
		source: fellBack ? "fallback" : source,
		locked,
		...(fellBack ? { fallbackFrom: preferred } : {}),
		reasons: fellBack
			? [...reasons, `${preferred} is unavailable; using ${selected} as the nearest available mode.`]
			: reasons,
		shouldReassess: !locked && (
			input.signals.uncertainty !== "low"
			|| boundedConfidence(input.signals.confidence) < 0.8
			|| input.signals.repeatedFailureCount !== undefined
			|| selected === "team"
		),
	};
}

export const reassessExecution = routeExecution;
