# pi-goal

## Headless nested-agent runs

When a goal uses `spawn_role`, `pi-roles` streams sanitized child lifecycle
updates through the parent tool call. Headless runs persist these as
`subagent_started`, `subagent_progress`, and `subagent_completed` entries in the
goal JSONL log; heartbeat entries include currently active child IDs, roles,
phases, turn counts, tools, and readable archived session files.

Review remediation is patch-first. Findings can carry `scope` (`local`,
`section`, or `global`), `targetPath`, `sectionId`, `anchor`, `requiredFix`, and
an explicit `rewriteRequired`/`rewriteReason`. Local and section findings should
be edited in the existing artifact and re-reviewed by finding ID. A global
rewrite remains possible for exceptional structural failures, but requires the
explicit global flag and reason.

Persistent, evidence-aware goals for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Goal V2 keeps the objective, execution route, evidence, assurance decision, completion audit, and live resource usage across turns and session reloads.

The completion policy, verification strategy, and execution topology are separate decisions. A goal uses the least expensive topology that is sufficient, asks for independent review according to risk, and completes from outcome evidence rather than fixed counts of criteria, URLs, roles, or workflow waves.

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Interactive Usage](#interactive-usage)
- [Headless Blueprint Goals (external programs)](#headless-blueprint-goals-external-programs)
  - [Spec file format](#spec-file-format)
  - [Result file](#result-file)
  - [Real-time log](#real-time-log)
  - [Example: calling from a program](#example-calling-from-a-program)
  - [Designing token-efficient headless specs](#designing-token-efficient-headless-specs)
- [Model Tools](#model-tools)
- [Evidence And Completion](#evidence-and-completion)
- [State Machine](#state-machine)
- [Goal Progress View](#goal-progress-view)
- [Persistence](#persistence)
- [Configuration](#configuration)
- [Development](#development)

> Why this design? See [docs/advantages.md](docs/advantages.md) — how pi-goal's completion-governance model compares with Claude Code /goal, Codex /goal, and other harness goal features.

## Install

```sh
pi install git:github.com/SilentMoebuta/pi-goal
```

Adaptive `specialist` and `team` execution integrates with [`pi-roles`](https://github.com/SilentMoebuta/pi-roles). pi-goal remains usable without pi-roles; when the role catalog is unavailable, automatic routing falls back to `direct`.

## Quick Start

**1. Set a goal** — in a pi session, type:

```
/goal Migrate the auth module to JWT with proper error handling, keeping all 47 existing tests passing
```

The agent drafts a formal goal (objective + acceptance criteria + constraints), shows it to you for review (`start` / `edit` / `change execution`), and starts working automatically.

**2. Watch it run** — the footer shows a one-line summary, `/goal` (or `/goal status`) opens the full progress view:

```text
goal active | 1 blocking open | 12.4K tok | active 3m12s | wall 8m41s | DAG 2 running, 1 ready
```

**3. Interrupt or steer anytime** — just type a message; your input runs first and the goal resumes after. Use `/goal pause` for a resumable stop, `/goal resume` to continue, or `/goal cancel` to end the run with an audited terminal status.

**4. Completion is evidence-based** — when the agent believes it is done it calls `update_goal({ action: "request_completion" })`; a separate evaluator checks the evidence ledger, tests, and (if configured) a deterministic verification command. The goal completes only when blocking outcomes hold:

```
Goal achieved! ✅
```

**5. Optional token budget** — bound an autonomous run:

```
/goal <objective> --tokens 50k
```

## Interactive Usage

| Command | Description |
|---|---|
| `/goal draft <objective> [--tokens N]` | Draft a Goal V2 for review. `--tokens 50k` / `--tokens=1m` set an optional token budget. |
| `/goal review <spec>` | Review an editable goal spec without starting it. |
| `/goal start <spec-or-objective>` | Start a blueprint spec or enter the interactive draft/review flow for an objective. |
| `/goal` or `/goal status` | Show the unified Goal Progress view (route, outcomes, activity, evidence, assurance, health, resources). |
| `/goal run <spec.md>` | Start a blueprint spec through the interactive runtime. It shares the spec parser and Goal Contract with `--goal-run`, but keeps live steering and does not create headless result/log sidecars. |
| `/goal apply <spec.md>` | Load and review a goal spec document (edit it, then start). |
| `/goal pause` | Pause the active goal. |
| `/goal resume` | Resume a paused or limited goal. |
| `/goal cancel` | End a non-terminal goal as `cancelled`, preserving its snapshot, runtime event, and telemetry. |
| `/goal edit` | Edit the active goal and create a new revision. |
| `/goal fork` | Create a child run from the active goal's evidence and lineage. |
| `/goal clear` | Remove the current goal. |
| `/goal telemetry` | Show completed-goal statistics (routing, review, rejections, tokens) for policy calibration. |
| `/goal help` | Show usage. |

### Typical interactive flow

```
/goal Refactor the checkout service so p95 latency is under 120ms without regressing the correctness suite
```

1. The draft shows: task kind, execution route (direct/specialist/team), routing reasons, assurance decision, criteria, constraints.
2. Choose `start`, or `edit` to open the full spec document (markdown, `docs/goals/*.md`), or change execution preference.
3. The goal runs; record evidence as you work with `update_goal` (see [Model Tools](#model-tools)).
4. When blocking outcomes are satisfied, call `update_goal({ action: "request_completion", summary })` — the evaluator decides.
5. Rejections tell you exactly what is missing; repeated identical rejections escalate (feedback → replan → pause for your input).

## Headless Blueprint Goals (external programs)

An external agent or program can run a **fully pre-specified** goal in a headless pi session — no drafting, no review UI, no human in the loop — and consume machine-readable output:

```bash
pi --approve --goal-run spec.md -p "Run the goal defined by --goal-run to completion."
# live:   spec.goal.jsonl   ← tail -f while it runs (JSONL event stream)
# result: spec.result.json  ← terminal state + evidence ledger + completion audit
```

| Flag | Description |
|---|---|
| `--goal-run <path>` | Run a goal blueprint spec to completion. |
| `--goal-output <path>` | Result JSON path (default `<spec>.result.json`). |
| `--goal-log <path>` | Real-time JSONL log path (default `<spec>.goal.jsonl`). |

The blueprint spec pre-declares **everything** the run needs: execution topology, ad-hoc role definitions, an optional DAG, per-criterion evidence expectations, reviewer requirement + checklist, deterministic verification command, and a token budget. Blueprints are **guided**, not strict: the agent follows them as strong instructions and must record every deviation via `update_goal({ action: "record_deviation", ... })` — unreported deviations are the one unforgivable failure mode in a headless run. Deviations, evidence gaps, and the completion audit all land in the result file and the log.

### Spec file format

A blueprint spec is the regular goal spec markdown plus a `blueprint` JSON block in the machine section. Criterion ids are positional: `c1`, `c2`, … in document order. Full example (copy-paste ready):

````markdown
# Goal: JWT 认证迁移

## 原始描述

> 将 auth 模块从 session 认证迁移到 JWT

## 目标

将 src/auth 迁移到 JWT 中间件，保持 47 个存量测试通过，不新增运行时依赖

## 验收标准

- [ ] `blocking` npm run test:auth 与 npm run lint 全部通过
- [ ] `blocking` src/auth/jwt.ts 存在并导出 verifyToken
- [ ] `advisory` README 补充迁移说明

## 约束

- 不新增依赖
- 公开 API 保持不变

## 研究声明

- `migration-parity` (material · high) JWT 迁移与旧 session 认证等价

## 机器字段

```json
{
  "taskKind": "coding",
  "blueprint": {
    "execution": {
      "topology": "team",
      "roleDefs": [
        {
          "name": "migrator",
          "description": "JWT 迁移专家",
          "prompt": "你负责 src/auth 迁移：分析影响面、实现中间件、补齐测试。",
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
            "task": "分析现有 session 认证，输出迁移影响面清单",
            "expected_output": "影响面：文件/契约/测试清单",
            "consumers": ["implement"]
          },
          {
            "id": "implement",
            "roleDef": "migrator",
            "task": "实现 JWT 迁移并补齐测试",
            "expected_output": "jwt.ts 与全量测试通过输出",
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
          "note": "artifact 指向测试输出文件；command 是测试运行结果"
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
    "retry": { "maxInfrastructureAttempts": 5, "maxSchemaRepairs": 2, "baseDelayMs": 10000, "maxDelayMs": 120000 },
    "completion": { "policy": "v2", "maxAutoTurns": 200 }
  }
}
```
````

Blueprint fields:

| Field | Meaning |
|---|---|
| `entry.prompt` | Extra startup instructions injected into the headless goal. Use it for a short, explicit execution protocol when the efficient path is already known. |
| `execution.topology` | `direct` / `specialist` / `team`. |
| `execution.role` | A registered role from the pi-roles catalog (specialist topology). |
| `execution.roleDefs` | Ad-hoc role definitions (compatible with `spawn_role` / `dag_execute` roleDefs): name, description, prompt, tools, maxTurns, model, thinkingLevel. |
| `execution.dag` | Optional DAG: nodes (id, task, roleDef/role, expected_output, consumers, depends_on), maxConcurrent. |
| `evidence.criteria` | Per-criterion expectations: kinds (`artifact`, `command`, `source`, `tool_result`, `observation`, `user_confirmation`), minCount, verification. Gaps become advisories (diagnostic), not automatic rejections. |
| `evidence.nodes` | Map a DAG node / roleDef to evidence it should produce (`evidenceKind`, `attachTo` criterion). |
| `review` | Reviewer requirement + checklist + model/thinking. The checklist is injected into the spawned reviewer. |
| `verification.command` | Deterministic verification command run before each completion evaluation. **Trusted projects only** (pass `--approve` or trust the project). |
| `budget.tokens` | Token budget; the run stops at `budget_limited` with a result file. |
| `retry` | Bounded typed retry policy. Infrastructure failures start a fresh attempt after PI's provider retries settle; schema repairs do not consume an infrastructure attempt. Defaults: 5 total infrastructure attempts, 2 schema repairs, 10s base delay, 120s delay cap. |
| `completion.policy` | `legacy` / `shadow` / `v2`. |

Interactive goals can set the same defaults in trusted `.pi/goal.json` under `retryPolicy`; a blueprint's `retry` fields take precedence for that run.

### Result file

`<spec>.result.json` is written when the run reaches a terminal state (`complete`, `unmet`, `blocked`, `paused`, `budget_limited`, `usage_limited`). Schema (v1):

```json
{
  "schemaVersion": 1,
  "status": "complete",
  "objective": "将 src/auth 迁移到 JWT 中间件……",
  "criteria": [
    { "id": "c1", "description": "npm run test:auth 与 npm run lint 全部通过", "level": "blocking", "status": "verified", "evidenceRefs": ["e1"] }
  ],
  "evidenceLedger": [
    { "id": "e1", "kind": "command", "summary": "npm run test:auth 通过（47/47）", "verification": "verified" }
  ],
  "claims": [{ "id": "migration-parity", "materiality": "material", "evidenceRefs": ["e2"] }],
  "deviations": [{ "id": "d1", "subjectId": "dag.nodes.implement", "description": "改为串行实现", "reason": "无并行空间", "impact": "无" }],
  "execution": { "topology": "team", "source": "user" },
  "review": { "requirement": "required", "status": "passed", "checklist": ["……"] },
  "completion": { "decision": "accept", "findings": [], "advisories": [] },
  "resources": { "tokensUsed": 123456, "tokenBudget": 500000, "activeMs": 3600000, "wallMs": 3800000 },
  "exit": { "code": 0, "message": "Goal achieved." }
}
```

`exit.code` is `0` only for `complete`. The process also sets its exit code accordingly (best-effort). **The result file is the contract** — read it, don't parse stdout.

### Real-time log

`<spec>.goal.jsonl` is an append-only JSONL stream, one event per line — the external agent's live view (works with `tail -f`; survives process crashes):

```json
{"v":1,"ts":1786010786886,"goalId":"...","type":"goal_started","objective":"...","topology":"team","tokenBudget":500000}
{"v":1,"ts":1786010790000,"goalId":"...","type":"turn_settled","tokensUsed":217,"activeMs":4193}
{"v":1,"ts":1786010800000,"goalId":"...","type":"evidence_recorded","entry":{"id":"e1","kind":"command","summary":"...","verification":"verified"},"criterionIds":["c1"]}
{"v":1,"ts":1786010801000,"goalId":"...","type":"deviation_recorded","deviation":{"id":"d1","description":"..."}}
{"v":1,"ts":1786010802000,"goalId":"...","type":"completion_evaluated","decision":"revise","findings":[{"code":"blocking_requirement_unsatisfied","subjectId":"c1","reason":"..."}]}
{"v":1,"ts":1786010803000,"goalId":"...","type":"budget_warning","tokensUsed":4140,"tokenBudget":8000,"percent":50}
{"v":1,"ts":1786010804000,"goalId":"...","type":"terminal","result":{ "…same shape as spec.result.json…" }}
```

Event types: `goal_started`, `status`, `turn_started`, `turn_settled`, `tool_started`, `tool_ended`, `llm_response`, `heartbeat`, `evidence_recorded`, `deviation_recorded`, `completion_requested`, `completion_evaluated`, `review_recorded`, `budget_warning` (50%/80%/90%), `paused`/`resumed`, `terminal` (final; its `result` payload equals the result file). The `terminal` line is the completion signal. In `--mode json` sessions the same events are also echoed in-band as `pi-goal:headless_event` custom messages.

**Activity transparency** — the log exposes what pi is doing *inside* each turn, so a caller can tell "stuck" from "working on a big task":

| Event | Payload | Meaning |
|---|---|---|
| `turn_started` | `turnIndex` | A new LLM turn (reasoning round) began. |
| `llm_response` | `usage`, `stopReason` | One LLM response completed (`stopReason`: `toolUse` → will call a tool next; `end_turn` → turn finished; `error`/`aborted` → problem). |
| `tool_started` | `tool`, `args` (truncated 300) | A tool call began (bash/read/edit/…). |
| `tool_ended` | `tool`, `isError`, `durationMs`, `result` (truncated 500) | The tool finished — error flag and wall time make slow/failing calls obvious. |
| `heartbeat` | `phase` (`thinking`/`tool`/`specialist`/`dag`/`evaluating`/`waiting`/`idle`), `label`, `thinkingMs`, `lastActivityMsAgo`, `tokensUsed`, `activeMs` | Liveness signal every 30s while active. `thinkingMs` growing means a long reasoning round; `lastActivityMsAgo` small means the agent is actively working. |

**Stuck vs. big-task heuristic for callers**: if `heartbeat` lines keep arriving with `thinkingMs` increasing or `tool_started`/`tool_ended`/`llm_response` flowing, the agent is working. If no log line arrives for longer than your chosen timeout (default suggestion: 3× the 30s heartbeat interval), the process is likely dead — check the process and the result file.

### Example: calling from a program

```bash
#!/usr/bin/env bash
set -euo pipefail
SPEC=spec.md
rm -f "$SPEC.result.json" "$SPEC.goal.jsonl"

pi --approve --goal-run "$SPEC" -p "Run the goal defined by --goal-run to completion." &

# Poll for the terminal event (or tail the log for live progress)
for i in $(seq 1 600); do
  if [ -f "$SPEC.result.json" ]; then break; fi
  sleep 1
done

result=$(cat "$SPEC.result.json")
status=$(python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" <<< "$result")
echo "goal status: $status"
[ "$status" = "complete" ] || exit 1
```

For long runs, stream `tail -f "$SPEC.goal.jsonl"` and act on `budget_warning` / `completion_evaluated` / `terminal` lines as they arrive.

### Designing token-efficient headless specs

A headless blueprint can do more than describe the desired outcome. When the
caller already knows the relevant inputs, output path, review policy, and
verification command, the spec can also define a **bounded fast path**. This is
useful for repeatable production work where open-ended repository discovery,
duplicate self-review, or unnecessary role orchestration would spend tokens
without improving the result.

The goal is not to script every sentence the model must produce. Specify the
known control flow and boundaries, while leaving the substantive reasoning to
the agent:

| Put in the spec | Leave to the agent |
|---|---|
| Exact input and output paths | How to synthesize the supplied evidence |
| Required content blocks and outcome criteria | The clearest wording and local organization |
| Execution topology and reviewer tools | Reasoning inside the bounded task |
| When review and deterministic verification happen | How to fix a concrete reviewer finding |
| Evidence and completion action order | Whether a genuine ambiguity requires a recorded deviation |

#### Efficiency principles

1. **Prefer `direct` for one artifact.** A team or DAG adds value only when
   there are genuinely independent workstreams. Risk can require a reviewer
   without requiring team execution.
2. **Provide an evidence capsule, not a discovery request.** Pre-extract the
   smallest complete set of facts the task needs. List exact paths and say
   whether broader discovery is allowed. If a required fact is absent, the
   agent should record a deviation instead of silently searching unrelated
   material.
3. **Use a CLI tool allowlist for hard limits.** `entry.prompt` is guided
   policy. `pi --tools ...`, `--exclude-tools ...`, and an optional project
   guard extension are the enforcement layer for tools and paths.
4. **Review at the first useful checkpoint.** For a new artifact, read the
   declared inputs, write one draft, then review it. For an existing artifact,
   review the current file before editing it. Do not spend a full turn on
   speculative polishing before the reviewer identifies a real defect.
5. **Patch first.** Findings should include stable IDs and anchors. Fix local
   or section findings with a targeted edit, then re-review those finding IDs.
   Reserve full rewrites for an explicit global structural failure.
6. **Verify once, at completion.** Put deterministic checks in
   `blueprint.verification`. The completion evaluator runs them when completion
   is requested. Avoid running the same command before review and after every
   small edit unless the task genuinely needs an intermediate safety check.
7. **Record the final outcome once.** Batch one artifact evidence item across
   all criteria it proves. If evidence changes after a review was recorded,
   assurance becomes stale, so the reliable final order is:

   ```text
   final reviewer returns
     -> record_evidence
     -> record_review
     -> request_completion
   ```

8. **Bound both agent and reviewer loops.** Set a realistic token budget and
   `maxAutoTurns`; explicitly set reviewer `model`, `thinkingLevel`, and
   `maxTurns`, and require the parent to pass them in its `spawn_role` call. A
   focused re-review should receive only the original finding IDs, required
   fixes, and changed anchors.
9. **Stop after completion is requested.** Do not read the artifact, reviewer
   transcript, or goal state again unless completion returns a concrete
   blocking finding. The result file and JSONL log are the caller's audit
   channel.

#### Example: one reviewed Markdown artifact from bounded inputs

This generic example creates one section from two prepared inputs. The main
agent has no shell or discovery tools. A reviewer checks the artifact, the
final artifact is recorded once against all criteria, and a deterministic
command runs during completion evaluation.

This example assumes `pi-roles` is installed because a transcript-backed
independent review requires a real spawned reviewer session. If the task does
not require independent review, set `review.requirement` to `none` and omit the
reviewer and `record_review` steps.

````markdown
# Goal: Produce a reviewed operations section

## Original request

> Write one publishable Markdown section from the approved brief and evidence capsule.

## Objective

Create `outputs/operations.md` from the two declared inputs. The section must
be concise, traceable to the capsule, and ready for publication after an
independent review.

## Acceptance criteria

- [ ] `blocking` `outputs/operations.md` exists, starts with `## Operations`, and contains the required Summary, Actions, and Limitations blocks
- [ ] `blocking` Every factual statement is supported by `inputs/evidence-capsule.md`
- [ ] `blocking` No internal IDs, source paths, or drafting instructions appear in the output

## Constraints

- Read only `inputs/section-brief.md`, `inputs/evidence-capsule.md`, and an existing `outputs/operations.md`
- Create or edit only `outputs/operations.md`
- Do not list directories or search for additional sources; record a deviation if a blocking input is missing
- Use targeted edits for local findings; rewrite the whole artifact only for an explicit global structural finding

## Machine fields

```json
{
  "taskKind": "general",
  "blueprint": {
    "entry": {
      "prompt": "Use the bounded fast path. If outputs/operations.md exists, read the two exact inputs and the existing artifact, then immediately spawn an independent reviewer before editing. Otherwise read the two inputs, write one draft to the exact output path, and immediately spawn the reviewer. Pass model=provider/reviewer-model, thinkingLevel=high, maxTurns=12, and read-only tools explicitly to spawn_role. Fix only structured findings, re-review by finding ID, then call record_evidence, record_review, and request_completion in that order. Do not call get_goal or perform discovery."
    },
    "execution": {
      "topology": "direct"
    },
    "evidence": {
      "criteria": [
        {
          "id": "c1",
          "kinds": ["artifact"],
          "minCount": 1,
          "verification": "verified",
          "note": "Use one final artifact entry and attach it to c1, c2, and c3."
        },
        {
          "id": "c2",
          "kinds": ["artifact"],
          "minCount": 1,
          "verification": "verified"
        },
        {
          "id": "c3",
          "kinds": ["artifact"],
          "minCount": 1,
          "verification": "verified"
        }
      ]
    },
    "review": {
      "requirement": "required",
      "model": "provider/reviewer-model",
      "thinkingLevel": "high",
      "tools": ["read"],
      "checklist": [
        "Check all required blocks and factual support against the two declared inputs",
        "Report each blocking issue with a stable ID, target path, anchor, and required fix",
        "Mark local findings for targeted edits; require a rewrite only for a global structural defect"
      ],
      "maxTurns": 12
    },
    "verification": {
      "command": "test -s outputs/operations.md && grep -q '^## Operations' outputs/operations.md",
      "timeoutMs": 30000
    },
    "budget": {
      "tokens": 30000
    },
    "completion": {
      "policy": "v2",
      "maxAutoTurns": 16
    }
  }
}
```
````

Launch it with a narrow main-agent tool surface:

```bash
pi \
  --tools read,write,edit,spawn_role,update_goal \
  --exclude-tools list_roles,dag_execute,dag_resume \
  --approve \
  --goal-run spec.md \
  -p "Run the goal defined by --goal-run to completion."
```

After the final reviewer returns, the goal agent should use one artifact entry
for all three criteria, then record the real reviewer session, then request
completion:

```ts
update_goal({
  action: "record_evidence",
  evidence: {
    id: "final-operations-artifact",
    kind: "artifact",
    summary: "The reviewed operations section satisfies all three criteria.",
    locator: "outputs/operations.md",
    verification: "verified"
  },
  criterionIds: ["c1", "c2", "c3"]
})

update_goal({
  action: "record_review",
  review: {
    status: "passed",
    reason: "The independent reviewer found no open blocking issues.",
    evaluator: {
      kind: "reviewer",
      agentId: "<spawned-reviewer-agent-id>",
      sessionId: "<reviewer-session-id>"
    },
    sessionFile: "<archived-reviewer-session-file>",
    findings: [],
    advisories: []
  }
})

update_goal({
  action: "request_completion",
  summary: "The artifact is written, independently reviewed, and ready for deterministic verification."
})
```

The reviewer identity fields must come from the actual spawned reviewer
session. Do not invent them, use the parent agent ID as the reviewer session
ID, or replace the transcript-backed review with an observation.

#### Common sources of wasted work

| Anti-pattern | Better spec |
|---|---|
| "Inspect the repository and find the relevant files" when paths are already known | List the exact inputs and say what to do if one is incomplete |
| Give the agent a large raw corpus | Build a small, verified evidence capsule upstream |
| Use `team` for one sequential artifact | Use `direct`, with a separate reviewer only when assurance requires it |
| Run verification before review and after every edit | Configure one deterministic completion verification |
| Let a re-review repeat the full audit | Pass only open finding IDs, fixes, and changed anchors |
| Record one evidence item per criterion when one artifact proves all of them | Attach one stable evidence ID to multiple `criterionIds` |
| Record review before the final evidence mutation | Record final evidence first, then the transcript-backed review |
| Call `get_goal` after every step | Trust tool responses; use the JSONL log externally for monitoring |
| Treat an existing artifact as disposable | Review first, then patch only the located defects |
| Set very high turn limits "just in case" | Use measured limits and increase them only when logs show real work was cut off |

This pattern is intentionally narrow. Use a broader topology and discovery
tools when the task is genuinely exploratory, the relevant files are unknown,
or independent workstreams can run in parallel. A false fast path that omits
necessary evidence saves tokens by lowering quality, which is not an
optimization.

**Headless gotchas**

- A goal that would pause for user input (e.g., three identical completion rejections, budget exhaustion, rate limiting) **ends the run** in headless mode — the result file records the pause reason and the exit code is non-zero. The caller decides whether to retry with a different spec/budget.
- The agent cannot be trusted to report deviations it was not told about — the blueprint block in every continuation prompt enforces `record_deviation`; audit `deviations` in the result file before trusting a `complete`.
- `verification.command` runs arbitrary shell — only use it in trusted projects (`--approve`).

## Model Tools

`get_goal` accepts `mode: "compact" | "full" | "delta"`. The interactive
`/goal` commands and the `--goal-run` headless adapter use the same persisted
Goal Contract V3 state, event envelope, completion bundle, artifact digest,
and revision/run/attempt lineage. `draft`, `review`, `start`, `pause`, `resume`,
`edit`, `fork`, and `clear` are available from the interactive command; user
guidance is retained as a steering event.

V3 schemas are published under `schemas/`, including the event envelope and
runtime checkpoint. V2 snapshots and existing headless result/JSONL fields are
still decoded and emitted as compatibility projections.

The reusable P3 evaluation surface is exported from the extension package:
four neutral benchmark fixtures (`coding`, `research`, `document`, `business`),
deterministic checks, LLM-judge/pairwise/human-annotation contracts, historical
regression reports, OTel-compatible trace spans, runtime metrics, and fault
injection helpers. Interactive activity is written to `docs/goals/trace.jsonl`
without adding high-frequency tool events to the persisted Goal snapshot or
session branch; headless spans use `<headless-log>.trace.jsonl`. Spans expose
bounded attributes for tools, child agents, retries, approvals, checkpoints,
evaluations, usage, and cost while keeping prompt text, tool arguments,
artifact bodies, and checkpoint state out of trace attributes.

`npm run goal-quality -- --input <gate-input.json> --output <gate-result.json>`
turns a persisted Contract V3 result, event log, and trace into a stable offline
trajectory plus a no-average regression decision. The gate reports final
output, tool trajectory, artifact correctness, human intervention, recovery
correctness, cost, and latency separately; one required non-passing dimension
fails or blocks the fixture. Human acceptance remains `unverified` until a real
annotation is supplied and cannot be inferred from model or deterministic
scores. Published schemas include the trajectory sample and run-quality result.

The agent (and you, in tool-capable setups) manages the goal through three tools:

| Tool | Description |
|---|---|
| `get_goal` | Read the Goal V2 public view: status, criteria, evidence ledger, claims, deviations, execution route, assurance, completion audit, progress, usage. |
| `propose_goal_draft` | Propose an objective with one or more outcome criteria, task kind, route inputs, assurance inputs, and optional research claims. |
| `update_goal` | Apply exactly one action (see below). V1 flat arguments are accepted for one compatibility cycle, but must not be mixed with V2 actions. |

### External side effects

Trusted hosts may inject a `GoalSideEffectAdapterV3` when creating the
extension. The adapter owns the external system; the Goal runtime owns the
idempotency key, request digest, receipt and checkpoint. The adapter must
provide `execute({ entry, request })` and `reconcile({ entry })`, and should
use the journal entry's `idempotencyKey` when talking to the external system.

The live tools are deliberately separate:

| Tool | Description |
|---|---|
| `prepare_goal_side_effect` | Register a prepared operation. `execute` means the caller may execute it; `reconcile`, `replay`, and `conflict` are safety decisions. |
| `execute_goal_side_effect` | Execute through the injected trusted adapter after verifying the request digest and adapter identity. Concurrent calls for one entry are collapsed. |
| `reconcile_goal_side_effect` | Ask the adapter whether a prepared/failed operation committed, without blindly replaying it. |
| `settle_goal_side_effect` | Compatibility/manual receipt path for hosts that execute the operation outside the adapter. |

Without a trusted adapter, the execute/reconcile tools fail closed; the
runtime never invents a filesystem, network, or business-system adapter.

`update_goal` actions:

| Action | Purpose |
|---|---|
| `record_evidence` | Add a structured ledger entry and attach it to a criterion or claim. `artifact` entries are mechanically verified against the filesystem (Proof-or-Stop: claimed `verified` artifacts that do not exist become `rejected`). |
| `upsert_claim` | Add or update a research claim (materiality/risk) whose evidence references already exist in the ledger. |
| `request_completion` | Store a completion summary and request evaluation; does **not** mark the goal complete by itself. |
| `record_review` | Persist an independent review from a real spawned reviewer session (transcript-verified; findings must bind to criteria/evidence). |
| `change_execution` | Change or lock the execution preference, selected topology, and optional registered specialist role. |
| `record_deviation` | Record a blueprint deviation (subjectId/description/reason/impact) — required whenever the agent deviates from a declared blueprint in any entrypoint. |
| `submit_completion_bundle` | Atomically submit Contract V3 artifacts, evidence, deterministic checks, and an immutable typed reviewer result. Artifact bytes and cross-references are verified before any terminal state mutation. |
| `mark_unmet` | End the goal as unmet with a concrete blocker. |
| `pause` | Pause the goal and report why to the user. |

Example:

```ts
update_goal({
  action: "record_evidence",
  evidence: {
    id: "full-test-suite",
    kind: "command",
    summary: "The full test suite passed.",
    locator: "npm test",
    origin: "tool",
    verification: "verified"
  },
  criterionIds: ["criterion-1"]
})

update_goal({
  action: "request_completion",
  summary: "All blocking outcomes are implemented and verified."
})
```

## Evidence And Completion

All evidence lives in one goal-wide ledger. An entry has a stable ID, kind (`source`, `artifact`, `command`, `tool_result`, `observation`, `user_confirmation`, or migrated `legacy_text`), summary, origin, verification state, and optional locator, excerpt, source kind, and independence key. Criteria and claims refer to entries by ID, so the evaluator can validate every reference. `artifact` evidence with a local path is mechanically verified at write time (existence + SHA-256 for small files) — the agent cannot mark a nonexistent file `verified`.

Research claims record `materiality` (`material` or `supporting`), risk (`ordinary` or `high`), and their evidence references. A normal material claim can be supported by one authoritative primary source. High-risk, disputed, or conflicting claims require independent corroboration. Supporting gaps are advisory.

Only unsatisfied blocking outcomes, explicit user constraints, and unsupported material claims may block completion. Advisory criteria and advisories never reject completion. URL counts, citation ratios, source counts, model names, role counts, and wave counts are diagnostics, not universal completion gates.

Completion evaluation uses a bounded packet containing the objective, constraints, criteria, claims, canonical evidence, deterministic verification, the latest response, and prior rejection signatures. It persists an `accept`, `revise`, or `blocked` decision with per-criterion and per-claim coverage, structured blocking findings, advisories, evaluator identity, and a stable rejection fingerprint. A verdict that cites an unknown evidence ID is invalid.

Repeated identical blocking findings escalate instead of encouraging filler evidence: the first rejection reports the gap, the second requires a different verification strategy or replan, and the third pauses the goal for user input.

### Independent review

The default `risk_based` policy requires independent review for high-risk work, high-risk material claims, conflicting evidence, irreversible external actions, or an explicit user request. Medium-risk work and low-risk work without deterministic verification may receive advisory review. Ordinary non-coding work is not forced through a reviewer solely because of its task type.

A required review must come from a real spawned reviewer session. Its blocking findings must identify a criterion or claim and bind to evidence; the reviewer model name, thinking level, and number of URLs are not completion gates.

Contract V3 uses one `submit_completion_bundle` call after review. Every evidence entry is canonicalized with explicit `criterionIds` and `claimIds`; omitted input arrays normalize to empty arrays. `artifactId` canonically refers to `artifacts[].id`, while an exact, unambiguous artifact URI is accepted as an input alias and normalized to that ID. A tool result that returns a business-level rejection is recorded as an error span even when the host reports successful tool transport, so offline quality gates cannot mistake a rejected completion attempt for a clean trajectory.

Interactive and headless runs share a structured-reference preflight. Only IDs declared by the active Goal criteria may be used in `criterionId`, `criterionIds`, or reviewer `criterionCoverage`; `$constraint:n` belongs only to reviewer finding subjects, and deterministic check IDs are a separate namespace. Before `record_evidence`, reviewer handoff, and atomic completion, the prompt enumerates or derives the exact reference sets and requires the bundle graph to close over submitted objects. When a deterministic verifier is declared, the agent is instructed to inspect its script or documented requirements and compare the current artifact against required paths, literal markers, schema fields, and invariants before the first run.

Evidence ledger IDs are immutable. Reusing an existing ID is valid only when attaching the exact same ledger record to another criterion or claim. If artifact bytes, digest, summary, locator, excerpt, verification outcome, or provenance changes after a revision, the agent must create a new revision evidence ID and carry that ID through reviewer constraints and the completion bundle.

### Completion policy rollout

| `completionPolicy` | Behavior |
|---|---|
| `legacy` | Only the legacy completion path is authoritative. Use as a temporary rollback mode. |
| `shadow` | The legacy path remains authoritative while Goal V2 evaluation is recorded for comparison. Use this for a local canary or rollback. |
| `v2` | The evidence-aware Goal V2 evaluation is authoritative. This is the default after the compatibility suite passed. |

## State Machine

| Status | Meaning |
|---|---|
| `active` | The goal is running and may schedule another turn. |
| `paused` | Execution is halted until `/goal resume`, including a repeated-rejection or interruption pause. |
| `cancelled` | The user ended the run. It is terminal and remains inspectable until `/goal clear` or replacement. |
| `usage_limited` | The provider returned a rate limit or transient server failure. |
| `budget_limited` | The user-specified token budget was exhausted. |
| `blocked` | The goal was superseded or cannot currently proceed. |
| `complete` | The authoritative completion policy accepted all blocking outcomes. |
| `unmet` | The goal ended with an explicit blocker. |

User input cancels a pending automatic continuation so the user's message runs first, but it does not pause the goal. Use `/goal pause` for an explicit stop. An Esc abort pauses the goal.

## Goal Progress View

Every topology uses the same progress model. A direct goal reports main-session thinking and tools, a specialist goal reports `spawn_role` activity, and a team goal adds scheduler frontier details from `dag_execute` or `dag_resume`. DAG waves are not the top-level progress concept. Foreground specialists are tracked for their full tool lifetime; a background specialist can only be shown as dispatched because the current pi-roles completion notification is an unstructured parent steer.

The one-line footer is a low-noise summary and repaints every second:

```text
goal active | 1 blocking open | 12.4K tok | active 3m12s | wall 8m41s | DAG 2 running, 1 ready
```

`/goal status` expands the same structured snapshot into these dimensions:

| Dimension | Meaning |
|---|---|
| Outcomes | Blocking criteria, explicit constraints, and material claims are separated from advisory outcomes and shown as `pending`, `evidenced`, `verified`, or `blocked`. |
| Activity | Current thinking, direct tools, specialists, completion evaluation, or one or more DAG frontiers. |
| Evidence | Canonical ledger totals and verification state; source counts remain diagnostic. |
| Assurance | Risk-based review requirement, review state, evaluation freshness, blocking findings with subject IDs, and advisories. |
| Health | Pauses, runtime failures, stalled turns, repeated rejections, stale evaluation, and activity without outcome change. |
| Resources | Tokens, optional token budget, active execution time, and wall time. |

The route (`direct`, `specialist`, or `team`) is displayed as context, not as progress. DAG detail reports Running, Ready, Blocked, and Settled nodes plus failed/skipped/generated nodes and route decisions. Concurrent DAGs are tracked independently and summarized together.

There is deliberately no completion percentage. A tool call, elapsed minute, URL, specialist, or settled DAG node can represent very different amounts of useful work. Counts describe observed state; only verified blocking outcomes and the completion policy decide whether the goal is done. Advisory outcomes remain visible in the detailed view but are excluded from the compact completion summary.

Activity recency and outcome recency are tracked separately. Tool events can update `lastActivityAt` without pretending that the result advanced. Evidence, claims, assurance, and completion evaluation advance `lastOutcomeDeltaAt` and its durable revision. Runtime tool/frontier state stays in memory and never writes a snapshot on each repaint.

`active` is settled turn time plus the current turn delta. `wall` runs from goal creation until now and includes pauses and offline time. Terminal goals freeze both values, and historical goal event cards embed a frozen progress snapshot instead of drifting when a session is reloaded.

## Persistence

Goal state is stored in `pi-goal` session entries and survives compaction, `/reload`, and `/tree` switching. Goal V2 snapshots carry `schemaVersion: 2`, a monotonic `revision`, and `savedAt`; the state codec validates, deep-copies, and migrates them.

V1 snapshots are upgraded in memory and written as V2 only after the next real state change. Migrated string evidence receives stable `legacy:<criterionId>:<index>` IDs, and a completed V1 goal remains complete. Reconstruction reads only the latest snapshot; corrupt or future-version state fails closed instead of reviving an older active goal.

## Configuration

Project-local configuration is read from `.pi/goal.json` only in trusted projects. Recommended defaults:

```json
{
  "schemaVersion": 2,
  "superpowersIntegration": true,
  "reviewPolicy": "risk_based",
  "defaultExecution": "auto",
  "completionPolicy": "v2"
}
```

| Field | Values / behavior | Default |
|---|---|---|
| `schemaVersion` | Configuration schema. Future versions fall back to defaults with a warning. | `2` |
| `reviewPolicy` | `risk_based`, `always`, or `never`. | `risk_based` |
| `defaultExecution` | `auto`, `direct`, `specialist`, or `team` for new drafts. | `auto` |
| `completionPolicy` | `legacy`, `shadow`, or `v2`; see rollout behavior above. | `v2` |
| `evaluatorModel` | Optional `provider/model-id` for completion evaluation. The deprecated `judgeModel` alias remains accepted for one compatibility cycle. | Session model |
| `verifyCommand` | Optional deterministic verification command. Arbitrary shell execution means this is trusted-project-only. | Unset |
| `verifyTimeoutMs` | Positive timeout in milliseconds for `verifyCommand`. | `120000` when verification runs |
| `stuckEscalateModel` | Optional `provider/model-id` asked for a new strategy when progress stalls. | Unset |
| `forceTaskType` | Optional task-kind override: `general`, `coding`, `research`, `pm`, or `review`. | Automatic |
| `superpowersIntegration` | Inject compatible pi-superpowers workflow guidance. Disable for a standalone goal loop. | `true` |

Invalid enum values, empty model identifiers, non-positive timeouts, and unknown keys produce warnings and use a safe fallback. `evaluatorModel` takes precedence when both it and legacy `judgeModel` are present.

The environment variable `GOAL_MAX_AUTO_TURNS` overrides the per-resume-cycle automatic continuation cap (default `200`).

## Development

```sh
npm install   # dev deps (tsx, typescript)
npm test
npm run typecheck
```

## License

MIT
