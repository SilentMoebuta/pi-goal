import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoalReviewPanel, type GoalReviewTheme } from "../extensions/draft-review-panel";
import type { GoalProposal } from "../extensions/draft-review-ui";

// ═══════════════════════════════════════════════════════════════════════
// TUI-P0-01/02 + TUI-P1-01：Goal Draft Review 有界交互面板静态回归。
//
// 覆盖：高度预算与内容长度无关；标题/位置/action 区始终可见；详情全部
// 可达；PageUp/PageDown/Home/End 滚动且不改变 action 选择；Up/Down/Enter/
// Esc 选择语义；resize 与重复 render 不重新输出整页。
// ═══════════════════════════════════════════════════════════════════════

const identityTheme: GoalReviewTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const ACTIONS = [
	{ value: "start", label: "Start — begin working toward this goal" },
	{ value: "edit", label: "Edit — modify the objective or criteria" },
	{ value: "execution", label: "Execution — change auto/direct/specialist/team" },
	{ value: "cancel", label: "Cancel — discard this draft" },
];

/** 长 fixture：长 objective + 8 criteria + 5 constraints（复现真实事故规模）。 */
function longProposal(): GoalProposal {
	return {
		objective: "Upgrade the shared goal runtime so that interactive and headless entries share state, events, evidence, evaluation, permissions and recovery semantics, while keeping project-specific rules injectable through profiles, skills, MCP, hooks or project policy. ".repeat(4),
		criteria: Array.from({ length: 8 }, (_v, i) => ({
			description: `Acceptance criterion ${i + 1}: verify that the system produces a deterministic, reviewable outcome for scenario ${i + 1}, including a traceable evidence chain and an independently verifiable artifact digest without regressing prior fixtures.`,
			level: i % 3 === 0 ? ("blocking" as const) : ("advisory" as const),
		})),
		constraints: Array.from({ length: 5 }, (_v, i) =>
			`Constraint ${i + 1}: do not modify anything outside the dedicated worktree; keep all changes reviewable, idempotent and traceable through the shared event envelope.`,
		),
		taskKind: "research",
		executionPreference: "auto",
		execution: {
			preference: "auto", selected: "direct", source: "auto", confidence: 0.75,
			reasons: ["low uncertainty", "single workstream", "small effort"],
			reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
		},
		assurance: {
			reviewRequirement: "required", reviewStatus: "pending", independent: true,
			depth: "deep", source: "auto",
			reasons: ["high-stakes output", "independent review required"],
			decidedAt: 0,
		},
		claims: [
			{ id: "claim-1", text: "The outcome is reproducible across providers with identical inputs.", materiality: "material", risk: "high", evidenceRefs: [] },
			{ id: "claim-2", text: "The evidence ledger remains append-only and digest-verified.", materiality: "supporting", evidenceRefs: [] },
			{ id: "claim-last", text: "FINAL-CONTENT-LINE the last claim is the final detail line of the panel.", materiality: "supporting", evidenceRefs: [] },
		],
		decisions: [
			{ question: "Scope boundary?", answer: "Only the shared runtime, no project-specific rules." },
			{ question: "Host baseline?", answer: "Latest locally installed PI only." },
		],
	};
}

function makePanel(rows: () => number, proposal: GoalProposal = longProposal()) {
	const renderRequests: number[] = [];
	const panel = new GoalReviewPanel({
		proposal,
		theme: identityTheme,
		items: ACTIONS,
		rows,
		requestRender: () => renderRequests.push(1),
	});
	return { panel, renderRequests };
}

describe("GoalReviewPanel bounded rendering (TUI-P0-01)", () => {
	for (const columns of [80, 100, 120]) {
		for (const terminalRows of [24, 40]) {
			it(`output is bounded at ${columns} cols x ${terminalRows} rows for a 70+ line proposal`, () => {
				const { panel } = makePanel(() => terminalRows);
				const lines = panel.render(columns);
				assert.ok(lines.length <= terminalRows, `render returned ${lines.length} lines for ${terminalRows}-row terminal`);
				assert.equal(lines.length, panel.budgetRows, "render length must equal the height budget");
			});
		}
	}

	it("render length is independent of proposal length (bounded, not clipped content)", () => {
		const tiny = makePanel(() => 24, {
			...longProposal(),
			objective: "Short objective",
			criteria: [{ description: "One criterion", level: "blocking" }],
			constraints: [],
			claims: [],
			decisions: [],
		});
		const big = makePanel(() => 24);
		assert.equal(tiny.panel.render(100).length, big.panel.render(100).length, "line count must not grow with content length");
	});

	it("title, scroll position, actions and hints are always visible", () => {
		const { panel } = makePanel(() => 24);
		const lines = panel.render(80);
		assert.match(lines[0], /Goal Draft Review/);
		const position = lines.find((line) => /details /.test(line));
		assert.ok(position, "scroll position line must be present");
		assert.ok(position!.includes("PgUp/PgDn"), "scroll hint must be discoverable");
		const tail = lines.slice(-6).join("\n");
		for (const action of ACTIONS) {
			assert.ok(tail.includes(action.label.split(" — ")[0]), "action must stay visible: " + action.value);
		}
		assert.match(lines[lines.length - 2], /Enter: confirm/);
		assert.match(lines[lines.length - 2], /Esc: cancel/);
	});
});

describe("GoalReviewPanel detail scrolling (TUI-P0-02)", () => {
	it("PageDown walks to the final line and PageUp back to the first, clamping at the edges", () => {
		const { panel } = makePanel(() => 24);
		const width = 100;
		panel.render(width);
		const total = panel.detailLineCount;
		const viewport = panel.viewportRows;
		assert.ok(total > viewport * 2, "fixture must actually overflow the window");

		// Scroll down until clamped at the bottom.
		let guard = 0;
		while (panel.scrollOffset < panel.detailLineCount - viewport && guard++ < 100) {
			panel.handleInput("\x1b[6~"); // PageDown
		}
		assert.equal(panel.scrollOffset, Math.max(0, total - viewport), "PageDown must clamp at the last window");
		const bottom = panel.render(width);
		const bottomText = bottom.join("\n");
		assert.ok(bottomText.includes("FINAL-CONTENT-LINE"), "last detail line must be reachable at the bottom");
		const position = bottom.find((line) => /of \d+ · PgUp\/PgDn/.test(line));
		assert.ok(position, "position line reports the window while scrolled");

		// Scroll up until clamped at the top.
		guard = 0;
		while (panel.scrollOffset > 0 && guard++ < 100) {
			panel.handleInput("\x1b[5~"); // PageUp
		}
		assert.equal(panel.scrollOffset, 0, "PageUp must clamp at the first window");
		const top = panel.render(width);
		assert.ok(top.slice(1).join("\n").includes("Objective:"), "first detail line must be reachable at the top");
	});

	it("Home and End jump to the first and last window", () => {
		const { panel } = makePanel(() => 24);
		panel.render(100);
		panel.handleInput("\x1b[F"); // End
		assert.equal(panel.scrollOffset, Math.max(0, panel.detailLineCount - panel.viewportRows));
		panel.handleInput("\x1b[H"); // Home
		assert.equal(panel.scrollOffset, 0);
	});

	it("scrolling never changes the selected action", () => {
		const { panel } = makePanel(() => 24);
		panel.render(100);
		// Move selection to "execution" (index 2) with Down.
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		let selected: string | undefined;
		panel.onSelect = (item) => { selected = item.value; };
		// Scroll down and back up.
		for (let i = 0; i < 5; i++) panel.handleInput("\x1b[6~");
		for (let i = 0; i < 5; i++) panel.handleInput("\x1b[5~");
		panel.handleInput("\r"); // Enter confirms the *unchanged* selection
		assert.equal(selected, "execution", "scrolling must not move the action selection");
	});

	it("Up/Down cycle actions, Enter confirms, Esc cancels", () => {
		const { panel } = makePanel(() => 24);
		panel.render(100);
		const selected: string[] = [];
		let cancelled = 0;
		panel.onSelect = (item) => { selected.push(item.value); };
		panel.onCancel = () => { cancelled += 1; };

		// Default selection is the first item (start).
		panel.handleInput("\r");
		assert.deepEqual(selected, ["start"]);
		// Down moves to edit.
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		assert.deepEqual(selected, ["start", "edit"]);
		// Up from edit wraps around to the last item (cancel).
		panel.handleInput("\x1b[A");
		panel.handleInput("\x1b[A");
		panel.handleInput("\r");
		assert.deepEqual(selected, ["start", "edit", "cancel"]);
		// Esc cancels without selecting.
		panel.handleInput("\x1b");
		assert.equal(cancelled, 1);
		assert.deepEqual(selected, ["start", "edit", "cancel"], "Esc must not emit onSelect");
	});
});

describe("GoalReviewPanel resize and redraw stability (TUI-P1-01)", () => {
	it("growing the terminal re-clamps the offset; shrinking preserves it; output stays bounded", () => {
		const rows = { value: 24 };
		const { panel } = makePanel(() => rows.value);
		panel.render(100);
		const total = panel.detailLineCount;
		const viewport24 = panel.viewportRows;
		assert.ok(total > viewport24 * 2, "fixture overflows the 24-row window");

		// Scroll to the bottom at 24 rows.
		for (let i = 0; i < 30; i++) panel.handleInput("\x1b[6~");
		assert.equal(panel.scrollOffset, Math.max(0, total - viewport24));

		// Grow to 40 rows: viewport grows, maxOffset shrinks, offset re-clamps.
		rows.value = 40;
		const grown = panel.render(100);
		assert.ok(grown.length <= 40, "output must stay within the new terminal height");
		assert.equal(panel.scrollOffset, Math.max(0, total - panel.viewportRows), "offset must re-clamp when the window grows");
		const grownOffset = panel.scrollOffset;

		// Shrink back to 24 rows: viewport shrinks, maxOffset grows, the offset
		// stays where it was (still valid) and the output stays bounded.
		rows.value = 24;
		const shrunk = panel.render(100);
		assert.ok(shrunk.length <= 24, "output must stay within the shrunk terminal height");
		assert.equal(panel.scrollOffset, grownOffset, "offset must be preserved when the window shrinks");
		assert.ok(panel.scrollOffset <= Math.max(0, total - panel.viewportRows), "preserved offset must remain valid");
	});

	it("narrower width re-wraps details and re-clamps without exceeding the height", () => {
		const { panel } = makePanel(() => 24);
		panel.render(120);
		const totalWide = panel.detailLineCount;
		for (let i = 0; i < 30; i++) panel.handleInput("\x1b[6~");
		const narrow = panel.render(80);
		assert.ok(narrow.length <= 24, "narrow width must stay bounded");
		assert.ok(panel.detailLineCount > totalWide, "narrow width wraps into more detail lines");
		assert.ok(panel.scrollOffset <= Math.max(0, panel.detailLineCount - panel.viewportRows), "offset must re-clamp after re-wrap");
	});

	it("repeated renders and invalidate() are byte-stable: no full-page replay from background status ticks", () => {
		const { panel } = makePanel(() => 24);
		const first = panel.render(100);
		const second = panel.render(100);
		assert.deepEqual(second, first, "idle re-render must not change any line");
		panel.invalidate();
		const third = panel.render(100);
		assert.deepEqual(third, first, "invalidate() without state change must not change any line");

		// Scrolling changes only the detail window + position line; the title,
		// action list and hints must stay byte-identical.
		panel.handleInput("\x1b[6~");
		const scrolled = panel.render(100);
		assert.notEqual(scrolled.length, 0);
		assert.equal(scrolled[0], first[0], "title must not change when scrolling");
		assert.deepEqual(scrolled.slice(-6), first.slice(-6), "actions + hints must not change when scrolling");
		const changed = scrolled.filter((line, i) => line !== first[i]);
		assert.ok(changed.length <= panel.viewportRows + 1, "only the detail window and position line may change");
	});

	it("requestRender is invoked for input-driven changes and ignored for pure re-renders", () => {
		const { panel, renderRequests } = makePanel(() => 24);
		panel.render(100);
		panel.render(100);
		assert.equal(renderRequests.length, 0, "render alone must not request a redraw");
		panel.handleInput("\x1b[6~");
		assert.equal(renderRequests.length, 1, "PageDown must request a redraw");
		panel.handleInput("\x1b[B");
		assert.equal(renderRequests.length, 2, "action movement must request a redraw");
	});

	it("dispose stops further rendering and input handling", () => {
		const { panel } = makePanel(() => 24);
		panel.render(100);
		panel.dispose();
		assert.deepEqual(panel.render(100), [], "disposed panel must render nothing");
		panel.handleInput("\x1b[6~");
		assert.equal(panel.scrollOffset, 0, "disposed panel must not process input");
	});
});
