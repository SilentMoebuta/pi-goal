import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createPiGoalExtension } from "../extensions/index";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class FakeExtensionAPI {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly commands = new Map<string, any>();
	readonly branch: any[] = [];
	readonly statuses: Array<string | undefined> = [];
	private activeTools = ["read", "update_goal"];

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
	getActiveTools() { return [...this.activeTools]; }
	setActiveTools(tools: string[]) { this.activeTools = [...tools]; }
	appendEntry(customType: string, data: unknown) {
		this.branch.push({ type: "custom", customType, data, timestamp: Date.now() });
	}
	sendMessage() {}
	sendUserMessage() {}
}

const temporaryPaths: string[] = [];
afterEach(() => {
	for (const target of temporaryPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function makeProject(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-progress-"));
	temporaryPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy: "v2",
		defaultExecution: "direct",
	}));
	return cwd;
}

function context(cwd: string, api: FakeExtensionAPI) {
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		model: undefined,
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "none" }) },
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
			setStatus: (_key: string, value: string | undefined) => api.statuses.push(value),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
}

async function execute(api: FakeExtensionAPI, name: string, params: unknown, ctx: any) {
	const tool = api.tools.get(name);
	assert.ok(tool, "tool registered: " + name);
	return tool.execute("call-" + name, params, undefined, undefined, ctx);
}

async function publicGoal(api: FakeExtensionAPI, ctx: any) {
	const result = await execute(api, "get_goal", {}, ctx);
	assert.equal(result.isError, undefined);
	return JSON.parse(result.content[0].text);
}

describe("Goal progress ExtensionAPI lifecycle", () => {
	it("projects runtime events without persisting them and advances outcome revision only for semantic updates", async () => {
		const cwd = makeProject();
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ minContinueIntervalMs: 60_000 })(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const created = await execute(api, "propose_goal_draft", {
			objective: "Produce a verified result",
			criteria: ["The result is supported"],
			taskKind: "research",
			executionPreference: "direct",
			routing: {
				uncertainty: "low", coupling: "high", risk: "low", specialistNeed: "none",
				independentWorkstreams: 1, heterogeneousSkills: false, effort: "small",
			},
			assurance: { risk: "low" },
		}, ctx);
		assert.equal(created.isError, undefined);

		const baseline = await publicGoal(api, ctx);
		assert.equal(baseline.progress.outcomes.revision, 0);
		const baselineOutcomeAt = baseline.progress.timestamps.lastOutcomeDeltaAt;
		const snapshotsAfterCreate = api.branch.length;

		ctx.hasUI = true;
		await api.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 100 }, ctx);
		await api.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/main.ts" },
		}, ctx);
		let view = await publicGoal(api, ctx);
		assert.equal(view.progress.activity.phase, "tool");
		assert.match(view.progress.activity.label, /read src\/main\.ts/);
		assert.equal(view.progress.timestamps.lastOutcomeDeltaAt, baselineOutcomeAt);
		assert.equal(view.progress.outcomes.revision, 0);

		const childCtx = {
			...ctx,
			sessionManager: { ...ctx.sessionManager, getHeader: () => ({ parentSession: "main.jsonl" }) },
		};
		await api.emit("tool_execution_start", {
			type: "tool_execution_start", toolCallId: "child-tool", toolName: "bash", args: {},
		}, childCtx);
		view = await publicGoal(api, ctx);
		assert.equal(view.progress.activity.tools.length, 1, "subagent tools cannot pollute parent progress");

		await api.emit("tool_execution_end", {
			type: "tool_execution_end", toolCallId: "read-1", toolName: "read",
			result: { details: { status: "completed" } }, isError: false,
		}, ctx);
		view = await publicGoal(api, ctx);
		assert.equal(view.progress.activity.phase, "thinking");
		assert.equal(api.branch.length, snapshotsAfterCreate, "turn/tool activity must remain in memory only");

		const criterionId = view.criteria[0].id;
		const evidence = await execute(api, "update_goal", {
			action: "record_evidence",
			criterionId,
			evidence: {
				id: "ev-progress",
				kind: "observation",
				summary: "The output was inspected.",
				origin: "agent",
				verification: "verified",
			},
		}, ctx);
		assert.equal(evidence.isError, undefined);
		view = await publicGoal(api, ctx);
		assert.equal(view.progress.outcomes.revision, 1);
		assert.ok(view.progress.timestamps.lastOutcomeDeltaAt >= baselineOutcomeAt);
		assert.equal(view.progress.outcomes.counts.evidenced, 1, "verified evidence is not itself a verified outcome");
		assert.ok(api.statuses.some((status) => status?.includes("active")), "footer receives the unified compact projection");

		await api.emit("session_shutdown", {}, ctx);
	});
});
