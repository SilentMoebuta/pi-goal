# Headless Goal Blueprint — 设计文档

> date: 2026-08-06
> 目标: 让**外部 agent / 程序**能够启动一个 headless pi session, 运行一个**完全预先指定**的复杂 goal, 并以机器可读结果结束。
> 前置事实: 已通读 pi-goal 源码 + pi extension API(registerFlag / ctx.hasUI / session entries / ctx.shutdown)+ pi headless 模式(`-p`, `--mode json`, `--mode rpc`, stdin 合并)。
> **决策(2026-08-06 用户拍板): 执行语义 = 引导(guided)模式**——蓝图是强指令, agent 可偏离但必须显式记录偏离; 完成判定由现有 judge 负责, 蓝图相关校验为诊断级(advisory)而非可拒完成的硬闸。strict 模式留作 v2(加 `mandatory` 字段)。
> **追加需求(2026-08-06): 实时日志流**——headless 执行期间必须有结构化日志让外部 agent 实时把握进展(见 §7.2)。

---

## 1. 用例与需求

外部调用方(CI、另一个 agent、编排程序)需要:

```
pi --goal-run goal-spec.md -p "Run the goal to completion."
→ 无人工干预, 全自动跑完
→ 得到 <spec>.result.json: 状态/证据账本/完成评估/资源消耗
```

**调用方在启动前就要指定全部内容**(用户原话的展开):

| 需求 | 现状 | 缺口 |
|---|---|---|
| 目标 + 验收标准 | spec-doc markdown 已有 | 无(复用) |
| 证据账本预期 | 只有运行时记录, 无"每条 criterion 必须有什么证据"的声明 | **新增 evidence expectations(诊断级 + judge 参考)** |
| 是否用 DAG / spawn roles | execution 只有 topology/role 字段, 角色必须是已注册目录 | **新增 blueprint(roleDefs + dag 声明, 引导执行)** |
| 临时 role 定义 | spawn_role/dag_execute 支持 roleDef, 但 pi-goal 强制走 list_roles 目录 | **蓝图内嵌 roleDefs** |
| reviewer 检查内容 | 只有 reviewRequirement/深度, checklist 无处声明 | **新增 review.checklist + reviewer roleDef** |
| 完成条件 | completion policy v2 已有(criteria/claims/evidence) | 加 **evidenceSpec 机械校验** |
| 机器可读结果 | 只有 session entries + telemetry.jsonl, 无统一出口 | **新增 result 文件契约** |

---

## 2. pi 平台事实(设计约束)

- **入口**: extension 可 `pi.registerFlag("goal-run", { type: "string" })` + `pi.getFlag("goal-run")`(plan-mode 同款模式); 三种非交互模式(`-p` / `--mode json` / `--mode rpc`)都接受 flags。
- **无 UI 语义**: 非交互模式下 `ctx.hasUI === false`; 现有 `propose_goal_draft` 已有 `if (!ctx.hasUI)` 直建路径, 但仍需模型先调用工具(模型起草)。
- **循环能力**: goal 的 `sendContinuation`(`triggerTurn: true, deliverAs: "followUp"`)在 headless 下可持续驱动 agent 直到 goal 停住; `-p` 在 agent 停住后退出。
- **持久化**: session entries 跨进程可重建(reconstruct), 重启可继续。
- **退出**: `ctx.shutdown()` 优雅退出; extension 在进程内运行, 可 `process.exitCode = N` 影响退出码(待实测确认)。
- **信任**: 非交互模式不弹信任框; `--approve` / trusted project 才加载项目本地资源。verifyCommand 等任意 shell 必须 trusted-only。

---

## 3. 入口设计

### 3.1 主入口: CLI flag(确定形态)

```bash
# 最简(print 模式, 跑完打印 summary 后退出)
pi --approve --goal-run spec.md -p "Run the goal defined by --goal-run to completion."

# 实时监控(json 事件流, 调用方解析事件)
pi --approve --mode json --goal-run spec.md -p "..."

# 程序化驱动(rpc, 调用方全程控制)
pi --approve --mode rpc --goal-run spec.md
```

新增 flags(注册在 pi-goal extension):

| Flag | 类型 | 说明 |
|---|---|---|
| `--goal-run <path>` | string | 加载并运行 headless blueprint spec; 缺省路径解析相对 cwd |
| `--goal-output <path>` | string | 结果 JSON 路径, 默认 `<spec>.result.json` |
| `--goal-log <path>` | string | 实时结构化日志(JSONL)路径, 默认 `<spec>.goal.jsonl` |

行为:
1. startup 校验 flag → `session_start` 时解析 spec。
2. **验证失败 → 立即报错 + `process.exitCode = 1` + 退出**(fail-fast, 不进入模型)。
3. 验证通过 → `createGoalFromBlueprint()` 直接建 GoalStateV2(不走 propose_goal_draft、不走 LLM 起草、不走 review UI)→ `sendContinuation` 开跑。
4. 终态(complete/unmet/blocked/paused/budget_limited/usage_limited)→ 写 result 文件 + 发 `pi-goal:headless_result` 事件(json 模式可见)+ `ctx.shutdown()` 退出。

### 3.2 交互式补充入口: `/goal run <path>`

同一蓝图文件在交互式会话里可用 `/goal run <path>`(有 UI 时确认一次后运行, 复用 `/goal apply` 的解析但走完整生命周期)。headless 下该命令即无确认直跑。**保证 flag 与命令共用同一 `validateBlueprint` + `createGoalFromBlueprint` 代码路径。**

### 3.3 明确不做(v1)

- 不做 LLM 起草(蓝图即最终契约; 半自动起草留作 v2, 可加 `"draft": true` 字段)。
- 不做严格强制(蓝图节点执行不作可拒完成的硬闸; 若 v2 需要, 加 `"mandatory": true` 字段 + 机械校验)。
- 不做云端执行(见竞品评估: 结构性差距, 非本特性范围)。
- 不并行多 goal(保持单 goal 状态机, 调用方自己并行多个 pi 进程)。

---

## 4. 蓝图 spec 格式

复用现有 spec-doc 的 markdown 文本段落(objective / criteria / constraints / claims / decisions / structure), 新增一个机器块:

````markdown
# <title>

## Objective
...

## Criteria
- [ ] `blocking` - auth 模块完成 JWT 迁移, 由测试套件验证
- [ ] `advisory` - README 更新

## Constraints
- 不新增依赖
- 保持 47 个存量测试通过

## Claims
- `migration-parity` (material · high) JWT 迁移与旧 session 认证等价

## Blueprint (machine block)

```json
{
  "blueprint": {
    "entry": {
      "prompt": "额外启动指令(可选, 注入首次 continuation)"
    },
    "execution": {
      "topology": "team",
      "roleDefs": [
        {
          "name": "migrator",
          "description": "JWT 迁移专家",
          "prompt": "你负责 src/auth 迁移...",
          "tools": ["read", "bash", "edit", "write", "grep", "find"],
          "maxTurns": 200,
          "model": "deepseek/deepseek-v4-flash",
          "thinkingLevel": "medium"
        }
      ],
      "dag": {
        "nodes": [
          {
            "id": "research",
            "roleDef": "migrator",
            "task": "分析现有 session 认证, 输出迁移影响面",
            "expected_output": "影响面清单: 文件/契约/测试",
            "consumers": ["implement"]
          },
          {
            "id": "implement",
            "roleDef": "migrator",
            "task": "实现迁移 + 补齐测试",
            "expected_output": "src/auth/jwt.ts 与通过的全量测试输出",
            "consumers": ["$result"]
          }
        ],
        "maxConcurrent": 2
      }
    },
    "evidence": {
      "criteria": [
        {
          "id": "c1",
          "kinds": ["artifact", "command"],
          "minCount": 1,
          "verification": "verified",
          "note": "artifact 必须指向测试输出文件; command 必须是测试运行结果"
        }
      ],
      "nodes": [
        { "id": "research", "evidenceKind": "artifact", "attachTo": "c1" },
        { "id": "implement", "evidenceKind": "command", "attachTo": "c1" }
      ]
    },
    "review": {
      "requirement": "required",
      "model": "anthropic/sonnet",
      "thinkingLevel": "high",
      "tools": ["read", "bash", "grep", "find"],
      "checklist": [
        "对照影响面清单逐一确认迁移覆盖",
        "运行契约测试并核对输出",
        "确认无新增依赖"
      ],
      "maxTurns": 120
    },
    "verification": { "command": "npm test", "timeoutMs": 120000 },
    "budget": { "tokens": 500000 },
    "completion": { "policy": "v2", "maxAutoTurns": 200 }
  }
}
```
````

设计要点:
- `roleDefs` 与 pi-roles 的 `spawn_role roleDef` / `dag_execute node.roleDef` schema 一一对应(name/description/prompt/tools/maxTurns/model/thinkingLevel)——**无需改动 pi-roles, 蓝图即映射**。
- `dag.nodes[].roleDef` 引用 roleDefs 的名字(**强校验**: 必须存在, 否则验证失败)。
- `evidence.nodes` 把"DAG 节点执行"映射为可机械检查的证据要求——完成策略据此判定"蓝图被执行了", 而不是靠 LLM 自述。
- `review` 生成 reviewer 的 roleDef(临时角色), checklist 拼进 reviewer prompt; 走现有 `update_goal record_review` 真实性验证, 零改动。
- `verification.command` 与现有 `verifyCommand` 同语义, **仅 trusted project 生效**(`--approve` 或已信任); 否则验证阶段即报错。

---

## 5. 生命周期(guided 模式)

```
调用方: pi --goal-run spec.md -p "..."
   │
   ├─[startup] registerFlag 解析 → session_start
   ├─[parse+validate] parseGoalSpecMarkdown + validateBlueprint(schema/引用/trust)
   │    失败 → stderr 错误 + exitCode=1 + shutdown        ← fail-fast
   ├─[create] createGoalFromBlueprint() → GoalStateV2
   │    criteria/claims 来自 md; execution/review/budget 来自 blueprint;
   │    evidenceSpecs + blueprint 原文存入 goal(供策略与 prompt 使用)
   ├─[loop] sendContinuation(headlessPrompt):
   │    objective + criteria + evidence expectations(期望)
   │    + blueprint 指令(预期执行声明的 DAG/roles, roleDefs 已给出;
   │      如偏离, 必须 update_goal record_deviation 显式记录)
   │    + review 要求与 checklist + budget 提醒
   │    ← 复用现有 turn accounting / no-progress / drift-check / stuck-escalation / budget / usage_limited
   ├─[deviation] agent 偏离蓝图时: update_goal({ action: "record_deviation",
   │    subjectId?, description, reason, impact }) → 存入 goal.deviations
   │    (新 action, 轻量: 不入证据账本, 只进状态 + result + judge 上下文)
   ├─[completion] request_completion → V2 judge(证据包 + verifyCommand 输出
   │    + 蓝图声明 + deviations 列表——judge 语义评估期望是否满足、偏离是否可接受)
   │    + evidenceSpec 机械校验结果作为 ADVISORY(不 blocking)
   │    review=required 时: agent spawn_role(reviewer roleDef) → record_review(真实性验证)
   ├─[terminal] 任一终态:
   │    writeGoalResult(spec, goal) → <spec>.result.json(含 deviations 清单)
   │    发 pi-goal:headless_result 事件
   │    process.exitCode = status==="complete" ? 0 : 1
   │    ctx.shutdown()
   └─[异常] 进程被杀 / session_shutdown → 尽力写 result(status=interrupted)
```

**暂停语义(重要)**: headless 无用户可问。所有暂停类状态(paused / budget_limited / usage_limited / blocked)都是**终局**——停止循环、写 result(status 如实标注 + pausedReason)、退出。调用方根据 status 决定重试(加预算/换 spec)或放弃。不会无限挂起: 现有 maxAutoTurns / no-progress / 3 连拒 pause 全部生效。

---

## 6. 完成策略扩展(guided: 诊断 + 偏离账本)

### 6.1 证据期望 → 诊断级(advisory)

`validateCompletionPolicy` 增加**确定性输入**作为诊断, 不阻塞完成:

```
evidenceSpecs: [{ criterionId, kinds[], minCount, verification? }]
blueprintNodeEvidence: [{ nodeId, evidenceKind, attachTo }]
```

机械计算(纯函数, 可单测), 结果进入 `advisories` 而非 `failures`:
1. 每个 criterion 按 `evidenceRefs` 从 ledger 取条目, 按 kind 计数是否 ≥ minCount; `verification: "verified"` 时是否全部 verified(artifact 由 mechanicallyVerifyEvidence 保证, command 类由 verifyCommand 结果绑定)。
2. 每个蓝图节点是否有 kind 匹配的证据挂到 attachTo 的 criterion。
3. 不满足 → advisory("blueprint_evidence_missing", subjectId=criterionId/nodeId)。

**judge 参考**: 证据期望 + 蓝图声明 + deviations 一起进 judge 的 bounded packet——judge 语义评估"期望是否达成、偏离是否危及 criterion"。judge 仍可因 criterion 本身未满足而拒完成(现有逻辑), 但不因"没按蓝图跑"机械拒绝。

### 6.2 偏离账本(deviations)

新增 `update_goal({ action: "record_deviation" })`, 参数:

```ts
{ subjectId?: string;      // 可空; 指向 criterion/claim 或蓝图节点 id
  description: string;     // 偏离了什么
  reason: string;          // 为什么偏离
  impact: string;          // 对验收标准的影响(无/部分/风险)
}
```

- 存入 `goal.deviations[]`(有限长度, 如 ≤20, 超出折叠为 summary), 不进入证据账本(避免污染 criterion 证据语义)。
- `get_goal` public view + result 文件均包含; judge 与 reviewer 都看得到(偏离影响验收时 reviewer/judge 应拒)。
- **这是 guided 模式的信任机制**: 调用方通过 result.deviations 审查 agent 的自作主张——"偏离不可怕, 不报告的偏离才可怕"。

### 6.3 与 strict 的关系(v2)

将来若需硬契约: `blueprint.mandatory: true` 时, 6.1 的机械结果从 advisory 升级为 blocking failure, 其余不变。设计上已为此留好接口(同一纯函数, 两档阈值)。

---

## 7. 结果文件契约(schemaVersion 1)

### 7.1 终态结果文件 `<spec>.result.json`

```json
{
  "schemaVersion": 1,
  "specPath": "goal-spec.md",
  "startedAt": 1786..., "endedAt": 1786...,
  "status": "complete",
  "objective": "...",
  "taskKind": "coding",
  "criteria": [{ "id": "c1", "description": "...", "level": "blocking", "status": "verified", "evidenceRefs": ["e1"] }],
  "evidenceLedger": [{ "id": "e1", "kind": "artifact", "summary": "...", "locator": "path", "verification": "verified" }],
  "claims": [{ "id": "migration-parity", "materiality": "material", "status": "supported" }],
  "execution": { "topology": "team", "role": null, "source": "blueprint", "reasons": [] },
  "deviations": [{ "subjectId": "dag.nodes.implement", "description": "改为单角色串行实现", "reason": "影响面分析显示无并行空间", "impact": "无" }],
  "review": { "requirement": "required", "status": "passed", "checklist": ["..."] },
  "completion": { "decision": "accept", "findings": [], "advisories": ["blueprint_evidence_missing: node research 无 artifact 证据"], "evaluator": { "kind": "judge", "model": "..." } },
  "resources": { "tokensUsed": 123456, "tokenBudget": 500000, "activeMs": 3600000, "wallMs": 3800000 },
  "exit": { "code": 0, "message": "Goal achieved." }
}
```

- 与 `get_goal` 的 public view 同构(调用方只学一个 schema)。
- `exit.code` 由 extension 换算(complete=0, 其余=1), 同时尝试 `process.exitCode`; **契约以 result 文件为准, 退出码为尽力而为**(需实测 -p 模式下是否保留)。
- json 模式下调用方也可直接监听 `pi-goal:headless_result` 事件, 不读文件。

### 7.2 实时日志流 `<spec>.goal.jsonl`(追加式, 外部 agent 实时把握)

**为什么是文件**: `-p` 模式 stdout 只在结束时打印; `--mode json` 事件流含全部工具调用(噪音大且只对 json 调用方可用); RPC 调用方若周期注入 `/goal status` 会触发 input 事件、清掉续跑定时器(干扰执行)。**追加式 JSONL 文件是所有模式通用的实时通道, 且进程被杀也存活**。

每条一个 JSON 对象, schemaVersion 1:

```json
{ "v": 1, "ts": 1786..., "goalId": "...", "type": "evidence_recorded", "entry": { "id": "e1", "kind": "artifact", "summary": "...", "verification": "verified" } }
```

| type | 触发点 | 关键载荷 |
|---|---|---|
| `goal_started` | 蓝图创建成功 | objective、topology、criteria 摘要、budget、log/output 路径 |
| `status` | 任何状态变更 | status、pausedReason/blocker、progress 快照 |
| `turn_settled` | 每个 goal-driven turn 结算 | tokensUsed、activeMs、noProgressCount、autoTurnCount、progress 快照 |
| `progress` | 有意义的进展变更(证据/评估/评审后) | 完整 progress 快照(与 /goal status 同构) |
| `evidence_recorded` | record_evidence 成功 | 账本条目 + verification |
| `deviation_recorded` | record_deviation 成功 | 偏离条目 |
| `completion_requested` | request_completion | summary |
| `completion_evaluated` | V2 judge 返回 | decision、findings、advisories、fingerprint |
| `review_recorded` | record_review 成功 | review status、findings 摘要 |
| `budget_warning` | 50%/80%/90% 预算线 | tokensUsed、tokenBudget、percent |
| `paused` / `resumed` | 暂停/恢复 | reason |
| `drift_check` | 漂移检测触发暂停 | reason |
| `terminal` | 终态 | 与 result.json 同构的完整结果 |

实现要点:
- 由 extension 在事件处理点 append(与 telemetry.jsonl 同模式, 复用 append 工具函数), 每行 ≤ 若干 KB(progress 快照截断字段), 文件 > 10MB 时写入一条 `log_truncated` 标记并停止追加(防失控)。
- **每个事件都带 progress 快照**, 外部 agent 无需调 get_goal 即可重建当前状态。
- 同内容同步发 `pi-goal:headless_event` custom message(display:false), 供 `--mode json` / rpc 调用方在带内消费。
- 调用方契约: `tail -f <spec>.goal.jsonl` 或按行轮询; 以 `terminal` 行为完成信号(其载荷与 result.json 相同)。

### 7.3 事件回显

`pi-goal:headless_result`(终态)与 `pi-goal:headless_event`(实时)两类 custom message, display:false, 内容与日志条目同构。json 模式调用方直接消费; `-p` 模式调用方读文件。

---

## 8. 安全

| 项 | 处理 |
|---|---|
| `verification.command`(任意 shell) | 仅 trusted project(`--approve` 或已信任); 否则 validate 失败并给出明确报错 |
| `roleDefs`(任意 prompt) | 是模型指令不是 shell; 但会操纵 agent 行为 → result 文件与 README 注明"蓝图即代码, 只跑可信来源的 spec" |
| `review` 角色 | 同 roleDef; 且 record_review 真实性验证不变 |
| 结果文件 | 写入 `<spec>.result.json`, 覆盖前备份旧文件(`.prev`) |
| fail-fast | 任何解析/校验/信任错误在模型启动前终止, 不消耗 token |

---

## 9. 实现计划(TDD)

1. **spec-doc.ts**: `Blueprint` 类型 + `parseBlueprint(md)` + `blueprintToMarkdown`(round-trip 测试)。
2. **state.ts**: `GoalStateV2.blueprint?` + `deviations[]` + `record_deviation` action 类型 + schemaVersion 2 兼容迁移。
3. **update-goal-action-v2.ts**: `record_deviation` 归一化与校验(字段必填、subjectId 存在性、长度上限)。
4. **headless.ts(新模块)**: flags 注册、`validateBlueprint`、`createGoalFromBlueprint`、`writeGoalResult`、`appendGoalLog`(JSONL 实时日志, 含截断保护)、`pi-goal:headless_event`/`headless_result` 事件、fail-fast。
5. **prompt-blocks.ts**: `headlessContinuationPrompt`(蓝图指令 + 偏离必报要求 + 证据期望 + review checklist 注入)。
6. **completion-policy-v2.ts**: evidenceSpec + blueprint 节点机械计算 → advisory(纯函数, 留 mandatory 升级口)。
7. **index.ts**: `--goal-run` 接线(session_start 分支)、record_deviation handler、日志钩子(status/evidence/deviation/completion/review/turn 结算/预算线)、终态写 result + terminal 日志、`/goal run` 命令。
8. 测试: 解析 round-trip / 校验失败矩阵 / record_deviation / 诊断级机械计算 / 生命周期(模拟终态写文件)/ result schema / 日志条目序列。
9. 验证: `npm test` + `npm run typecheck` 全绿; 手工跑一次 `pi --goal-run` 冒烟。

---

## 10. 已定决策与剩余待定

**已定(2026-08-06)**:
1. 执行语义 = **guided**(本文全部按此设计; strict 留 v2 的 `mandatory` 字段)。

**剩余待定**:
2. 入口形态: flag + `/goal run` 双入口(推荐, 已按此设计)vs 仅 flag。
3. maxAutoTurns 默认: 沿用 200 还是 blueprint 必须显式声明(倾向: 显式声明优先, 缺省 200)。
4. exitCode 机制: 实测 `process.exitCode` 在 `-p` 模式的有效性, 不可用则只靠 result 文件 + 事件。
5. `record_deviation` 是否允许在交互式会话使用(建议允许——对任何 goal 都是有用的诚实机制, 且 judge 上下文已含蓝图时才生效)。

---

## 11. 实现状态(2026-08-06 已完成)

- **代码**: 7 个模块改动 + 新模块 `extensions/headless.ts`(+980 行), 5 个新测试文件(+47 测试)。`npm test` 417 全绿(基线 370), `npm run typecheck` 干净。
- **实现细节与设计的两处偏差**(实现中发现的真实问题):
  1. **headless print 模式下 agent_end 不按 turn 触发**(只在整个初始 run 结束时触发一次)——若只在 agent_end 评估完成请求, agent 请求后永远得不到 judge 反馈, 会在初始 run 里无限循环。**修复**: headless 模式下 turn_end 即评估 pending 的完成请求(与预算门同理), agent 在 run 内就拿到 accept/revise。
  2. **bootstrap 不立即 sendContinuation**: 初始 prompt 的 run 可能已在处理中, followUp 会被拒("Agent is already processing")。**修复**: 首轮 turn 结束后的 agent_end → scheduleContinuation 自然启动续跑循环。
- **端到端冒烟通过**(真实 harness, `--no-extensions -e index.ts`): 20s 完成——`goal_started → evidence_recorded(机械验证 verified) → completion_requested → completion_evaluated(accept) → terminal`, result.json `status=complete`、criterion `verified`、exit.code=0。
- **已知环境问题**: 用户环境里的 pi-hooks-system 扩展在 headless print 模式启动时自身报错(stale ctx), 可能中断整个 session; 冒烟用 `--no-extensions -e <pi-goal>` 规避。这是 pi-hooks-system 的问题, 非 pi-goal。
- **criterion id 约定**: spec 文档的 criterion 无 id 字段, 按文档顺序生成稳定 id `c1..cN`(specCriterionId), 蓝图证据期望引用这些 id。
