import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateReviewerVerdict } from "../extensions/config";

describe("legacy reviewer verdict diagnostics", () => {
	it("does not use model name or thinking level as a completion gate", () => {
		assert.equal(validateReviewerVerdict({ thinkingLevel: "low", checksPassed: false }).ok, true);
		assert.equal(validateReviewerVerdict({ model: undefined, verifiedSources: 1 }).ok, true);
	});

	it("treats source count as a non-negative diagnostic when present", () => {
		assert.equal(validateReviewerVerdict({ verifiedSources: 0 }).ok, true);
		const invalid = validateReviewerVerdict({ verifiedSources: -1 });
		assert.equal(invalid.ok, false);
		assert.match(invalid.reason ?? "", /diagnostic|non-negative/i);
	});
});
