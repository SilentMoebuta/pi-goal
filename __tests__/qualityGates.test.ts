import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	checkCitationTraceability,
	checkSourceDiversity,
	checkConfidenceAnnotation,
} from "../extensions/quality-gates";

// 深修 C: 机器可验证质量门 — reviewer 检查清单的机器侧。
// 借鉴 CrewAI guardrail 模式:这些函数作为 reviewer 的检查清单输入,
// reviewer 综合判断(不单靠正则)。Design: design §四.3
// 注: spawn 覆盖度需 hook spawn_role/dag_execute,复杂,留 Phase 2。

describe("checkCitationTraceability — 引用可溯率 (URL/路径占比)", () => {
	it("returns 0 for text with no citations", () => {
		assert.equal(checkCitationTraceability("合同管理很重要"), 0);
	});

	it("detects http/https URLs", () => {
		const text = "数据见 http://example.com/report (来源)";
		assert.ok(checkCitationTraceability(text) > 0, "should detect URL");
	});

	it("detects file paths", () => {
		const text = "见 docs/research/report.md 第 5 节";
		assert.ok(checkCitationTraceability(text) > 0, "should detect file path");
	});

	it("detects source-ledger IDs used by Phase 3-lite reports", () => {
		const text = "CAS14 第五条支持该判断。[财务准则]+[官方来源:S1]。数据出境规则见 [网络调研:S3]。";
		assert.ok(checkCitationTraceability(text) > 0.5, "source IDs should count as traceable citations");
	});

	it("returns ratio in [0,1]", () => {
		const text = "数据1见 http://a.com 。数据2无来源 。数据3见 http://b.com 。";
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0 && r <= 1, `ratio should be in [0,1], got ${r}`);
	});

	// G4 (CLM 二次 live 测试): bare '.' splitter broke URLs (http://a.com → 2 clauses),
	// inflating denominator. Fix: split only on 。；; and period-when-followed-by-space/end,
	// so URLs with dots stay one clause. Regression guard.
	it("G4: does not split URLs containing dots (URL stays one clause, cited)", () => {
		const text = "数据见 http://example.com/report.html 第5节。";
		assert.equal(checkCitationTraceability(text), 1, "single cited clause → ratio 1.0 (was ~0.33 with bare '.' splitter)");
	});

	it("G4: does not treat \n as a clause separator (markdown structural lines must not inflate denominator)", () => {
		// Two data lines joined by newline, both cited. With \n in splitter this became
		// 4+ clauses (incl. empty fragments), diluting ratio. Without \n it's 2 cited clauses.
		const text = "数据1见 http://a.com 。\n数据2见 http://b.com 。";
		const r = checkCitationTraceability(text);
		assert.equal(r, 1, "two cited clauses → ratio 1.0 (\n must not split)");
	});

	it("G4: CLM-style mixed report (cited data + analysis prose) passes >=0.3 with URL-intact splitter", () => {
		// Regression for the CLM 二次 live 测试 failure (0.21 with bare '.' + \n splitter).
		// Root cause: '.' split broke URLs (http://a.com → 2 clauses) + \n split every
		// markdown line. Fix: split only on 。；; and period-when-followed-by-space.
		// Note: analysis prose without citations still counts toward denominator, but
		// with URLs intact the cited data claims dominate — no need for fragile
		// analysis-prose exclusion (YAGNI; real CLM report measures 0.655 with this fix).
		const text = [
			"Deloitte 报告显示全球合同管理年损失 $2T (置信度：高)。来源 http://deloitte.com/a.html 。",
			"WorldCC 调研 9.2% 收入泄漏 (置信度：高)。来源 http://worldcc.com/b.html 。",
			"Stanford RegLab AI 幻觉率 17-33%。来源 http://stanford.edu/c.html 。",
			"本节基于上述数据识别五个产品机会。", // analysis prose
			"推荐 MVP 选智能履约追踪 Agent。",   // analysis prose
		].join(" \n");
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.3, `CLM-style mixed report should pass >=0.3 with URL-intact splitter, got ${r.toFixed(3)}`);
	});

	// G5 (pi-goal live 复盘): three defects inflated the denominator and created a
	// perverse incentive (stacking more URLs in an appendix *lowered* the score).
	// Regression guards for each fix below.
	it("G5: strips markdown table separator rows (|---|---|) from the denominator", () => {
		// Table separators carry no URL but counted as clauses with bare 。/。 split.
		// |---|---| rows must not dilute the ratio.
		const text = "数据见 http://a.com 。\n|---|---|\n| 维度 | 内容 |\n数据2见 http://b.com 。";
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.5, `table separator rows should not dilute ratio, got ${r.toFixed(3)}`);
	});

	it("G5: pure-URL index appendix lines do not create a perverse incentive", () => {
		// A reviewer report with 3 cited argument clauses + a 100-URL index appendix.
		// With the old splitter the appendix URLs (no 。 between them) collapsed into 1
		// clause while the analysis prose dominated the denominator, so adding URLs
		// *lowered* the score. Fix: strip pure-URL index lines from the denominator.
		const text = [
			"结论1见 http://a.com 。",
			"结论2见 http://b.com 。",
			"结论3见 http://c.com 。",
			"",
			"- https://d.com https://e.com https://f.com",
			"- https://g.com https://h.com https://i.com",
		].join("\n");
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.3, `URL index appendix must not lower ratio below 0.3, got ${r.toFixed(3)}`);
	});

	it("G5: recognizes arxiv:2103.06268 and doi:10.xxx as traceable citations", () => {
		const text = "CUAD 基准见 arxiv:2103.06268 。ContractNLI 见 doi:10.18653/v1/2021.findings-emnlp.164 。无来源句。";
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.6, `arxiv/doi IDs should count as citations, got ${r.toFixed(3)}`);
	});

	it("G5: quoted original source excerpts count as traceable (they ARE citations)", () => {
		// A reviewer report dense with fetched paper abstracts (quoted English text) is
		// highly traceable, not untraceable. Each quoted/excerpt clause counts as cited.
		const text = [
			"结论1通过。",
			'"CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review curated by the Atticus Project with five hundred ten contracts and forty one clause types for legal document understanding research"',
			'"The task is to highlight salient portions of a contract that are important for a human reviewer”',
			"结论2见 http://a.com 。",
		].join("\n");
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.5, `quoted source excerpts should count as traceable, got ${r.toFixed(3)}`);
	});

	it("G6: full markdown table rows are stripped (shredded cells must not inflate denominator)", () => {
		// A table row | cell | cell | with no 。 gets split into cell fragments, none
		// carrying a URL, diluting the ratio. Table claims are re-stated in body prose,
		// so stripping whole rows (not just separators) is safe.
		const text = [
			"结论1见 http://a.com 。",
			"结论2见 http://b.com 。",
			"",
			"| 厂商 | 功能 | 来源 |",
			"|---|---|---|",
			"| Ironclad | AI Assist | http://ironclad.com |",
			"| DocuSign | Review | http://docusign.com |",
		].join("\n");
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0.5, `table rows should not dilute ratio, got ${r.toFixed(3)}`);
	});

	it("G6: floor guard keeps tables when report is table-only (tables ARE its argument)", () => {
		// A table-only report: stripping all rows would leave <10 clauses. The floor
		// guard falls back to keeping tables so the report isn't scored as empty/0.
		const text = [
			"| 厂商 | 功能 | 来源 |",
			"|---|---|---|",
			"| Ironclad | AI Assist | http://ironclad.com |",
			"| DocuSign | Review | http://docusign.com |",
			"| Icertis | Playbook | http://icertis.com |",
		].join("\n");
		const r = checkCitationTraceability(text);
		assert.ok(r > 0, `table-only report should not score 0 (floor guard), got ${r.toFixed(3)}`);
	});
});

describe("checkSourceDiversity — 来源多样性 (域名/机构数)", () => {
	it("returns 0 for no sources", () => {
		assert.equal(checkSourceDiversity("纯文本无引用"), 0);
	});

	it("counts distinct domains", () => {
		const text = "http://a.com http://a.com http://b.com http://c.com";
		const d = checkSourceDiversity(text);
		assert.ok(d >= 3, `should find >=3 distinct domains, got ${d}`);
	});

	it("counts distinct institution names in Chinese-style citations", () => {
		const text = "（来源：Deloitte）（来源：McKinsey）（来源：Deloitte）";
		const d = checkSourceDiversity(text);
		assert.ok(d >= 2, `should find >=2 distinct institutions, got ${d}`);
	});
});

describe("checkConfidenceAnnotation — 置信度标注完整性", () => {
	it("true when confidence annotation present", () => {
		assert.equal(checkConfidenceAnnotation("数据 X（置信度：高）"), true);
		assert.equal(checkConfidenceAnnotation("数据 X (来源:Y; 置信度:中)"), true);
	});

	it("false when no confidence annotation", () => {
		assert.equal(checkConfidenceAnnotation("数据 X（来源：Y）"), false);
	});

	it("detects high/中/low/猜测 variants", () => {
		assert.equal(checkConfidenceAnnotation("（置信度：低）"), true);
		assert.equal(checkConfidenceAnnotation("（置信度:猜测）"), true);
	});

	it("detects evidence labels used by PM/research reports", () => {
		assert.equal(checkConfidenceAnnotation("[强证据] WorldCC 调研显示收入泄漏。"), true);
		assert.equal(checkConfidenceAnnotation("[推理] 这说明流程治理是瓶颈。"), true);
		assert.equal(checkConfidenceAnnotation("[假设] 需要后续盲评验证。"), true);
	});
});
