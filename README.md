# pi-goal

Persistent, evidence-aware goals for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Goal V2 keeps the objective, execution route, evidence, assurance decision, completion audit, and live resource usage across turns and session reloads.

The completion policy, verification strategy, and execution topology are separate decisions. A goal uses the least expensive topology that is sufficient, asks for independent review according to risk, and completes from outcome evidence rather than fixed counts of criteria, URLs, roles, or workflow waves.

## Install

```sh
pi install git:github.com/SilentMoebuta/pi-goal
```

Adaptive `specialist` and `team` execution integrates with [`pi-roles`](https://github.com/SilentMoebuta/pi-roles). pi-goal remains usable without pi-roles; when the role catalog is unavailable, automatic routing falls back to `direct`.

## Commands

| Command | Description |
|---|---|
| `/goal <objective> [--tokens N]` | Draft a Goal V2 for review. `--tokens 50k` and `--tokens=1m` set an optional token budget. |
| `/goal` or `/goal status` | Show the unified Goal Progress view: route, outcomes, activity, evidence, assurance, health, and resources. |
| `/goal pause` | Pause the active goal. |
| `/goal resume` | Resume a paused or limited goal. |
| `/goal clear` | Remove the current goal. |
| `/goal help` | Show usage. |

## Goal Drafts And Routing

`propose_goal_draft` requires a concise objective and **at least one genuine outcome criterion**. Criteria can be `blocking` or `advisory`; do not add workflow steps, source counts, or filler criteria to meet a quota. Drafts can also declare explicit constraints, a task kind (`general`, `coding`, `research`, `pm`, or `review`), research claims, and an execution preference.

When pi-roles is available, the drafter should call its read-only `list_roles` tool before choosing a specialist. Automatic routing selects:

- `direct` for one clear workstream that the main session can complete.
- `specialist` for one dominant specialist capability or a low-confidence probe. The role must exist in the role catalog.
- `team` only for at least two genuinely independent workstreams or useful separation of duties.

Risk alone does not require a team. An automatic route may be reassessed when scope expands, a new workstream appears, evidence conflicts, or progress stalls. An explicit user preference is locked until the user changes it.

The draft review shows the task kind, selected topology and role, routing reasons, assurance decision, criteria, constraints, and initial claims. The user can change the execution preference before starting.

## Model Tools

| Tool | Description |
|---|---|
| `get_goal` | Read the Goal V2 public view, including its structured `progress` snapshot, route, claims, evidence ledger, and completion audit. |
| `propose_goal_draft` | Propose an objective with one or more outcome criteria, task kind, route inputs, assurance inputs, and optional research claims. |
| `update_goal` | Apply exactly one action. V1 flat arguments are accepted for one compatibility cycle, but must not be mixed with V2 actions. |

`update_goal` is an action-based interface:

| Action | Purpose |
|---|---|
| `record_evidence` | Add a structured ledger entry and attach its ID to one existing criterion or claim. |
| `upsert_claim` | Add or update a research claim whose evidence references already exist in the ledger. |
| `request_completion` | Store a completion summary and request evaluation; it does not mark the goal complete by itself. |
| `record_review` | Persist an independent review from a real spawned reviewer session, including structured findings and advisories. |
| `change_execution` | Change or lock the execution preference, selected topology, and optional registered specialist role. |
| `mark_unmet` | End the goal as unmet with a concrete blocker. |

Submit one action per call. For example:

```ts
update_goal({
  action: "record_evidence",
  criterionId: "criterion-1",
  evidence: {
    kind: "command",
    summary: "The full test suite passed.",
    locator: "npm test",
    origin: "tool",
    verification: "verified"
  }
})

update_goal({
  action: "request_completion",
  summary: "All blocking outcomes are implemented and verified."
})
```

## Evidence And Completion

All evidence lives in one goal-wide ledger. An entry has a stable ID, kind (`source`, `artifact`, `command`, `tool_result`, `observation`, `user_confirmation`, or migrated `legacy_text`), summary, origin, verification state, and optional locator, excerpt, source kind, and independence key. Criteria and claims refer to entries by ID, so the evaluator can validate every reference.

Research claims record `materiality` (`material` or `supporting`), risk (`ordinary` or `high`), and their evidence references. A normal material claim can be supported by one authoritative primary source. High-risk, disputed, or conflicting claims require independent corroboration. Supporting gaps are advisory.

Only unsatisfied blocking outcomes, explicit user constraints, and unsupported material claims may block completion. Advisory criteria and advisories never reject completion. URL counts, citation ratios, source counts, model names, role counts, and wave counts are diagnostics, not universal completion gates.

Completion evaluation uses a bounded packet containing the objective, constraints, criteria, claims, canonical evidence, deterministic verification, the latest response, and prior rejection signatures. It persists an `accept`, `revise`, or `blocked` decision with per-criterion and per-claim coverage, structured blocking findings, advisories, evaluator identity, and a stable rejection fingerprint. A verdict that cites an unknown evidence ID is invalid.

Repeated identical blocking findings escalate instead of encouraging filler evidence: the first rejection reports the gap, the second requires a different verification strategy or replan, and the third pauses the goal for user input.

### Independent review

The default `risk_based` policy requires independent review for high-risk work, high-risk material claims, conflicting evidence, irreversible external actions, or an explicit user request. Medium-risk work and low-risk work without deterministic verification may receive advisory review. Ordinary non-coding work is not forced through a reviewer solely because of its task type.

A required review must come from a real spawned reviewer session. Its blocking findings must identify a criterion or claim and bind to evidence; the reviewer model name, thinking level, and number of URLs are not completion gates.

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
| `usage_limited` | The provider returned a rate limit or transient server failure. |
| `budget_limited` | The user-specified token budget was exhausted. |
| `blocked` | The goal was superseded or cannot currently proceed. |
| `complete` | The authoritative completion policy accepted all blocking outcomes. |
| `unmet` | The goal ended with an explicit blocker. |

User input cancels a pending automatic continuation so the user's message runs first, but it does not pause the goal. Use `/goal pause` for an explicit stop. An Esc abort pauses the goal.

## Goal Progress

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
npm test
npm run typecheck
```

## License

MIT
