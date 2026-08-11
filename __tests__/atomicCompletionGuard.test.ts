import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piGoalExtension from "../extensions/index";

// ═══════════════════════════════════════════════════════════════════════
// UX-P0-02：Contract V3 atomic completion 与 V2 request_completion 隔离。
//
// 需要独立 reviewer 的 V3 Goal 上调用 request_completion 必须 fail fast：
// 返回 atomic_completion_required + reviewer/bundle 下一动作，状态不变、
// 不写 pending。V2 与无需 reviewer 的 V3 保持原行为。
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
	registerCommand() {}
	registerMessageRenderer() {}
	getActiveTools() { return ["read", "spawn_role", "dag_execute"]; }
	setActiveTools() {}
	appendEntry(customType: string, data: unknown) {
		this.branch.push({ type: "custom", customType, data, timestamp: Date.now() });
	}
	sendMessage() {}
	sendUserMessage() {}
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function project(overrides: Record<string, unknown> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-atomic-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy: "v2",
		reviewPolicy: "risk_based",
		...overrides,
	}));
	return cwd;
}

function context(cwd: string, api: FakeExtensionAPI) {
	return {
		cwd,
		hasUI: false,
		model: { id: "atomic-guard" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
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
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
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

async function startGoal(api: FakeExtensionAPI, ctx: any, assurance: Record<string, unknown>) {
	await execute(api, "propose_goal_draft", {
		objective: "Atomic guard test goal", criteria: ["Outcome exists"], taskKind: "general",
		executionPreference: "direct", roleCatalogAvailable: false,
		assurance,
	}, ctx);
	const goal = await publicGoal(api, ctx);
	assert.equal(goal.runtime.contractVersion, 3);
	return goal;
}

describe("request_completion vs Contract V3 atomic completion (UX-P0-02)", () => {
	it("fails fast on a reviewer-required V3 goal without writing pending state", async () => {
		const cwd = project();
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const goal = await startGoal(api, ctx, { risk: "medium", userRequiresReviewer: true });
		assert.equal(goal.assurance.reviewRequirement, "required");

		const result = await execute(api, "update_goal", { action: "request_completion", summary: "Ready" }, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /atomic completion protocol/);
		assert.match(result.content[0].text, /submit_completion_bundle/);
		assert.match(result.content[0].text, /no pending completion was written/);
		assert.equal(result.details.code, "atomic_completion_required");
		assert.equal(result.details.recovery, "spawn_goal_reviewer_then_submit_completion_bundle");
		assert.equal(result.details.completionProtocol, "atomic-v3");
		assert.equal(result.details.statusUnchanged, true);

		const after = await publicGoal(api, ctx);
		assert.equal(after.status, "active", "status must be unchanged");
		assert.equal(after.completion.requestedAt, null, "request_completion must not write pending state");
		assert.equal(after.completion.lastEvaluation, null, "no evaluation may be created by the rejected request");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("keeps request_completion working on a V3 goal that does not require review", async () => {
		const cwd = project();
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const goal = await startGoal(api, ctx, { risk: "low" });
		assert.notEqual(goal.assurance.reviewRequirement, "required");

		const result = await execute(api, "update_goal", { action: "request_completion", summary: "Ready" }, ctx);
		assert.equal(result.isError, undefined, result.isError ? result.content[0].text : "");
		const after = await publicGoal(api, ctx);
		assert.ok(after.completion.requestedAt, "request_completion must write pending on non-atomic V3 goals");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("keeps V2 legacy completion behavior unchanged", async () => {
		const cwd = project({ completionPolicy: "legacy" });
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "V2 legacy goal", criteria: ["Outcome exists"], taskKind: "general",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		const goal = await publicGoal(api, ctx);
		const result = await execute(api, "update_goal", { action: "request_completion", summary: "Ready" }, ctx);
		assert.equal(result.isError, undefined, result.isError ? result.content[0].text : "");
		const after = await publicGoal(api, ctx);
		assert.ok(after.completion.requestedAt, "legacy policy must keep writing pending completion requests");
		assert.equal(after.id, goal.id);
		await api.emit("session_shutdown", {}, ctx);
	});
});
