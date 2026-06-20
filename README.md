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

### Environment variables

- `GOAL_MAX_AUTO_TURNS` — override the per-resume-cycle auto-continuation cap (default 200).

### Project-local config (`.pi/goal.json`)

pi-goal is designed to pair with [`pi-superpowers`](https://github.com/SilentMoebuta/pi-superpowers): by default, the goal continuation prompt and per-turn system prompt inject superpowers workflow discipline (skill mapping, HARD-GATE approval via reviewer subagent, TDD/verification-before-completion gates).

If you use pi-goal **without** pi-superpowers, or prefer a standalone goal loop without the superpowers workflow, opt out in `.pi/goal.json` (trusted projects only):

```json
{ "superpowersIntegration": false }
```

With `superpowersIntegration: false`, the goal loop only injects the goal body (objective, progress, criteria, completion audit, judge) — no `/skill:*` references, no HARD-GATE, no reviewer-subagent template. pi-goal then works standalone.

Default `true` keeps existing superpowers users' workflow unchanged.

#### SOTA-refresh opt-in fields (trusted projects only)

These fields are only honored when the project is trusted (pi's `isProjectTrusted`).
All default to unset = backward-compatible (no behavior change).

| Field | Description |
|---|---|
| `judgeModel` | `"provider/model-id"` for the per-turn judge LLM (GG-14). Uses a separate cheap/fast evaluator via `modelRegistry.find` instead of the session model; falls back to the session model if unresolvable. |
| `verifyCommand` | A shell command run as a **deterministic** verification gate before the LLM judge (GG-1), e.g. `"npm test"`. Non-zero exit short-circuits `done:false` with the truncated output fed back to the next continuation. **Security: arbitrary shell exec — trusted projects only.** |
| `verifyTimeoutMs` | Max ms the verify command may run before SIGKILL (default `120000`). |
| `stuckEscalateModel` | `"provider/model-id"` consulted when the goal stalls (GG-3). Asks the stronger model for ONE concrete next step, injected into the next continuation before pausing; falls back to pause on any failure. |

Example:
```json
{
  "judgeModel": "ksyun/glm-5.2",
  "verifyCommand": "npm test",
  "verifyTimeoutMs": 180000,
  "stuckEscalateModel": "anthropic/claude-sonnet-4"
}
```

### Constants

Constants in `extensions/index.ts`:
- `maxAutoTurns`: 200 (was 25; raised for large goals. Override via `GOAL_MAX_AUTO_TURNS` env.)
- `noProgressTokenThreshold`: 50
- `maxNoProgressTurns`: 2
- `minContinueIntervalMs`: 3000

## Development

```
npx tsx --test "__tests__/**/*.test.ts"   # 78 tests across 8 files
npx tsc --noEmit            # typecheck (install @earendil-works/pi-ai pi-coding-agent pi-tui typebox first)
```

## License

MIT
