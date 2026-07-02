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

	it("returns ratio in [0,1]", () => {
		const text = "数据1见 http://a.com 。数据2无来源 。数据3见 http://b.com 。";
		const r = checkCitationTraceability(text);
		assert.ok(r >= 0 && r <= 1, `ratio should be in [0,1], got ${r}`);
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
});
