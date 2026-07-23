import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assessEvidence } from "../extensions/config";

// Evidence dedup + conflict detection: when an agent re-submits evidence for an
// already-evidenced criterion, near-duplicates are silently dropped (no value,
// just noise) and contradictions surface a console warning (but still record -
// the agent may be correcting itself). assessEvidence is the pure decision
// function extracted from update_goal's criterionId+evidence branch so it is
// unit-testable without spinning up the extension.

describe("assessEvidence - 去重 (near-duplicate -> duplicate:true, skip)", () => {
	it("identical string -> duplicate", () => {
		const r = assessEvidence("All tests pass", ["All tests pass"]);
		assert.equal(r.duplicate, true);
		assert.equal(r.conflict, undefined);
	});

	it("differs only by whitespace -> duplicate", () => {
		const r = assessEvidence("All   tests\t pass", ["All tests pass"]);
		assert.equal(r.duplicate, true);
	});

	it("differs only by case -> duplicate", () => {
		const r = assessEvidence("ALL TESTS PASS", ["all tests pass"]);
		assert.equal(r.duplicate, true);
	});

	it("one is a substring of the other (after whitespace normalization) -> duplicate", () => {
		const r = assessEvidence("tests pass", ["All tests pass here"]);
		assert.equal(r.duplicate, true);
	});

	it("Levenshtein distance < 10% of shorter length -> duplicate", () => {
		// "All tests pass" (14 chars) vs "All tests pas" (13 chars): 1 edit, 1/13 ~7.7% < 10%.
		const r = assessEvidence("All tests pas", ["All tests pass"]);
		assert.equal(r.duplicate, true);
	});

	it("matches any existing entry (not just the first)", () => {
		const r = assessEvidence("third", ["first", "second", "third"]);
		assert.equal(r.duplicate, true);
	});

	it("empty existing array -> never a duplicate", () => {
		const r = assessEvidence("first evidence", []);
		assert.equal(r.duplicate, false);
	});
});

describe("assessEvidence - 冲突警告 (contradiction -> conflict string, still records)", () => {
	it("passed vs failed -> conflict", () => {
		const r = assessEvidence("Tests passed", ["Tests failed"]);
		assert.equal(r.duplicate, false);
		assert.ok(r.conflict, "should flag a conflict");
		assert.ok(r.conflict!.length > 0, "conflict carries a description");
	});

	it("success vs not success -> conflict", () => {
		const r = assessEvidence("build success", ["build not success"]);
		assert.equal(r.duplicate, false);
		assert.ok(r.conflict);
	});

	it("中文 通过 vs 失败 -> conflict", () => {
		const r = assessEvidence("测试通过", ["测试失败"]);
		assert.equal(r.duplicate, false);
		assert.ok(r.conflict);
	});

	it("✅ vs ❌ -> conflict", () => {
		const r = assessEvidence("done ✅", ["done ❌"]);
		assert.equal(r.duplicate, false);
		assert.ok(r.conflict);
	});

	it("contradictory but near-duplicate -> duplicate wins (dedup takes priority)", () => {
		// If the new text is essentially a copy of an existing one, it's a dup
		// regardless of incidental negation words - no point recording a copy.
		const r = assessEvidence("Tests passed not", ["Tests passed"]);
		assert.equal(r.duplicate, true);
		assert.equal(r.conflict, undefined);
	});
});

describe("assessEvidence - 正常追加 (distinct evidence -> records, no flags)", () => {
	it("distinct new evidence -> not duplicate, no conflict", () => {
		const r = assessEvidence("Added unit tests for parser", ["Fixed memory leak in queue"]);
		assert.equal(r.duplicate, false);
		assert.equal(r.conflict, undefined);
	});

	it("multiple distinct existing entries, new unrelated one -> records", () => {
		const r = assessEvidence("documented the API", ["added tests", "fixed leak", "bumped version"]);
		assert.equal(r.duplicate, false);
		assert.equal(r.conflict, undefined);
	});

	it("similar topic but different outcome, well above the 10% threshold -> records (no false conflict)", () => {
		// "refactored module A" vs "refactored module B" differ by 1 char in 14
		// (~7%) - that IS a near-duplicate by the <10% rule and correctly deduped.
		// Use genuinely distinct work to exercise the normal-append path.
		const r = assessEvidence("refactored module A", ["added logging to controller"]);
		assert.equal(r.duplicate, false);
		assert.equal(r.conflict, undefined);
	});
});
