# Plan: 非 coding goal 流程漏洞加固（5条）

> date: 2026-07-02
> 起因: CLM research run 复盘（SESSION_HANDOFF §八更新版）
> taskType: coding | executionMode: single（main agent 直接 TDD，交付是代码）
> baseline: pi-goal `189c2ea`, 135 tests green, tsc 0

## 五条根因 + 解法（代码已确证）

| # | 根因 | 代码确证位置 | 解法 | 边界 |
|---|------|-------------|------|------|
| 1 | executionMode 默认 single 不强制 rolePlan，"判简单"偏见 | config.ts orchestratorConstraintBlock 只在 orchestrated 触发；index.ts:1127 executionMode optional | propose_goal_draft 对非 coding taskType 强制 executionMode（不填默认 orchestrated 或拒收） | coding 不动；不硬 deny 工具 |
| 2 | reviewer 严度不可控，可被廉价满足 | reviewer 是 spawn_role/内联 roleDef，配置全由 caller 定 | 定义 reviewer 最低能力契约，canComplete 验 reviewerPassed 之外验契约满足 | 契约固化 |
| 3 | quality-gates 死代码 | quality-gates.ts 三函数无人调；canComplete 不查 | 三个函数接入 canComplete/reviewer gate | 阈值待定 |
| 5 | research 阶段无 HARD-GATE | RESEARCH_GOVERNANCE 是 prompt 文字无 gate | research 加阶段 gate：collect/cross-validate 产出记录才能进 synthesize | 形式可验，实质不可 |
| 4 | subagent 产物不可核验 | report-tool.ts artifacts=string[]（schema 可自定义但默认松） | **仅调研**，对照 Claude Code/Codex，复杂则 backlog | 不改 pi-roles schema |

## TDD 实施步骤（每条 RED→GREEN→REFACTOR）

### Step 1: 第1条 executionMode 强制（pi-goal 内）
- RED: `propose_goal_draft` 传 taskType=research 但不传 executionMode → 被拒（或自动 orchestrated 并标记）
- RED: coding taskType 不传 executionMode → 正常（backward-compat）
- GREEN: index.ts propose_goal_draft handler + setGoal 加校验
- 文件: `extensions/index.ts` (setGoal/propose_goal_draft), `__tests__/` 新增
- 测试入口: governanceRouting.test.ts 或新 executionModeEnforce.test.ts

### Step 2: 第3条 quality-gates 接线（pi-goal 内，先做因最纯）
- RED: canComplete 对非 coding goal 调 checkCitationTraceability，低于阈值→拒
- RED: checkSourceDiversity < N → 拒
- RED: checkConfidenceAnnotation false → 拒（research/pm/report）
- GREEN: canComplete 加 quality-gates 调用，阈值常量化
- 文件: `extensions/config.ts` (canComplete), `extensions/quality-gates.ts` (可能加阈值)
- 阈值依据: 小样本（本次 CLM 报告）测出合理值，文档说明
- **注意**: canComplete 是纯函数，输入是 CompletableGoal（criteria+evidence），不含报告全文。需让 evidence 或 criterion 携带报告内容，或 reviewer gate 侧调 quality-gates（reviewer 能读产物）。倾向后者：quality-gates 在 reviewer gate 调，不在 canComplete——canComplete 看不到报告。

### Step 3: 第2条 reviewer 严度契约（pi-goal 内）
- RED: 非 coding goal complete 时，若 reviewerPassed=true 但 reviewer 配置不满足契约 → 拒
- GREEN: 定义 ReviewerContract（thinking≥medium, 工具含验源, checklist 注入）；spawn 侧记录 reviewer 配置；canComplete/reviewerPassed 写入时校验
- 文件: `extensions/config.ts` (ReviewerContract type + 校验), `extensions/index.ts` (update_goal reviewerPassed handler)
- **复杂点**: 如何让 canComplete 知道 reviewer 满足契约？reviewerPassed 由 main agent 调 update_goal 写入——需校验"spawn 的 reviewer 确实用了契约配置"。可能需 spawn_role 记录 reviewer 的 roleDef/model/thinking 到 GoalState。**这是最不确定的一条，可能简化**。

### Step 4: 第5条 research 阶段 gate（pi-goal 内）
- RED: research governance 进 synthesize 阶段需 collect 记录 + cross-validate 记录
- GREEN: 给 research 加阶段状态（类似 superpowers coding 阶段），canComplete 前验阶段产物存在
- 文件: `extensions/config.ts` (RESEARCH_GOVERNANCE + 阶段 gate 机制), `__tests__/`
- **难点**: coding 的 HARD-GATE 靠 superpowers skill + reviewer gate；research 无等效。可能做成"evidence 必须含 collect/cross-validate 记录"的形式 gate。

### Step 5: 第4条调研（research 子任务，spawn researcher）
- spawn researcher 对照 Claude Code subagent + Codex Task 的 result schema
- 输出 `docs/research/2026-07-02-subagent-artifact-schema.md`
- 含: 业界做法 + pi-roles 改造方案 + 复杂度评估 + 是否建议做

## 顺序与依赖

```
Step 2 (quality-gates 接线) → Step 3 (reviewer 契约，复用 quality-gates)
Step 1 (executionMode) 独立
Step 4 (research gate) 独立
Step 5 (调研) 独立，可并行/最后
```

先做 Step 2（最纯，无外部依赖），再 Step 1/4（独立），Step 3（依赖 Step 2 的 quality-gates 已接线），最后 Step 5 调研。

## 验证
- 每步 RED→GREEN 留测试
- 全程 npm test 全绿 + tsc 0
- 完成 spawn reviewer 验全链
- commit + push（每步或合并 push，handoff 教训3）

## 风险
- Step 3 reviewer 契约校验"spawn 用了什么配置"机制不清晰，可能简化为"契约写入 prompt + reviewer 自检 + reviewer 在报告里声明满足"的软约束（诚实标注）
- 阈值（第3条）需小样本调参，可能不准
- 第5条 research gate 形式验不等于实质验，根因5残余（诚实标注）
