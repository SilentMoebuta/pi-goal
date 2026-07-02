# 调研: subagent 产物回流 schema（第4条）

> date: 2026-07-02
> 起因: CLM run 复盘第4条 — subagent 产物不可核验
> 范围: 对照 Claude Code subagent (Agent/Task tool) + Codex subagent 的 result schema, 评估 pi-roles report_role_result 改造方案

## 一、业界做法

### Claude Code subagent（Agent tool）

Claude Code 的 subagent 通过 `Agent` tool（旧名 `Task`）派发。**返回值是 subagent 的最终 message（自然语言文本），不是结构化 schema。**

- 官方文档原话：*"only its final message returns to the parent"* / *"The parent receives a concise summary, not every file the subagent read"*（来源: https://code.claude.com/docs/en/agent-sdk/subagents ）
- Agent tool result 是 *"a text block containing `agentId: <id>`"*——纯文本块
- **无 findings/artifacts 字段，无结构化 schema**，就是文本摘要
- 已知 bug (#17591): v2.0.77 曾回归返回 raw JSONL transcript 而非摘要，说明"返回摘要"是设计意图，返回 transcript 是 bug

### Codex subagent

Codex 用 `wait_agent` 工具收集 subagent 结果，结果通过 `<subagent_notification>` envelope（v2 改为 typed envelope: NEW_TASK/MESSAGE/FINAL_ANSWER）传递。
- 官方文档原话：*"Return summaries from subagents instead of raw intermediate output"*（来源: https://developers.openai.com/codex/concepts/subagents ）
- 也是**摘要文本**，不是结构化 schema
- Codex 另有 `--output-schema` 给 `codex exec` 的最终输出做 JSON schema 约束，但这是 exec 级别（整个 run 的输出），不是 subagent 级别

### 对比结论

| 维度 | Claude Code | Codex | pi-roles (现状) |
|------|------------|-------|----------------|
| subagent 返回格式 | 纯文本摘要 | 纯文本摘要 | `{findings: string[], artifacts: string[]}` + 可自定义 outputSchema |
| 结构化程度 | 无 | 无 | **有**（比两者都强） |
| 产物可核验性 | 不可（文本无 schema） | 不可（文本无 schema） | 部分（artifacts 是描述性 string，非 {path, summary}） |

**关键发现: pi-roles 的 report_role_result 已经比 Claude Code 和 Codex 都更结构化**（T1-3 改造后支持 outputSchema 自定义）。第4条"产物不可核验"的根因不是 pi-roles schema 落后于业界，而是：

1. **默认 schema 的 artifacts 是 `string[]`（描述性）**，非 `{path/url, summary}`——但 schema 可被 role 自定义覆盖
2. **main agent 收到 findings 摘要就当事实用**，没核对产物——这是消费方（main agent）行为，不是 schema 问题

业界（Claude Code/Codex）连结构化 schema 都没有，纯文本摘要，它们的 main agent 也是直接用摘要文本。所以"产物不可核验"在业界是**普遍现状**，pi-roles 已是业界领先。

## 二、pi-roles 改造方案评估

### 方案 A: 改默认 schema（artifacts: string[] → {path/url, summary}[]）

- **复杂度**: 高。blast radius 大——所有现有 role 的 `report_role_result` 调用要适配新 schema，现有 DAG/spawn_role 消费方要改
- **收益**: artifacts 从描述性变可核验（main agent 能 read path 验证）
- **业界对照**: 无先例。Claude Code/Codex 没这么做，纯文本摘要
- **风险**: 破坏 backward-compat，所有存量 role 测试要改

### 方案 B: pi-goal 层加消费方约束（prompt: main agent 引用 finding 前必须 read artifact）

- **复杂度**: 低（prompt 层，不改 schema）
- **收益**: 软约束，强制 main agent 核对——但 LLM 可不遵守
- **业界对照**: 无先例。Claude Code/Codex 的 main agent 直接用摘要文本，不强制核对
- **风险**: 软约束效果存疑，且只对 pi-goal 生效（裸 spawn_role 不受约束）

### 方案 C: 不改（标注 backlog）

- **理由**: pi-roles 已有 outputSchema 可定制，真需要可核验产物的 role 可自定义 schema（如 reviewer verdict 的 reportPath 已是此模式的变体，第2条已用）；业界无先例；消费方行为约束是 prompt 层问题，不是框架缺陷
- **成本**: 0

## 三、结论与建议

**建议: 进 backlog 不做（方案 C）。理由如下:**

1. **pi-roles 已比业界强**: report_role_list 已支持 outputSchema 自定义，Claude Code/Codex 连结构化 schema 都没有。第4条的"不可核验"是相对理想而言，不是相对业界而言的退步。

2. **真正的解法是消费方约束，不是 schema 改动**: "main agent 引用 finding 前必须 read artifact" 是 prompt 层行为约束（方案 B），不该塞进 schema 层硬改（方案 A 过度工程，破坏 backward-compat）。

3. **第2条已部分覆盖此需求**: reviewer verdict 的 `reportPath` 字段已是"产物可核验"的变体——reviewer 必须给路径，update_goal handler 读它重跑 quality-gates（第3条）。这个模式（"声明产物路径 + 框架重验"）比改 artifacts schema 更轻、更精准。

4. **YAGNI**: 本次 CLM run 的失败不是"artifacts schema 不够结构化"，而是"main agent 没核验 subagent 输出"。后者已被第2+3条（reviewer verdict + quality-gates 重跑）结构性覆盖——reviewer 就是核验 subagent/producer 输出的独立方。再加 artifacts schema 是重复治理。

**触发条件（何时重做）**: 若未来出现"main agent 把 subagent 的虚构 finding 编进报告，且 reviewer 也没抓到"的真实失败，则重做方案 B（prompt 层消费方约束）。当前无此失败，不盲做。

## 四、来源与置信度

| claim | 来源 | 置信度 |
|-------|------|--------|
| Claude Code subagent 返回纯文本摘要 | https://code.claude.com/docs/en/agent-sdk/subagents (官方文档) | 🟢 高 |
| Codex subagent 返回摘要文本 | https://developers.openai.com/codex/concepts/subagents (官方文档, 403 时用 web_search 摘要) | 🟡 中 |
| pi-roles report_role_result 支持 outputSchema | pi-roles src/report-tool.ts + src/contract.ts (源码) | 🟢 高 |
| 两者 main agent 直接用摘要不核验 | 文档未明说, 基于"无结构化 schema"推断 | 🟠 低 |
