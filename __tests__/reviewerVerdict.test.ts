import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateReviewerVerdict, validateSingleRationaleApproved, canComplete, type ReviewerVerdict, type CompletableGoal } from "../extensions/config";

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

// G7 (single 自批禁): single 模式的 singleRationale 须由独立 reviewer 审核, 不得自批.
// 根因: single 模式下 main agent 可自给理由自过, 违反执行权与验收权正交.
// Fix: ReviewerVerdict 加 singleRationaleApproved, canComplete 验 single 模式时必须 true.
describe("G7: single rationale reviewer-approval gate (不能自给理由自过)", () => {
	function makeGoal(overrides: Partial<CompletableGoal> = {}): CompletableGoal {
		return {
			taskType: "research",
			executionMode: "single",
			singleRationale: "单点查证任务，无需多角度交叉验证，main agent 可直接检索官方文档确认，不涉及多源比对",
			reviewerPassed: true,
			reviewerVerdict: makeVerdict({ singleRationaleApproved: true }),
			criteria: [{ evidence: ["e1"] }, { evidence: ["e2"] }, { evidence: ["e3"] }],
			...overrides,
		};
	}

	it("validateSingleRationaleApproved: ok when single + reviewer approved true", () => {
		const g = makeGoal();
		const r = validateSingleRationaleApproved(g, g.reviewerVerdict!);
		assert.equal(r.ok, true);
	});

	it("validateSingleRationaleApproved: rejects single + reviewer approved false/missing (self-approve ban)", () => {
		const g = makeGoal({ reviewerVerdict: makeVerdict({ singleRationaleApproved: false }) });
		const r = validateSingleRationaleApproved(g, g.reviewerVerdict!);
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /singleRationaleApproved|自给理由|self-approv/i);
	});

	it("validateSingleRationaleApproved: no-op for orchestrated (rationale not required)", () => {
		const g = makeGoal({ executionMode: "orchestrated", reviewerVerdict: makeVerdict({ singleRationaleApproved: undefined }) });
		const r = validateSingleRationaleApproved(g, g.reviewerVerdict!);
		assert.equal(r.ok, true);
	});

	it("canComplete: rejects single+non-coding without reviewer singleRationaleApproved", () => {
		const g = makeGoal({ reviewerVerdict: makeVerdict({ singleRationaleApproved: false }) });
		const r = canComplete(g);
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /single rationale|singleRationaleApproved|自给理由/i);
	});

	it("canComplete: accepts single+non-coding with reviewer singleRationaleApproved=true", () => {
		const g = makeGoal();
		const r = canComplete(g);
		assert.equal(r.ok, true);
	});
});
