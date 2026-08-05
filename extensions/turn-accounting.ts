export interface TurnIdentity {
	turnId: string;
	goalId: string;
}

export interface BeginTurnInput extends TurnIdentity {
	startedAtMs: number;
}

export interface TimeSettlement {
	applied: boolean;
	elapsedMs: number;
	reason: "applied" | "already_settled" | "unknown_turn" | "goal_mismatch";
}

export interface TokenSettlement {
	applied: boolean;
	outputTokens: number;
	reason: "applied" | "already_settled" | "unknown_turn" | "goal_mismatch";
}

export interface TurnSettlement {
	time: TimeSettlement;
	tokens: TokenSettlement;
}

interface TurnLedger extends BeginTurnInput {
	timeSettled: boolean;
	tokensSettled: boolean;
}

function finiteNonNegative(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(name + " must be a finite non-negative number");
	return value;
}

function tokenCount(value: number): number {
	finiteNonNegative(value, "outputTokens");
	if (!Number.isInteger(value)) throw new RangeError("outputTokens must be an integer");
	return value;
}

/** Wall time includes pauses and offline time; active elapsed only includes a live turn. */
export function wallElapsedMs(createdAtMs: number, nowMs: number): number {
	finiteNonNegative(createdAtMs, "createdAtMs");
	finiteNonNegative(nowMs, "nowMs");
	return Math.max(0, nowMs - createdAtMs);
}

/**
 * Tracks per-turn time and token settlement independently. A terminal state can
 * settle time immediately, while turn_end later settles output tokens exactly once.
 */
export class ExactTurnAccounting {
	private readonly turns = new Map<string, TurnLedger>();

	beginTurn(input: BeginTurnInput): boolean {
		if (!input.turnId) throw new TypeError("turnId must be non-empty");
		if (!input.goalId) throw new TypeError("goalId must be non-empty");
		finiteNonNegative(input.startedAtMs, "startedAtMs");
		const existing = this.turns.get(input.turnId);
		if (existing) {
			if (existing.goalId !== input.goalId || existing.startedAtMs !== input.startedAtMs) {
				throw new Error("turnId collision with different turn metadata: " + input.turnId);
			}
			return false;
		}
		this.turns.set(input.turnId, { ...input, timeSettled: false, tokensSettled: false });
		return true;
	}

	activeElapsedMs(identity: TurnIdentity, nowMs: number): number {
		finiteNonNegative(nowMs, "nowMs");
		const turn = this.match(identity);
		if (!turn || turn.timeSettled) return 0;
		return Math.max(0, nowMs - turn.startedAtMs);
	}

	effectiveElapsedMs(committedElapsedMs: number, identity: TurnIdentity, nowMs: number): number {
		finiteNonNegative(committedElapsedMs, "committedElapsedMs");
		return committedElapsedMs + this.activeElapsedMs(identity, nowMs);
	}

	settleTime(identity: TurnIdentity, settledAtMs: number): TimeSettlement {
		finiteNonNegative(settledAtMs, "settledAtMs");
		const turn = this.turns.get(identity.turnId);
		if (!turn) return { applied: false, elapsedMs: 0, reason: "unknown_turn" };
		if (turn.goalId !== identity.goalId) return { applied: false, elapsedMs: 0, reason: "goal_mismatch" };
		if (turn.timeSettled) return { applied: false, elapsedMs: 0, reason: "already_settled" };
		turn.timeSettled = true;
		return { applied: true, elapsedMs: Math.max(0, settledAtMs - turn.startedAtMs), reason: "applied" };
	}

	settleTokens(identity: TurnIdentity, outputTokens: number): TokenSettlement {
		tokenCount(outputTokens);
		const turn = this.turns.get(identity.turnId);
		if (!turn) return { applied: false, outputTokens: 0, reason: "unknown_turn" };
		if (turn.goalId !== identity.goalId) return { applied: false, outputTokens: 0, reason: "goal_mismatch" };
		if (turn.tokensSettled) return { applied: false, outputTokens: 0, reason: "already_settled" };
		turn.tokensSettled = true;
		return { applied: true, outputTokens, reason: "applied" };
	}

	settleTurn(identity: TurnIdentity, settledAtMs: number, outputTokens: number): TurnSettlement {
		return {
			time: this.settleTime(identity, settledAtMs),
			tokens: this.settleTokens(identity, outputTokens),
		};
	}

	isFullySettled(turnId: string): boolean {
		const turn = this.turns.get(turnId);
		return Boolean(turn?.timeSettled && turn.tokensSettled);
	}

	/** Release only fully-settled turns. Unknown turns are already effectively released. */
	release(turnId: string): boolean {
		const turn = this.turns.get(turnId);
		if (!turn) return true;
		if (!turn.timeSettled || !turn.tokensSettled) return false;
		this.turns.delete(turnId);
		return true;
	}

	private match(identity: TurnIdentity): TurnLedger | undefined {
		const turn = this.turns.get(identity.turnId);
		return turn?.goalId === identity.goalId ? turn : undefined;
	}
}
