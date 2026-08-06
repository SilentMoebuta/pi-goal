import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoalSpecMarkdown, proposalToMarkdown, slugifyTitle } from "../extensions/spec-doc";

const SAMPLE = {
	original: "实现 slugify 函数并通过测试",
	objective: "实现 slugify 函数（将字符串转为 URL 友好的 slug）并通过 npm test。",
	criteria: [
		{ description: "npm test 全部通过", level: "blocking" as const },
		{ description: "处理非 ASCII 字符行为合理", level: "advisory" as const },
	],
	constraints: ["不要新增运行时依赖"],
	claims: [
		{ id: "claim-1", text: "slug 应折叠空白", materiality: "material" as const, risk: "ordinary" as const, evidenceRefs: [] },
		{ id: "claim-2", text: "中文保留", materiality: "supporting" as const, risk: "high" as const, evidenceRefs: [] },
	],
	decisions: [
		{ question: "是否支持中文？", answer: "支持，保留中文" },
	],
	machine: {
		taskKind: "coding",
		execution: { preference: "direct", selected: "direct", source: "auto", reasons: ["小任务"] },
		assurance: { reviewRequirement: "advisory", reviewStatus: "pending", depth: "light", reasons: ["低风险"] },
	},
	createdAt: 1785930401979,
};

describe("goal spec markdown", () => {
	it("round-trips a full proposal through markdown", () => {
		const md = proposalToMarkdown(SAMPLE);
		assert.match(md, /^# Goal: 实现 slugify/);
		assert.match(md, /## 原始描述/);
		assert.match(md, /## 验收标准/);
		assert.match(md, /- \[ \] `blocking` npm test 全部通过/);
		assert.match(md, /## 机器字段/);

		const parsed = parseGoalSpecMarkdown(md);
		assert.equal(parsed.ok, true);
		assert.ok(parsed.doc);
		assert.equal(parsed.doc.objective, SAMPLE.objective);
		assert.equal(parsed.doc.original, SAMPLE.original);
		assert.deepEqual(parsed.doc.criteria, SAMPLE.criteria);
		assert.deepEqual(parsed.doc.constraints, SAMPLE.constraints);
		assert.deepEqual(parsed.doc.decisions, SAMPLE.decisions);
		assert.equal(parsed.doc.claims.length, 2);
		assert.equal(parsed.doc.claims[0].id, "claim-1");
		assert.equal(parsed.doc.claims[0].materiality, "material");
		assert.equal(parsed.doc.claims[1].risk, "high");
		// 机器字段从 JSON 块恢复
		assert.equal(parsed.doc.machine.taskKind, "coding");
		assert.equal(parsed.doc.machine.execution?.selected, "direct");
		assert.equal(parsed.doc.machine.assurance?.reviewRequirement, "advisory");
	});

	it("lets the user edit criteria levels and descriptions in markdown", () => {
		const md = proposalToMarkdown(SAMPLE);
		const edited = md
			.replace("- [ ] `blocking` npm test 全部通过", "- [ ] `blocking` npm test 全部通过且覆盖边界输入")
			.replace("- [ ] `advisory` 处理非 ASCII 字符行为合理", "- [ ] `blocking` 处理非 ASCII 字符行为合理");
		const parsed = parseGoalSpecMarkdown(edited);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.doc!.criteria, [
			{ description: "npm test 全部通过且覆盖边界输入", level: "blocking" },
			{ description: "处理非 ASCII 字符行为合理", level: "blocking" },
		]);
	});

	it("survives user edits to objective and constraints", () => {
		const md = proposalToMarkdown(SAMPLE);
		const edited = md
			.replace("\n" + SAMPLE.objective + "\n", "\n实现 slugify（含中文支持）并通过全部测试。\n")
			.replace("- 不要新增运行时依赖", "- 不要新增运行时依赖\n- 保持零依赖");
		const parsed = parseGoalSpecMarkdown(edited);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.doc!.objective, "实现 slugify（含中文支持）并通过全部测试。");
		assert.deepEqual(parsed.doc!.constraints, ["不要新增运行时依赖", "保持零依赖"]);
	});

	it("rejects a spec without an objective or criteria", () => {
		const noObjective = parseGoalSpecMarkdown("# Goal: X\n\n## 验收标准\n\n- [ ] `blocking` 有\n");
		assert.equal(noObjective.ok, false);
		assert.match(noObjective.error ?? "", /目标/);

		const noCriteria = parseGoalSpecMarkdown("# Goal: X\n\n## 目标\n\nsomething\n");
		assert.equal(noCriteria.ok, false);
		assert.match(noCriteria.error ?? "", /验收标准/);
	});

	it("handles checked boxes as done markers without changing level semantics", () => {
		const md = proposalToMarkdown(SAMPLE);
		const parsed = parseGoalSpecMarkdown(md.replace("- [ ] `blocking`", "- [x] `blocking`"));
		assert.equal(parsed.ok, true);
		assert.equal(parsed.doc!.criteria[0].level, "blocking");
	});

	it("slugifies titles deterministically", () => {
		assert.equal(slugifyTitle("Fix the Timer Bug!"), "fix-the-timer-bug");
		assert.equal(slugifyTitle("调研 中文 目标"), "调研-中文-目标");
		assert.equal(slugifyTitle("!!!"), "goal");
	});
});
