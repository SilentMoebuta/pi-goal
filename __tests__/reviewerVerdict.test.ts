import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateReviewerVerdict, type ReviewerVerdict } from "../extensions/config";

// 第2条: reviewer gate 严度不可控 (CLM run 复盘).
// 根因: reviewerPassed 是裸布尔, main agent 调 update_goal({reviewerPassed:true}) 说 true 就 true,
// 框架不知道 reviewer 用了什么 model/thinking/验了多少源——reviewer 可被廉价满足
// (浅模型+low thinking+不验源, 读结构返回 APPROVE). handoff §八 根因2.
// Fix: reviewerPassed=true 必须携带 reviewerVerdict (结构化), canComplete 验契约满足.
// 契约: thinking≥medium, verifiedSources≥3 (验源下限), model 非空.
// 软约束: verdict 由 reviewer LLM 填, 但第3条 update_goal handler 重跑 quality-gates 验真伪.

function makeVerdict(overrides: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
	return {
		model: "deepseek/deepseek-v4-flash",
		thinkingLevel: "medium",
		verifiedSources: 3,
		checksPassed: true,
		reportPath: "docs/research/x.md",
		notes: "reviewed",
		...overrides,
	};
}

describe("validateReviewerVerdict — 第2条 reviewer 契约", () => {
	it("accepts a well-formed verdict (medium thinking, 3 sources)", () => {
		const r = validateReviewerVerdict(makeVerdict());
		assert.equal(r.ok, true);
	});

	it("rejects thinkingLevel=low (too shallow for independent review)", () => {
		const r = validateReviewerVerdict(makeVerdict({ thinkingLevel: "low" }));
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /thinking/i);
	});

	it("rejects missing thinkingLevel", () => {
		const r = validateReviewerVerdict(makeVerdict({ thinkingLevel: undefined }));
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /thinking/i);
	});

	it("rejects verifiedSources < 3 (验源下限)", () => {
		const r = validateReviewerVerdict(makeVerdict({ verifiedSources: 1 }));
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /source|验源|verified/i);
	});

	it("rejects missing model", () => {
		const r = validateReviewerVerdict(makeVerdict({ model: undefined }));
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /model/i);
	});

	it("rejects checksPassed=false (machine quality gates not satisfied)", () => {
		const r = validateReviewerVerdict(makeVerdict({ checksPassed: false }));
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /check/i);
	});

	it("accepts high/xhigh thinking (>= medium)", () => {
		assert.equal(validateReviewerVerdict(makeVerdict({ thinkingLevel: "high" })).ok, true);
		assert.equal(validateReviewerVerdict(makeVerdict({ thinkingLevel: "xhigh" })).ok, true);
	});
});
