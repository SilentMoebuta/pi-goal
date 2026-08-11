import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piGoalExtension, { createPiGoalExtension } from "../extensions/index";

// ═══════════════════════════════════════════════════════════════════════
// TUI-P0-03：completed Goal 替换后的真实调用顺序。
//
// confirm(replace) -> 长 review 面板 -> cancel / start：
// - 未选择 Start 前旧 Goal 保持不变（confirm 本身不替换状态）；
// - cancel/interrupt 不创建新 Goal、不追加 snapshot；
// - Start 只执行一次替换。
// ═══════════════════════════════════════════════════════════════════════

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class FakeExtensionAPI {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly commands = new Map<string, any>();
	readonly sent: Array<{ message: any; options: any }> = [];
	readonly branch: any[] = [];

	on(name: string, handler: Handler) {
		const handlers = this.handlers.get(name) ?? [];
		handlers.push(handler);
		this.handlers.set(name, handlers);
	}

	async emit(name: string, event: any, ctx: any) {
		for (const handler of this.handlers.get(name) ?? []) await handler(event, ctx);
	}

	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	registerMessageRenderer() {}
	getActiveTools() { return ["read", "spawn_role", "dag_execute"]; }
	setActiveTools() {}
	appendEntry(customType: string, data: unknown) {
		this.branch.push({ type: "custom", customType, data, timestamp: Date.now() });
	}
	sendMessage(message: any, options: any) { this.sent.push({ message, options }); }
	sendUserMessage() {}
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function project(overrides: Record<string, unknown> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-review-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy: "legacy",
		reviewPolicy: "risk_based",
		...overrides,
	}));
	return cwd;
}

function context(cwd: string, api: FakeExtensionAPI, model?: any) {
	return {
		cwd,
		hasUI: false,
		model,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => model
				? ({ ok: true, apiKey: "test", headers: {} })
				: ({ ok: false, error: "no test model" }),
		},
		sessionManager: {
			getBranch: () => api.branch,
			getHeader: () => ({}),
			getSessionFile: () => path.join(cwd, "main.jsonl"),
		},
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: new AbortController().signal,
		ui: {
			notify: () => {},
			setStatus: () => {},
			confirm: async () => false,
			custom: <T>(_factory: unknown) => new Promise<T>(() => { /* resolved by the test driver */ }),
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		},
	};
}

async function execute(api: FakeExtensionAPI, name: string, params: unknown, ctx: any) {
	const tool = api.tools.get(name);
	assert.ok(tool, "tool registered: " + name);
	return tool.execute("call", params, undefined, undefined, ctx);
}

async function publicGoal(api: FakeExtensionAPI, ctx: any) {
	const result = await execute(api, "get_goal", {}, ctx);
	assert.equal(result.isError, undefined);
	return JSON.parse(result.content[0].text);
}

/** 长 proposal：与真实事故规模一致（8 criteria + 5 constraints）。 */
function replacementInput() {
	return {
		objective: "Replace the completed goal with a long-running cross-project upgrade that keeps interactive and headless entries on one shared runtime, evidence ledger and completion contract while staying injectable through profiles and skills. ".repeat(3),
		criteria: Array.from({ length: 8 }, (_v, i) => ({
			description: `Criterion ${i + 1}: the shared runtime must produce a deterministic, reviewable outcome for scenario ${i + 1} with a traceable evidence chain.`,
			level: i % 3 === 0 ? "blocking" : "advisory",
		})),
		constraints: Array.from({ length: 5 }, (_v, i) => `Constraint ${i + 1}: keep every change reviewable, idempotent and outside project-specific logic.`),
		taskKind: "research",
		executionPreference: "direct",
		roleCatalogAvailable: false,
		assurance: { risk: "low" },
	};
}

/** 模拟宿主 `ctx.ui.custom`：捕获 factory，测试自行驱动 render/input 后调 done。 */
class CustomUIMock {
	readonly factories: Array<(tui: any, theme: any, kb: any, done: (value: string | null) => void) => any> = [];
	private readonly resolvers: Array<(value: string | null) => void> = [];
	/** 返回一个 pending promise 给扩展；测试通过 resolve 结束 review。 */
	custom(factory: (tui: any, theme: any, kb: any, done: (value: string | null) => void) => any) {
		this.factories.push(factory);
		return new Promise<string | null>((resolve) => this.resolvers.push(resolve));
	}
	resolveLast(value: string | null) {
		const resolve = this.resolvers.shift();
		assert.ok(resolve, "expected a pending ui.custom call");
		resolve(value);
	}
	lastFactory() {
		assert.ok(this.factories.length > 0, "expected at least one ui.custom factory");
		return this.factories[this.factories.length - 1];
	}
}

function makeTui(rows: number) {
	return {
		terminal: { rows },
		requestRender: () => {},
	};
}

describe("Goal Draft Review replacement order (TUI-P0-03)", () => {
	it("cancel keeps the completed goal intact; start replaces it exactly once", async () => {
		const cwd = project();
		const api = new FakeExtensionAPI();
		createPiGoalExtension({
			complete: (async () => ({
				role: "assistant",
				content: [{ type: "text", text: '{"done":true,"reason":"legacy accepted"}' }],
				usage: { output: 1 },
			})) as any,
		})(api as any);
		const ctx = context(cwd, api, { id: "review-order-evaluator" });
		await api.emit("session_start", {}, ctx);

		// 1. 创建并完成一个旧 Goal（headless 路径：hasUI=false 直接创建）。
		await execute(api, "propose_goal_draft", {
			objective: "Old completed goal", criteria: ["Old outcome exists"], taskKind: "general",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		const oldGoal = await publicGoal(api, ctx);
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 5 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId: oldGoal.criteria[0].id,
			evidence: { id: "old-artifact", kind: "artifact", summary: "Old artifact exists", locator: "result" },
		}, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Ready." }], usage: { output: 10 } },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);
		const completedGoal = await publicGoal(api, ctx);
		assert.equal(completedGoal.status, "complete", "precondition: old goal is complete");
		const oldObjective = completedGoal.objective;
		const oldGoalId = completedGoal.id;
		const oldStatus = completedGoal.status;

		// 2. 交互式替换：hasUI=true，confirm 通过，长 review 面板挂起。
		ctx.hasUI = true;
		let confirmCalls = 0;
		ctx.ui.confirm = async () => { confirmCalls += 1; return true; };
		const uiMock = new CustomUIMock();
		(ctx.ui as any).custom = (factory: any) => uiMock.custom(factory);

		const snapshotsBefore = api.branch.length;
		const pending = execute(api, "propose_goal_draft", replacementInput(), ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(confirmCalls, 1, "replacing a goal must ask for confirmation once");

		// 3. 长 review 面板：有界渲染，action 区可见。
		const factory = uiMock.lastFactory();
		const component = factory(makeTui(24), ctx.ui.theme, undefined, (value: string | null) => uiMock.resolveLast(value));
		const lines = component.render(100);
		assert.ok(lines.length <= 24, "review panel must stay bounded while awaiting the user");
		assert.match(lines[0], /Goal Draft Review/);

		// 4. 取消：旧 Goal 保持原样，不产生新 snapshot。
		component.handleInput("\x1b"); // Esc -> cancel
		const cancelled = await pending;
		assert.equal(cancelled.isError, undefined);
		assert.match(cancelled.content[0].text, /Cancelled by user/);
		const afterCancel = await publicGoal(api, ctx);
		assert.equal(afterCancel.id, oldGoalId, "cancel must not replace the goal");
		assert.equal(afterCancel.objective, oldObjective);
		assert.equal(afterCancel.status, oldStatus);
		assert.equal(api.branch.length, snapshotsBefore, "cancel must not append a goal snapshot");

		// 5. 再次替换并选择 Start：旧 Goal 被替换且只替换一次。
		const pending2 = execute(api, "propose_goal_draft", replacementInput(), ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(confirmCalls, 2, "each replacement asks for confirmation");
		const factory2 = uiMock.lastFactory();
		const component2 = factory2(makeTui(24), ctx.ui.theme, undefined, (value: string | null) => uiMock.resolveLast(value));
		component2.handleInput("\r"); // Enter -> start
		const started = await pending2;
		assert.equal(started.isError, undefined);
		assert.match(started.content[0].text, /Goal started/);
		const afterStart = await publicGoal(api, ctx);
		assert.notEqual(afterStart.id, oldGoalId, "start must replace the old goal");
		assert.notEqual(afterStart.objective, oldObjective);
		assert.equal(afterStart.status, "active");

		await api.emit("session_shutdown", {}, ctx);
	});

	it("interrupting before Start keeps the old goal and the review surface stays bounded on repeated renders", async () => {
		const cwd = project();
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "First goal", criteria: ["First outcome"], taskKind: "general",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		const firstGoalId = (await publicGoal(api, ctx)).id;

		ctx.hasUI = true;
		ctx.ui.confirm = async () => true;
		const uiMock = new CustomUIMock();
		(ctx.ui as any).custom = (factory: any) => uiMock.custom(factory);

		const pending = execute(api, "propose_goal_draft", replacementInput(), ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const component = uiMock.lastFactory()(makeTui(24), ctx.ui.theme, undefined, (value: string | null) => uiMock.resolveLast(value));

		// 宿主 80ms status tick 等价物：反复 render 不改变行数、不整页重放。
		const baseline = component.render(100);
		for (let i = 0; i < 50; i++) {
			component.invalidate();
			const again = component.render(100);
			assert.equal(again.length, baseline.length, "render length must be stable across status ticks");
		}

		// 中断（Esc）后旧 Goal 未变。
		component.handleInput("\x1b");
		const interrupted = await pending;
		assert.match(interrupted.content[0].text, /Cancelled by user/);
		assert.equal((await publicGoal(api, ctx)).id, firstGoalId, "interrupt must keep the first goal");

		await api.emit("session_shutdown", {}, ctx);
	});
});
