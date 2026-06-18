# pi-goal

Persistent autonomous goals for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Set an objective + acceptance criteria; an LLM judge evaluates completion each turn, the agent auto-continues until done, and per-criterion evidence is required before a goal can be marked complete.

Inspired by Claude Code `/goal` and Codex `/goal`, with stricter completion auditing (per-criterion evidence) and a richer state machine.

## Install

```
pi install git:github.com/SilentMoebuta/pi-goal
```

## Commands

| Command | Description |
|---|---|
| `/goal <objective> [--tokens N]` | Draft a goal (proposes objective + criteria for review). `--tokens 50k` / `--tokens=1m` sets a token budget. |
| `/goal` or `/goal status` | Show a persistent, collapsible goal card (ctrl+o to expand) with objective, criteria ✅/⏳, usage, and the last judge verdict. |
| `/goal pause` | Pause the active goal. |
| `/goal resume` | Resume a paused / usage-limited goal. |
| `/goal clear` | Remove the goal. |
| `/goal help` | Usage. |

## State Machine

| Status | Meaning | Trigger |
|---|---|---|
| `active` | Goal running; auto-continuation scheduled. | Goal started / resumed. |
| `paused` | Halted by user, session reload, no-progress, or interrupt. | `/goal pause`, session reload, no-progress (2 turns), Esc-abort, judge parse failures (3×). |
| `usage_limited` | Provider rate-limit / 5xx. Distinct from a user token budget. | `after_provider_response` status 429 or ≥500. |
| `budget_limited` | User-set token budget exhausted. | `tokensUsed >= tokenBudget`. |
| `blocked` | External blocker (e.g. superseded by a new goal). | Replaced by `/goal <new>`. |
| `complete` | All criteria have evidence + judge confirms. | Judge `done: true` with all criteria covered. |
| `unmet` | Judge-failed / explicitly unsatisfiable. | `update_goal({status:"unmet", blocker})`. |

Pause/resume is **system-controlled** (not exposed to model tools) — a stuck agent cannot self-loop past a pause.

## Model Tools

| Tool | Description |
|---|---|
| `get_goal` | Read objective, status, criteria, token usage, budget. |
| `update_goal` | Submit per-criterion evidence, or mark complete/unmet. Complete requires all criteria to have evidence. |
| `propose_goal_draft` | Propose objective + 3-7 criteria for Start/Edit/Cancel review. |

## Completion Model

1. Each goal-driven turn ends → `runJudge` (separate `ctx.model` call, temp 0, 256 tokens) returns `{done, reason}`.
2. `done: true` only completes if **every** criterion has evidence (judge alone is insufficient — per-criterion evidence is mandatory).
3. Judge verdict is stored (`lastJudgeVerdict`) and surfaced in the goal card + `/goal status` so the user can see why the goal is still running.

## Interruption Handling

- **User input**: cancels the pending auto-continuation but does **not** pause the goal. An interrupt injects guidance; the goal resumes after the user-driven turn. Use `/goal pause` for an explicit stop.
- **Esc abort**: pauses the goal (`interrupted`).
- **No-progress** (2 consecutive goal-driven turns < 50 output tokens): auto-pauses.

## Persistence

Goal state is stored as session entries (`pi-goal` customType) — survives compaction, `/reload`, and `/tree` switching. On session reload, an active goal is auto-paused with a notify (prevents a silent runaway).

## Configuration

Constants in `extensions/index.ts`:
- `maxAutoTurns`: 25
- `noProgressTokenThreshold`: 50
- `maxNoProgressTurns`: 2
- `minContinueIntervalMs`: 3000

## Development

```
npx tsx --test __tests__/   # format + parseTokenBudget tests (17 cases)
npx tsc --noEmit            # typecheck (install @earendil-works/pi-ai pi-coding-agent pi-tui typebox first)
```

## License

MIT
