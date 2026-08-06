Use the pi-goal-writer skill to draft and propose a formal goal for the following task.

Task: {{task}}

Expand this into a complete goal with:
1. A concise, concrete objective
2. One or more genuine outcome criteria, each independently verifiable
3. Any constraints or boundaries
4. A task kind and an adaptive execution recommendation

Call `list_roles` before drafting when that tool is available. Prefer `direct` for one clear
workstream, `specialist` for one dominant capability or uncertainty probe, and `team` only
for multiple independent workstreams or useful responsibility isolation. Risk affects
assurance, not topology.

If the task has genuine ambiguity that would change the draft, call `propose_goal_draft` with
`needsClarification: true` and the `openQuestions` that genuinely matter (no count limit,
ordered by importance) instead of guessing.

Clarify in a research-question loop: research first (web_search when external facts are
involved), summarize, then ask grounded questions; after each answer, research any new
factual questions it opens, then ask the next round. Repeat until the goal is converged:
- boundaries (in/out of scope) are settled
- every blocking criterion has a concrete verification method
- external facts are researched or listed as unverified assumptions
- unanswered items are explicit assumptions the user has seen
- high-risk decisions carry the user's explicit opinion
or until the user says to proceed. Then draft without the clarification flag.

Simple, well-scoped tasks must not ask — draft directly.

Call propose_goal_draft when ready. The user will review and choose Start, Edit, or Cancel.
Edit now edits the full spec document (markdown), not just the objective; after Start the
spec is written under docs/goals/ and can be refined later via /goal apply <path>.
