import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ExactTurnAccounting, wallElapsedMs } from "../extensions/turn-accounting";

const TURN = { turnId: "turn-1", goalId: "goal-1" } as const;

describe("ExactTurnAccounting live calculations", () => {
	it("combines committed active time with a live turn delta", () => {
		const accounting = new ExactTurnAccounting();
		assert.equal(accounting.beginTurn({ ...TURN, startedAtMs: 1_000 }), true);
		assert.equal(accounting.activeElapsedMs(TURN, 1_750), 750);
		assert.equal(accounting.effectiveElapsedMs(4_000, TURN, 1_750), 4_750);
	});

	it("clamps clock rollback instead of producing negative elapsed time", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 2_000 });
		assert.equal(accounting.activeElapsedMs(TURN, 1_500), 0);
		assert.equal(accounting.settleTime(TURN, 1_500).elapsedMs, 0);
	});

	it("computes wall time independently of active turns", () => {
		assert.equal(wallElapsedMs(1_000, 6_500), 5_500);
		assert.equal(wallElapsedMs(6_500, 6_000), 0);
	});
});

describe("ExactTurnAccounting exact-once settlement", () => {
	it("settles time exactly once", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });

		assert.deepEqual(accounting.settleTime(TURN, 2_250), {
			applied: true,
			elapsedMs: 1_250,
			reason: "applied",
		});
		assert.deepEqual(accounting.settleTime(TURN, 3_000), {
			applied: false,
			elapsedMs: 0,
			reason: "already_settled",
		});
		assert.equal(accounting.activeElapsedMs(TURN, 4_000), 0);
	});

	it("settles output tokens later and independently", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		accounting.settleTime(TURN, 2_000);

		assert.equal(accounting.isFullySettled(TURN.turnId), false);
		assert.deepEqual(accounting.settleTokens(TURN, 88), {
			applied: true,
			outputTokens: 88,
			reason: "applied",
		});
		assert.deepEqual(accounting.settleTokens(TURN, 88), {
			applied: false,
			outputTokens: 0,
			reason: "already_settled",
		});
		assert.equal(accounting.isFullySettled(TURN.turnId), true);
	});

	it("supports token-first settlement", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		assert.equal(accounting.settleTokens(TURN, 30).outputTokens, 30);
		assert.equal(accounting.settleTime(TURN, 1_500).elapsedMs, 500);
		assert.equal(accounting.isFullySettled(TURN.turnId), true);
	});

	it("combined settlement remains idempotent on duplicate turn_end", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		const first = accounting.settleTurn(TURN, 2_000, 40);
		const duplicate = accounting.settleTurn(TURN, 3_000, 40);

		assert.equal(first.time.elapsedMs, 1_000);
		assert.equal(first.tokens.outputTokens, 40);
		assert.equal(duplicate.time.elapsedMs, 0);
		assert.equal(duplicate.tokens.outputTokens, 0);
	});

	it("does not settle the wrong goal or an unknown turn", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		assert.equal(accounting.settleTime({ ...TURN, goalId: "other" }, 2_000).reason, "goal_mismatch");
		assert.equal(accounting.settleTokens({ turnId: "missing", goalId: TURN.goalId }, 10).reason, "unknown_turn");
		assert.equal(accounting.settleTime(TURN, 2_000).elapsedMs, 1_000);
	});

	it("makes duplicate begin idempotent but rejects turnId collisions", () => {
		const accounting = new ExactTurnAccounting();
		assert.equal(accounting.beginTurn({ ...TURN, startedAtMs: 1_000 }), true);
		assert.equal(accounting.beginTurn({ ...TURN, startedAtMs: 1_000 }), false);
		assert.throws(
			() => accounting.beginTurn({ ...TURN, goalId: "different", startedAtMs: 1_000 }),
			/turnId collision/,
		);
	});

	it("releases only after both dimensions settle", () => {
		const accounting = new ExactTurnAccounting();
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		accounting.settleTime(TURN, 2_000);
		assert.equal(accounting.release(TURN.turnId), false);
		accounting.settleTokens(TURN, 20);
		assert.equal(accounting.release(TURN.turnId), true);
		assert.equal(accounting.settleTime(TURN, 3_000).reason, "unknown_turn");
	});

	it("rejects invalid numeric accounting inputs", () => {
		const accounting = new ExactTurnAccounting();
		assert.throws(() => accounting.beginTurn({ ...TURN, startedAtMs: -1 }), /non-negative/);
		accounting.beginTurn({ ...TURN, startedAtMs: 1_000 });
		assert.throws(() => accounting.settleTokens(TURN, 1.5), /integer/);
		assert.throws(() => accounting.settleTime(TURN, Number.NaN), /non-negative/);
	});
});
