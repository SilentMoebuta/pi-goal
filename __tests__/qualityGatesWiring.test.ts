import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { verifyQualityGates } from "../extensions/config";

// 第3条: quality-gates 接线 (CLM run 复盘).
// 根因: quality-gates.ts 三个纯函数(checkCitationTraceability/checkSourceDiversity/
// checkConfidenceAnnotation) 定义了但无人调, canComplete 不查, reviewer 也没强制跑——
// "可验证层"=死代码 (handoff §八 根因5 残余).
// Fix: 抽 verifyQualityGates(reportText) 纯函数, update_goal handler 在 reviewerPassed=true
// 时读 reviewerVerdict.reportPath, 重跑此函数, 验 reviewer 自报的 checksPassed 真伪 + 达阈值.
// 不信任 reviewer 自报数值 (第2条: reviewer 可廉价满足).

describe("verifyQualityGates — 第3条 quality-gates 接线 (重跑验真伪)", () => {
	it("fails a report with no citations (traceability below threshold)", () => {
		const r = verifyQualityGates("合同管理很重要，但没有任何引用来源。");
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /citation|引用|traceab/i);
	});

	it("fails a report with citations but no confidence annotation", () => {
		const text = "数据见 http://a.com 。另见 http://b.com 。还有 http://c.com 。";
		const r = verifyQualityGates(text);
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /confidence|置信/i);
	});

	it("fails a report with < 3 distinct sources", () => {
		const text = "数据见 http://a.com （置信度：高）。";
		const r = verifyQualityGates(text);
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /divers|多样|source/i);
	});

	it("passes a report meeting all three thresholds", () => {
		const text = "数据1见 http://a.com （置信度：高）。数据2见 http://b.com （置信度：中）。数据3见 http://c.com （置信度：低）。";
		const r = verifyQualityGates(text);
		assert.equal(r.ok, true, `should pass, reason: ${r.reason}`);
	});

	it("returns the measured metrics alongside the verdict", () => {
		const text = "数据1见 http://a.com （置信度：高）。数据2见 http://b.com （置信度：中）。数据3见 http://c.com 。";
		const r = verifyQualityGates(text);
		assert.ok(r.metrics, "should return metrics");
		assert.ok((r.metrics!.citationTraceability ?? 0) > 0);
		assert.ok((r.metrics!.sourceDiversity ?? 0) >= 3);
		assert.equal(r.metrics!.confidenceAnnotated, true);
	});

	it("passes empty text as ok=false (no content to verify)", () => {
		assert.equal(verifyQualityGates("").ok, false);
	});
});

// G4 (CLM 二次 live 测试): citation-traceability threshold graded by taskType.
// research reports are data-dense (high citation bar); pm reports are analysis-dense
// (PRD/roadmap/优先级 legitimately cite fewer external sources). A single 0.3 bar
// mis-scores analysis-heavy work. Fix: per-taskType threshold (research 0.3, pm 0.2,
// review 0.3); undefined/legacy falls back to the default 0.3 (backward-compat).
describe("verifyQualityGates — G4 taskType-graded citation threshold", () => {
	// A report with ~0.25 traceability: 4 clauses, 1 cited (analysis-heavy, pm-style).
	// The cited clause carries 3 distinct domains so sourceDiversity (>=3) is NOT the
	// differentiator — only citationTraceability varies between taskType thresholds.
	const pmStyleReport = [
		"数据见 http://a.com http://b.com http://c.com （置信度：高）。", // cited, 3 sources
		"推荐 MVP 选智能履约追踪 Agent。",       // analysis
		"本产品机会差异化在于场景化。",         // analysis
		"第三阶段计划连接 ERP 系统。",         // analysis
	].join(" ");

	it("research taskType keeps the strict 0.3 bar (analysis-heavy report fails)", () => {
		const r = verifyQualityGates(pmStyleReport, "research");
		assert.equal(r.ok, false, "research bar is 0.3, this ~0.25 report should fail");
		assert.match(r.reason ?? "", /citation|引用|traceab/i);
	});

	it("pm taskType uses the relaxed 0.2 bar (same analysis-heavy report passes)", () => {
		const r = verifyQualityGates(pmStyleReport, "pm");
		assert.equal(r.ok, true, `pm bar is 0.2, this ~0.25 report should pass, reason: ${r.reason}`);
	});

	it("undefined taskType falls back to default 0.3 (backward-compat for legacy callers)", () => {
		const r = verifyQualityGates(pmStyleReport); // no taskType
		assert.equal(r.ok, false, "undefined taskType → default 0.3 bar → this report fails");
	});
});
