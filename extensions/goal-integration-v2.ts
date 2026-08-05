import type {
	AssuranceDecision,
	CompletionEvaluation,
	CompletionEvaluator,
	EvidenceRef,
	GoalStateV2,
	ResearchClaim,
	TaskKind,
} from "./state";
import type { VerifyResult } from "./verify-command";
import {
	COMPLETION_POLICY_VERSION,
	rejectionFingerprint,
	type CompletionDecision,
	type PolicyCriterion,
} from "./completion-policy-v2";

export interface DeterministicVerificationInput {
	command?: string;
	result: VerifyResult;
}

export interface DeterministicVerificationPacket {
	command?: string;
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface EvidencePacketLimits {
	maxCriteria?: number;
	maxClaims?: number;
	maxEvidence?: number;
	maxConstraints?: number;
	maxRejectionHistory?: number;
	maxLatestResponseChars?: number;
	maxFieldChars?: number;
	maxDeterministicOutputChars?: number;
}

export interface EvidencePacketTruncation {
	criteriaOmitted: number;
	claimsOmitted: number;
	evidenceOmitted: number;
	constraintsOmitted: number;
	rejectionHistoryOmitted: number;
	evidenceRefsOmitted: number;
	textFieldsTruncated: number;
}

export interface BoundedEvidencePacket {
	schemaVersion: typeof COMPLETION_POLICY_VERSION;
	goal: {
		id: string;
		objective: string;
		taskKind: TaskKind;
		status: GoalStateV2["status"];
		constraints: string[];
		assurance: Pick<AssuranceDecision, "reviewRequirement" | "reviewStatus" | "independent" | "depth">;
	};
	criteria: PolicyCriterion[];
	claims: ResearchClaim[];
	evidenceLedger: EvidenceRef[];
	latestResponse: string;
	deterministicVerification: DeterministicVerificationPacket | null;
	rejectionHistory: string[];
	truncation: EvidencePacketTruncation;
}

export interface BuildEvidencePacketInput {
	goal: GoalStateV2;
	latestResponse: string;
	deterministicVerification?: DeterministicVerificationInput | null;
	rejectionHistory?: readonly string[];
	limits?: EvidencePacketLimits;
}

const DEFAULT_LIMITS = {
	maxCriteria: 64,
	maxClaims: 64,
	maxEvidence: 96,
	maxConstraints: 32,
	maxRejectionHistory: 8,
	maxLatestResponseChars: 8_000,
	maxFieldChars: 1_000,
	maxDeterministicOutputChars: 2_000,
} as const;

function limit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function prioritized<T>(items: readonly T[], important: (item: T) => boolean): T[] {
	return [...items.filter(important), ...items.filter((item) => !important(item))];
}

/** Build a prompt-safe packet while prioritizing evidence attached to blocking outcomes. */
export function buildBoundedEvidencePacket(input: BuildEvidencePacketInput): BoundedEvidencePacket {
	const limits = {
		maxCriteria: limit(input.limits?.maxCriteria, DEFAULT_LIMITS.maxCriteria),
		maxClaims: limit(input.limits?.maxClaims, DEFAULT_LIMITS.maxClaims),
		maxEvidence: limit(input.limits?.maxEvidence, DEFAULT_LIMITS.maxEvidence),
		maxConstraints: limit(input.limits?.maxConstraints, DEFAULT_LIMITS.maxConstraints),
		maxRejectionHistory: limit(input.limits?.maxRejectionHistory, DEFAULT_LIMITS.maxRejectionHistory),
		maxLatestResponseChars: limit(input.limits?.maxLatestResponseChars, DEFAULT_LIMITS.maxLatestResponseChars),
		maxFieldChars: limit(input.limits?.maxFieldChars, DEFAULT_LIMITS.maxFieldChars),
		maxDeterministicOutputChars: limit(input.limits?.maxDeterministicOutputChars, DEFAULT_LIMITS.maxDeterministicOutputChars),
	};
	const truncation: EvidencePacketTruncation = {
		criteriaOmitted: 0,
		claimsOmitted: 0,
		evidenceOmitted: 0,
		constraintsOmitted: 0,
		rejectionHistoryOmitted: 0,
		evidenceRefsOmitted: 0,
		textFieldsTruncated: 0,
	};
	const boundedText = (text: string, maxChars = limits.maxFieldChars): string => {
		const result = truncate(text, maxChars);
		if (result.truncated) truncation.textFieldsTruncated += 1;
		return result.text;
	};

	const orderedCriteria = prioritized(input.goal.criteria, (criterion) => criterion.level === "blocking");
	const selectedCriteria = orderedCriteria.slice(0, limits.maxCriteria);
	truncation.criteriaOmitted = Math.max(0, input.goal.criteria.length - selectedCriteria.length);

	const orderedClaims = prioritized(input.goal.claims, (claim) => claim.materiality === "material");
	const selectedClaims = orderedClaims.slice(0, limits.maxClaims);
	truncation.claimsOmitted = Math.max(0, input.goal.claims.length - selectedClaims.length);

	const ledgerById = new Map(input.goal.evidenceLedger.map((item) => [item.id, item]));
	const priorityIds: string[] = [];
	for (const item of [...selectedCriteria, ...selectedClaims]) {
		for (const ref of item.evidenceRefs) {
			if (!priorityIds.includes(ref)) priorityIds.push(ref);
		}
	}
	const orderedEvidence: EvidenceRef[] = [];
	const selectedIds = new Set<string>();
	for (const id of priorityIds) {
		const item = ledgerById.get(id);
		if (item && !selectedIds.has(id)) {
			selectedIds.add(id);
			orderedEvidence.push(item);
		}
	}
	for (const item of input.goal.evidenceLedger) {
		if (!selectedIds.has(item.id)) {
			selectedIds.add(item.id);
			orderedEvidence.push(item);
		}
	}
	const selectedEvidence = orderedEvidence.slice(0, limits.maxEvidence);
	const includedEvidenceIds = new Set(selectedEvidence.map((item) => item.id));
	truncation.evidenceOmitted = Math.max(0, orderedEvidence.length - selectedEvidence.length);

	const criteria: PolicyCriterion[] = selectedCriteria.map((criterion) => {
		const refs = criterion.evidenceRefs.filter((ref) => includedEvidenceIds.has(ref));
		truncation.evidenceRefsOmitted += criterion.evidenceRefs.length - refs.length;
		return {
			id: criterion.id,
			description: boundedText(criterion.description),
			level: criterion.level,
			evidenceRefs: refs,
		};
	});
	const claims: ResearchClaim[] = selectedClaims.map((claim) => {
		const refs = claim.evidenceRefs.filter((ref) => includedEvidenceIds.has(ref));
		truncation.evidenceRefsOmitted += claim.evidenceRefs.length - refs.length;
		return {
			id: claim.id,
			text: boundedText(claim.text),
			materiality: claim.materiality,
			...(claim.risk === undefined ? {} : { risk: claim.risk }),
			evidenceRefs: refs,
		};
	});
	const evidenceLedger: EvidenceRef[] = selectedEvidence.map((item) => ({
		...item,
		id: item.id,
		summary: boundedText(item.summary),
		locator: boundedText(item.locator?.trim() || `evidence:${item.id}`),
		...(item.excerpt === undefined ? {} : { excerpt: boundedText(item.excerpt) }),
	}));

	const constraints = input.goal.constraints.slice(0, limits.maxConstraints).map((item) => boundedText(item));
	truncation.constraintsOmitted = Math.max(0, input.goal.constraints.length - constraints.length);
	const history = [...(input.rejectionHistory ?? input.goal.completion.rejectionHistory)];
	const rejectionHistory = history.slice(-limits.maxRejectionHistory);
	truncation.rejectionHistoryOmitted = Math.max(0, history.length - rejectionHistory.length);

	const verification = input.deterministicVerification;
	const deterministicVerification: DeterministicVerificationPacket | null = verification
		? {
			...(verification.command === undefined ? {} : { command: boundedText(verification.command) }),
			ok: verification.result.ok,
			exitCode: verification.result.exitCode,
			stdout: boundedText(verification.result.stdout, limits.maxDeterministicOutputChars),
			stderr: boundedText(verification.result.stderr, limits.maxDeterministicOutputChars),
		}
		: null;

	return {
		schemaVersion: COMPLETION_POLICY_VERSION,
		goal: {
			id: input.goal.id,
			objective: boundedText(input.goal.objective),
			taskKind: input.goal.taskKind,
			status: input.goal.status,
			constraints,
			assurance: {
				reviewRequirement: input.goal.assurance.reviewRequirement,
				reviewStatus: input.goal.assurance.reviewStatus,
				independent: input.goal.assurance.independent,
				depth: input.goal.assurance.depth,
			},
		},
		criteria,
		claims,
		evidenceLedger,
		latestResponse: boundedText(input.latestResponse, limits.maxLatestResponseChars),
		deterministicVerification,
		rejectionHistory,
		truncation,
	};
}

export interface CompletionEvaluationContext {
	evaluatedAt: number;
	evaluator: CompletionEvaluator;
}

/** Convert the pure policy result into the finalized state-owned audit shape. */
export function completionDecisionToEvaluation(
	decision: CompletionDecision,
	context: CompletionEvaluationContext,
): CompletionEvaluation {
	const stateDecision: CompletionEvaluation["decision"] = decision.status === "accept"
		? "accept"
		: decision.status === "blocked" ? "blocked" : "revise";
	const fingerprint = stateDecision === "accept" || decision.blockingFailures.length === 0
		? null
		: rejectionFingerprint(decision.blockingFailures);
	return {
		decision: stateDecision,
		evaluatedAt: Number.isFinite(context.evaluatedAt) && context.evaluatedAt >= 0 ? context.evaluatedAt : 0,
		criterionCoverage: decision.judge.requirements.map((item) => ({
			criterionId: item.id,
			status: item.status,
			evidenceRefs: [...item.evidenceRefs],
			reason: item.reason,
		})),
		claimCoverage: decision.judge.claims.map((item) => ({
			claimId: item.id,
			status: item.support,
			evidenceRefs: [...item.evidenceRefs],
			reason: item.reason,
		})),
		findings: decision.blockingFailures.map((item) => ({ ...item })),
		advisories: [...decision.advisories],
		evaluator: { ...context.evaluator },
		fingerprint,
	};
}
