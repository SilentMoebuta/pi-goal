import { matchesKey, SelectList, Text, type Component, type SelectItem } from "@earendil-works/pi-tui";
import type { GoalProposal } from "./draft-review-ui";

// ═══════════════════════════════════════════════════════════════════════
// Goal Draft Review 有界交互面板
//
// 背景：`showGoalReview` 原先把完整 proposal 放进无高度边界的普通
// `Container`。在 PI 的 regular custom 路径中该组件替换 editor 渲染，
// 宿主 `WorkingStatusIndicator` 每 80ms 触发一次 requestRender，而
// `TuiMainScreen` 在 `firstChanged < prevViewportTop` 时执行
// `fullRender(true)` 清屏并重放全部行——长 proposal 把 viewport 推到底部
// 后，spinner 每帧都位于 viewport 上方，于是形成无限整页滚屏。
//
// 本组件把“可滚动详情 + 固定操作区”组合在一个由 `tui.terminal.rows`
// 明确计算的高度预算内：render 输出行数只取决于终端高度与固定 chrome，
// 与 proposal 内容长度无关；标题、滚动位置、action 列表和按键提示始终
// 可见；`PageUp/PageDown`（以及 `Home/End`）滚动详情，`Up/Down` 只移动
// action 选择，`Enter` 返回所选 action，`Esc` 取消。
// ═══════════════════════════════════════════════════════════════════════

export interface GoalReviewTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface GoalReviewPanelOptions {
	proposal: GoalProposal;
	theme: GoalReviewTheme;
	items: SelectItem[];
	/** Live terminal row count（生产为 `tui.terminal.rows`，测试可注入固定值）。 */
	rows: () => number;
	/** 为宿主在面板之外占用的行数预留（status indicator + footer + 余量）。 */
	hostReserveRows?: number;
	/** 输入驱动的状态变化后请求宿主重绘。 */
	requestRender?: () => void;
}

/** 宿主 status/footer 行数预留：WorkingStatusIndicator 1 行 + footer 1 行 + 余量。 */
const DEFAULT_HOST_RESERVE_ROWS = 4;
/** 固定 chrome（不含 action 列表）：标题(1) + 位置行(1) + 按键提示(1) + 底边框(1)。 */
const FIXED_CHROME_ROWS = 4;

export class GoalReviewPanel implements Component {
	onSelect: ((item: SelectItem) => void) | undefined;
	onCancel: (() => void) | undefined;

	private readonly proposal: GoalProposal;
	private readonly theme: GoalReviewTheme;
	private readonly rows: () => number;
	private readonly hostReserveRows: number;
	private readonly requestRender: (() => void) | undefined;
	private readonly actionCount: number;

	private readonly detailsText: Text;
	private readonly selectList: SelectList;
	private detailOffset = 0;
	private totalDetailLines = 0;
	private lastWidth = 0;
	private disposed = false;

	constructor(options: GoalReviewPanelOptions) {
		this.proposal = options.proposal;
		this.theme = options.theme;
		this.rows = options.rows;
		this.hostReserveRows = options.hostReserveRows ?? DEFAULT_HOST_RESERVE_ROWS;
		this.requestRender = options.requestRender;
		this.actionCount = options.items.length;
		this.detailsText = new Text(buildDetailContent(options.proposal, options.theme), 0, 0);
		this.selectList = new SelectList(options.items, options.items.length, {
			selectedPrefix: (text) => options.theme.fg("accent", text),
			selectedText: (text) => options.theme.fg("accent", text),
			description: (text) => options.theme.fg("muted", text),
			scrollInfo: (text) => options.theme.fg("dim", text),
			noMatch: (text) => options.theme.fg("warning", text),
		});
		this.selectList.onSelect = (item) => this.onSelect?.(item);
		this.selectList.onCancel = () => this.onCancel?.();
	}

	// ── 测试可观察状态 ──────────────────────────────────────────────

	/** 详情窗口当前起始行（0 起）。 */
	get scrollOffset(): number { return this.detailOffset; }
	/** 详情内容总行数（最后一次 render 后有效）。 */
	get detailLineCount(): number { return this.totalDetailLines; }
	/** 组件总输出行数上限（= 高度预算）。 */
	get budgetRows(): number {
		return Math.max(this.rows() - this.hostReserveRows, this.chromeRows() + 1);
	}
	/** 详情窗口行数（随终端高度变化，至少 1 行）。 */
	get viewportRows(): number {
		return Math.max(1, this.budgetRows - this.chromeRows());
	}

	// ── Component 契约 ─────────────────────────────────────────────

	render(width: number): string[] {
		if (this.disposed) return [];
		const detailLines = this.detailsText.render(width);
		const listLines = this.selectList.render(width);
		this.lastWidth = width;
		this.totalDetailLines = detailLines.length;
		const viewport = this.viewportRows;
		const maxOffset = Math.max(0, this.totalDetailLines - viewport);
		if (this.detailOffset > maxOffset) this.detailOffset = maxOffset;
		if (this.detailOffset < 0) this.detailOffset = 0;

		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(" Goal Draft Review ")));
		const end = Math.min(this.detailOffset + viewport, this.totalDetailLines);
		for (let i = this.detailOffset; i < end; i++) lines.push(detailLines[i]);
		lines.push(this.positionLine(viewport, this.totalDetailLines));
		for (const line of listLines) lines.push(line);
		lines.push(this.theme.fg("dim", "  Enter: confirm · Esc: cancel · ↑↓ select action · PgUp/PgDn scroll details"));
		lines.push(this.theme.fg("accent", "─".repeat(Math.max(1, width))));
		return lines;
	}

	invalidate(): void {
		if (this.disposed) return;
		this.detailsText.invalidate();
		this.selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "pageUp")) {
			this.detailOffset = Math.max(0, this.detailOffset - this.viewportRows);
			this.invalidate();
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "home")) {
			this.detailOffset = 0;
			this.invalidate();
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollDown();
			this.invalidate();
			this.requestRender?.();
			return;
		}
		if (matchesKey(data, "end")) {
			this.detailOffset = Number.MAX_SAFE_INTEGER;
			this.clampOffset();
			this.invalidate();
			this.requestRender?.();
			return;
		}
		this.selectList.handleInput(data);
		this.requestRender?.();
	}

	dispose(): void {
		this.disposed = true;
	}

	// ── 内部 ───────────────────────────────────────────────────────

	private chromeRows(): number {
		// SelectList 以 maxVisible = items.length 构造且无过滤，行数恒等于
		// item 数（0 个 item 时显示一行 noMatch 提示）。
		return FIXED_CHROME_ROWS + (this.actionCount === 0 ? 1 : this.actionCount);
	}

	private clampOffset(): void {
		const maxOffset = Math.max(0, this.totalDetailLines - this.viewportRows);
		if (this.detailOffset > maxOffset) this.detailOffset = maxOffset;
		if (this.detailOffset < 0) this.detailOffset = 0;
	}

	private scrollDown(): void {
		this.detailOffset = Math.min(Number.MAX_SAFE_INTEGER, this.detailOffset + this.viewportRows);
		this.clampOffset();
	}

	private positionLine(viewport: number, total: number): string {
		if (total === 0) return this.theme.fg("dim", "  details: none");
		if (total <= viewport) return this.theme.fg("dim", "  details: all " + total + " lines");
		const from = this.detailOffset + 1;
		const to = Math.min(this.detailOffset + viewport, total);
		return this.theme.fg("dim", `  details ${from}-${to} of ${total} · PgUp/PgDn scroll`);
	}
}

/** 把 proposal 全部细节序列化为带样式的多行文本（由 Text 组件按宽度换行）。 */
function buildDetailContent(proposal: GoalProposal, theme: GoalReviewTheme): string {
	const parts: string[] = [];
	parts.push(theme.fg("accent", theme.bold("Objective:")));
	parts.push(theme.fg("text", "  " + proposal.objective));
	parts.push("");
	parts.push(theme.fg("accent", theme.bold("Route:")));
	parts.push(theme.fg("text", "  " + proposal.taskKind + " · " + proposal.execution.selected + (proposal.execution.role ? " · " + proposal.execution.role : "")));
	for (const reason of proposal.execution.reasons) parts.push(theme.fg("dim", "  " + reason));
	parts.push(theme.fg("accent", theme.bold("Assurance:")));
	parts.push(theme.fg("text", "  " + proposal.assurance.reviewRequirement + " · " + proposal.assurance.depth));
	for (const reason of proposal.assurance.reasons) parts.push(theme.fg("dim", "  " + reason));
	parts.push("");

	if (proposal.decisions && proposal.decisions.length > 0) {
		parts.push(theme.fg("accent", theme.bold("Clarifications:")));
		for (const decision of proposal.decisions) {
			parts.push(theme.fg("dim", "  Q: " + decision.question));
			parts.push(theme.fg("dim", "  A: " + decision.answer));
		}
		parts.push("");
	}
	if (proposal.criteria.length > 0) {
		parts.push(theme.fg("accent", theme.bold("Acceptance Criteria:")));
		for (const criterion of proposal.criteria) {
			parts.push(theme.fg("dim", "  \u2610 [" + criterion.level + "] " + criterion.description));
		}
		parts.push("");
	}
	if (proposal.constraints.length > 0) {
		parts.push(theme.fg("accent", theme.bold("Constraints:")));
		for (const constraint of proposal.constraints) {
			parts.push(theme.fg("dim", "  \u2022 " + constraint));
		}
		parts.push("");
	}
	if (proposal.claims.length > 0) {
		parts.push(theme.fg("accent", theme.bold("Research Claims:")));
		for (const claim of proposal.claims) {
			parts.push(theme.fg("dim", "  " + claim.id + " [" + claim.materiality + (claim.risk ? " · " + claim.risk : "") + "] " + claim.text));
		}
		parts.push("");
	}
	return parts.join("\n");
}
