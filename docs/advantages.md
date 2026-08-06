# pi-goal 的优势(对照主流 harness 的 goal 功能)

> 依据: 2026-08-06 五轮网络调研, 对照 Claude Code `/goal`(v2.1.139)、OpenAI Codex `/goal`(v0.128.0)、Cursor Cloud Agents、Devin、Jules、Gemini CLI 等。
> 调研全文(含他人领先项与追赶建议)存于本地 `harness/docs/2026-08-06-goal-competitor-evaluation.md`; headless 设计文档见 [docs/design/2026-08-06-headless-goal-blueprint.md](docs/design/2026-08-06-headless-goal-blueprint.md)。

**一句话定位**: 主流 harness 的 goal 解决"让 agent 自主跑完", pi-goal 解决"跑完之后谁能证明它真的做完了"(completion integrity)——后者恰好是社区公认最痛、且各家都在补的验证问题。

## 1. 完成治理深度 — 唯一有 criteria→证据账本 + per-criterion 验证状态

- **Claude Code**: 评估器是独立小模型, 但**只看 transcript, 不跑命令、不读文件**(官方文档明说)。它无法区分"agent 声称测试通过"和"测试真的通过"。
- **Codex**: "evidence-based completion"由**执行模型自己判断**——maker 给自己打分, 是社区公认的失败模式(第三方文章同题讨论, 社区共识是额外配一个 read-only verifier subagent 补救)。
- **pi-goal**: judge 吃**持久化证据账本 + 可选的确定性 verifyCommand + 独立评审**, 三条独立证据通道互相印证; 每条 criterion 有 pending/evidenced/verified/blocked 状态。

## 2. 证据机械验证(Proof-or-Stop)— 不信任 agent 自报

artifact 类证据写入时由文件系统机械校验(存在性 + SHA-256): agent 声称 `verified` 但文件不存在 → 强制 `rejected`。Claude Code 与 Codex 都没有写入侧的防伪机制——它们的证据全靠模型自觉。

## 3. 独立评审的真实性验证 — 禁止自批

`record_review` 要求评审来自**真实 spawn 的 reviewer 会话**: 提交时读取 reviewer 的 session 文件(jsonl, pi-core 写入、主 agent 不可伪造), 提取其 report_role_result 的 findings, 校验与提交的 findings 逐条绑定(含证据 ID), 任何矛盾/无凭据的"已通过"都会被拒。Codex 的 auto-review 只审权限请求, 不审完成; Claude Code 没有对应物。

## 4. 3 连拒升级链 — 逼换策略, 而不是逼灌证据

同一拒绝指纹第 1 次: 反馈缺口; 第 2 次: 要求换验证策略或重新规划; 第 3 次: 暂停 goal 等用户输入。防的是"agent 往证据账本里堆同质证据直到 judge 烦了放行"。

## 5. 反指标崇拜 — 写进 policy, 不是口头约定

明确拒绝"完成百分比、URL 计数、来源数、角色数、波次数"作为完成门槛(全部只是诊断)。这是对社区正在踩的坑(verification theatre、specification drift)的事前免疫——CC/Codex 的社区文章还在教用户"别让 agent 自己宣布完成", 我们的策略层已经结构性禁止。

## 6. 完成策略可灰度回滚

`completionPolicy: legacy | shadow | v2` 三态: shadow 模式下 V2 评估作为审计数据记录但不生效, 可本地 canary 后切 v2, 出问题一键回滚。主流 harness 的 goal 都是"上了就上了"。

## 7. telemetry 回环 — 策略效果可校准

goal 终态写结构化 telemetry(jsonl): 路由选择、评审要求/结果、拒绝指纹序列、token 消耗。路由阈值、评审策略、拒绝门槛的真实效果有数据可看(`/goal telemetry`)。CC/Codex 的遥测在各自公司内部, 用户不可见。

## 8. spec 文档工作流 — 与社区共识殊途同归, 但产品内建

Codex 社区自发总结 GOAL.md / VERIFY.md / PROGRESS.md 三件套来保证长跑可审计——纯 prompt 约定, 靠 agent 自觉遵守。pi-goal 的 spec 文档(`/goal apply`、docs/goals/*.md)是**产品内建**: 文本段(目标/验收/约束)用户直接改, 机器字段(taskKind/执行/评审)JSON 无损恢复, 还有澄清循环(needsClarification → 逐问用户)防止"两三句话被展开成错误细节"。

## 9. Headless blueprint — 外部程序可控的自治

2026-08 新增: 外部 agent/程序可用 `pi --goal-run spec.md` 全自动跑**完全预指定**的 goal(roleDefs/DAG/证据期望/reviewer checklist/预算), 拿 `<spec>.result.json` 终态契约 + `<spec>.goal.jsonl` 实时事件流。guided 语义 + **偏离账本**(record_deviation)保证"agent 自作主张"可审计。主流 harness 的 goal 要么没有外部入口, 要么没有偏离透明机制。

## 10. 有界评估包 — 成本可控的完成审计

完成评估用**有界证据包**(截断 + 优先级排序 + 显式截断标记), judge 上下文不被账本无限撑大; 引用未知证据 ID 的判定直接无效。长跑目标的完成审计成本可预期。

---

## 诚实的另一面

差距集中在"平台"而非"信任": 云/异步执行(Codex Cloud、Claude Code 云会话、Cursor Cloud Agents)、移动端监督(Codex Remote)、workspace checkpoint/回滚(Claude Code /rewind)、多会话管理 UI(agent view)、Git/PR 闭环。详见调研文档 §2。
