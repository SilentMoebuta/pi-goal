import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSubagentSession } from "../extensions/config";

// Minimal ctx shape isSubagentSession reads. Mirrors the guard added to the
// session_start / session_tree handlers so an in-process subagent (fresh
// SessionManager with parentSession set) does not clobber the parent's
// in-memory `goal` closure.
type Ctx = Parameters<typeof isSubagentSession>[0];

function ctx(header: { parentSession?: string } | null): Ctx {
	return { sessionManager: { getHeader: () => header } };
}

describe("isSubagentSession", () => {
	it("returns true when parentSession is present (in-process subagent)", () => {
		assert.equal(isSubagentSession(ctx({ parentSession: "sess-abc" })), true);
	});

	it("returns false for a top-level session (no parentSession)", () => {
		assert.equal(isSubagentSession(ctx({})), false);
		assert.equal(isSubagentSession(ctx(null)), false);
	});

	it("returns false (not permissive-true) when getHeader is absent", () => {
		// Divergence from pi-plan-execute-gate: a missing header must NOT be
		// treated as a subagent here, or the parent's goal closure would be
		// skipped on headerless top-level sessions.
		assert.equal(isSubagentSession({ sessionManager: null }), false);
		assert.equal(isSubagentSession({ sessionManager: {} }), false);
	});

	it("returns false when getHeader throws", () => {
		const throwing: Ctx = {
			sessionManager: { getHeader: () => { throw new Error("boom"); } },
		};
		assert.equal(isSubagentSession(throwing), false);
	});
});
