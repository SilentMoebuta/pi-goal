import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import piGoalExtension, { createPiGoalExtension } from "../extensions/index";
import { createGoalRuntimeCheckpointV3, GoalRuntimeHooksV3, type GoalSideEffectAdapterV3 } from "../extensions/runtime-v3";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class HeadlessFakeAPI {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly commands = new Map<string, any>();
	readonly sent: Array<{ message: any; options: any }> = [];
	readonly branch: any[];
	private flags = new Map<string, unknown>();
	private flagDefs = new Map<string, unknown>();
	private activeTools = ["read", "spawn_role", "dag_execute"];

	constructor(branch: any[] = []) { this.branch = branch; }

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
	registerFlag(name: string, options: unknown) { this.flagDefs.set(name, options); }
	getFlag(name: string) { return this.flags.get(name); }
	setFlag(name: string, value: unknown) { this.flags.set(name, value); }
	getActiveTools() { return [...this.activeTools]; }
	setActiveTools(tools: string[]) { this.activeTools = [...tools]; }
	appendEntry(customType: string, data: unknown) {
		this.branch.push({ type: "custom", customType, data, timestamp: Date.now() });
	}
	sendMessage(message: any, options: any) { this.sent.push({ message, options }); }
	sendUserMessage(message: string) { this.sent.push({ message: { role: "user", content: message }, options: {} }); }
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
	process.exitCode = 0;
});

function project(configOverride: Record<string, unknown> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-headless-lifecycle-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy: "v2",
		reviewPolicy: "risk_based",
		...configOverride,
	}));
	return cwd;
}

function context(cwd: string, api: HeadlessFakeAPI, trusted = true) {
	const shutdownState = { calls: 0 };
	return {
		cwd,
		hasUI: false,
		shutdownState,
		shutdown: () => { shutdownState.calls += 1; },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no test model" }),
		},
		sessionManager: {
			getBranch: () => api.branch,
			getHeader: () => ({}),
			getSessionFile: () => path.join(cwd, "main.jsonl"),
		},
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: new AbortController().signal,
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
	};
}

function specMarkdown(extraMachine: Record<string, unknown> = {}): string {
	return `# Goal: 测试迁移

## 原始描述

> headless 测试

## 目标

完成 JWT 迁移

## 验收标准

- [ ] \`blocking\` 测试套件通过
- [ ] \`advisory\` README 更新

## 约束

- 不新增依赖

## 研究声明

_无_

## 机器字段

\`\`\`json
${JSON.stringify({
	taskKind: "coding",
	blueprint: {
		execution: {
			topology: "direct",
			roleDefs: [{ name: "migrator", description: "迁移专家", prompt: "负责迁移" }],
		},
		evidence: { criteria: [{ id: "c1", kinds: ["command"], minCount: 1, verification: "verified" }] },
		review: { requirement: "advisory", checklist: ["运行测试"] },
		budget: { tokens: 200000 },
		...extraMachine,
	},
}, null, 2)}
\`\`\`
`;
}

async function execute(api: HeadlessFakeAPI, name: string, params: unknown, ctx: any) {
	const tool = api.tools.get(name);
	assert.ok(tool, "tool registered: " + name);
	return tool.execute("call", params, undefined, undefined, ctx);
}

describe("headless goal lifecycle", () => {
	it("does not pause the goal for an intermediate provider failure that the host recovers", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setTimeout: ((callback: () => void, delayMs: number) => {
				retryTimers.push({ callback, delayMs });
				return retryTimers.length;
			}) as never,
			clearTimeout: (() => {}) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("after_provider_response", { status: 429, headers: { "retry-after": "1" } }, ctx);
		await api.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { output: 1 } } }, ctx);
		await api.emit("agent_settled", {}, ctx);

		const view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.status, "active");
		assert.equal(view.runtime.attemptNumber, 1);
		assert.equal(retryTimers.length, 0, "the host's successful retry must clear the candidate failure");
	});

	it("starts a fresh Goal attempt only after the host settles with a provider failure", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
		const cleared: unknown[] = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setTimeout: ((callback: () => void, delayMs: number) => {
				retryTimers.push({ callback, delayMs });
				return retryTimers.length;
			}) as never,
			clearTimeout: ((timer: unknown) => { cleared.push(timer); }) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("after_provider_response", { status: 503, headers: {} }, ctx);
		await api.emit("agent_end", { messages: [] }, ctx);
		assert.equal(retryTimers.length, 0, "agent_end must not race the host retry lifecycle");
		await api.emit("agent_settled", {}, ctx);
		assert.equal(retryTimers.length, 1);
		assert.equal(retryTimers[0].delayMs, 10_000);

		let view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.status, "active");
		assert.equal(view.runtime.attemptNumber, 1);
		assert.match(view.pausedReason, /retrying attempt 2/);

		retryTimers[0].callback();
		await Promise.resolve();
		view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.status, "active");
		assert.equal(view.runtime.attemptNumber, 2);
		assert.equal(view.runtime.previousAttemptId.endsWith(":attempt:1"), true);
		assert.equal(view.runtime.attemptId.endsWith(":attempt:2"), true);
		assert.equal(view.pausedReason, null);
		assert.ok(api.sent.some((entry) => entry.options?.deliverAs === "followUp" && entry.options?.triggerTurn === true));

		const events = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(events.some((entry) => entry.type === "retry_scheduled" && entry.nextAttemptNumber === 2));
		assert.ok(events.some((entry) => entry.type === "retry_attempt_started" && entry.attemptNumber === 2));
		assert.deepEqual(cleared, []);
	});

	it("ends headless recovery only after the typed infrastructure-attempt limit", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setTimeout: ((callback: () => void, delayMs: number) => {
				retryTimers.push({ callback, delayMs });
				return retryTimers.length;
			}) as never,
			clearTimeout: (() => {}) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		for (let nextAttempt = 2; nextAttempt <= 5; nextAttempt++) {
			await api.emit("after_provider_response", { status: 503, headers: {} }, ctx);
			await api.emit("agent_settled", {}, ctx);
			const timer = retryTimers[nextAttempt - 2];
			assert.ok(timer, `attempt ${nextAttempt} was scheduled`);
			timer.callback();
			await Promise.resolve();
			const active = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
			assert.equal(active.status, "active");
			assert.equal(active.runtime.attemptNumber, nextAttempt);
		}

		await api.emit("after_provider_response", { status: 503, headers: {} }, ctx);
		await api.emit("agent_settled", {}, ctx);
		const limited = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(limited.status, "usage_limited");
		assert.equal(limited.runtime.attemptNumber, 5);
		assert.equal(retryTimers.length, 4, "no sixth automatic attempt is scheduled");
		assert.equal(ctx.shutdownState.calls, 1);
		const result = JSON.parse(fs.readFileSync(path.join(cwd, "spec.result.json"), "utf8"));
		assert.equal(result.status, "usage_limited");
		assert.equal(result.exit.code, 1);
		const events = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.at(-1).type, "terminal", "terminal remains the final event after retry exhaustion");
		assert.ok(events.some((entry) => entry.type === "retry_exhausted" && entry.attemptNumber === 5));
	});

	it("applies the blueprint retry policy to the settled provider runtime", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown({
			retry: { maxInfrastructureAttempts: 2, maxSchemaRepairs: 0, baseDelayMs: 25, maxDelayMs: 25 },
		}));
		const retryTimers: Array<{ callback: () => void; delayMs: number }> = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setTimeout: ((callback: () => void, delayMs: number) => {
				retryTimers.push({ callback, delayMs });
				return retryTimers.length;
			}) as never,
			clearTimeout: (() => {}) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("after_provider_response", { status: 503, headers: {} }, ctx);
		await api.emit("agent_settled", {}, ctx);
		assert.equal(retryTimers[0]?.delayMs, 25);
		retryTimers[0].callback();
		await Promise.resolve();

		await api.emit("after_provider_response", { status: 503, headers: {} }, ctx);
		await api.emit("agent_settled", {}, ctx);
		const limited = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(limited.status, "usage_limited");
		assert.equal(limited.runtime.attemptNumber, 2);
		assert.equal(retryTimers.length, 1, "the custom policy must prevent a third attempt");
	});

	it("enforces configured capability approval in the live tool_call path", async () => {
		const cwd = project({
			capabilityGrants: [{ capability: "filesystem.write", scopes: ["outputs/**"], source: "repository" }],
			approvalRequiredCapabilities: ["filesystem.write"],
		});
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({ setTimeout: (() => 1) as never, clearTimeout: (() => {}) as never })(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const toolCallHandler = api.handlers.get("tool_call")?.[0];
		assert.ok(toolCallHandler, "tool_call handler registered");
		const result = await toolCallHandler({ toolName: "write", toolCallId: "write-1", input: { path: "outputs/host-smoke.md", content: "x" } }, ctx);
		assert.equal((result as { block?: boolean } | undefined)?.block, true);
		const view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.status, "paused");
		assert.match(view.pausedReason, /Approval is required/);
		assert.deepEqual(view.runtimeControl.approvals, []);
	});

	it("persists side-effect prepare/settle journal across session reconstruction", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		createPiGoalExtension()(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const prepared = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "marker-write-1", operation: "write", resource: "outputs/host-smoke.md", request: { content: "x" },
		}, ctx);
		const entryId = prepared.details.entry.id;
		const settled = await execute(api, "settle_goal_side_effect", { entryId, response: { ok: true } }, ctx);
		assert.equal(settled.details.entry.status, "committed");
		let view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.runtimeControl.sideEffectJournal[0].status, "committed");

		await api.emit("session_tree", {}, ctx);
		const reconstructed = await execute(api, "get_goal", {}, ctx);
		view = JSON.parse(reconstructed.content[0].text);
		assert.equal(view.runtimeControl.sideEffectJournal[0].status, "committed");
		const replay = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "marker-write-1", operation: "write", resource: "outputs/host-smoke.md", request: { content: "x" },
		}, ctx);
		assert.equal(replay.details.action, "replay");
	});

	it("restores an unresolved side effect as reconcile without duplicating the entry", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		createPiGoalExtension()(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const prepared = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "reconcile-1", operation: "write", resource: "outputs/reconcile.md", request: { content: "x" },
		}, ctx);
		await api.emit("session_tree", {}, ctx);
		const view = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
		assert.equal(view.runtimeControl.sideEffectJournal.length, 1);
		const retry = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "reconcile-1", operation: "write", resource: "outputs/reconcile.md", request: { content: "x" },
		}, ctx);
		assert.equal(retry.details.action, "reconcile");
		assert.equal(retry.details.entry.id, prepared.details.entry.id);
	});

	it("executes and reconciles external side effects through a trusted adapter", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const calls: string[] = [];
		let executeFailures = 1;
		const adapter: GoalSideEffectAdapterV3 = {
			id: "test-file-adapter",
			execute: async ({ entry, request }) => {
				calls.push("execute:" + entry.id);
				if (executeFailures > 0) {
					executeFailures -= 1;
					throw new Error("network adapter unavailable");
				}
				fs.writeFileSync(path.join(cwd, String(entry.resource)), String((request as { content?: unknown }).content ?? ""));
				return { ok: true };
			},
			reconcile: async ({ entry }) => {
			calls.push("reconcile:" + entry.id);
			return { status: "committed", response: { recovered: true } };
			},
		};
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({ sideEffectAdapter: adapter })(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const prepared = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "adapter-write-1", operation: "write", resource: "outputs/adapter.md", request: { content: "adapter-ok" },
		}, ctx);
		const entryId = prepared.details.entry.id;
		const failed = await execute(api, "execute_goal_side_effect", { entryId, request: { content: "adapter-ok" } }, ctx);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.entry.status, "failed");
		await api.emit("session_tree", {}, ctx);
		const pending = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "adapter-write-1", operation: "write", resource: "outputs/adapter.md", request: { content: "adapter-ok" },
		}, ctx);
		assert.equal(pending.details.action, "reconcile");
		const recovered = await execute(api, "reconcile_goal_side_effect", { entryId }, ctx);
		assert.equal(recovered.details.action, "committed");
		assert.equal(recovered.details.entry.status, "committed");
		assert.deepEqual(calls, ["execute:" + entryId, "reconcile:" + entryId]);
		const replay = await execute(api, "execute_goal_side_effect", { entryId, request: { content: "adapter-ok" } }, ctx);
		assert.equal(replay.details.action, "replay");
		assert.deepEqual(calls, ["execute:" + entryId, "reconcile:" + entryId]);
		assert.equal(fs.existsSync(path.join(cwd, "outputs/adapter.md")), false, "the failed first attempt must not write an artifact");
	});

	it("blocks mismatched and concurrent adapter execution without duplicating the side effect", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const adapter: GoalSideEffectAdapterV3 = {
			id: "concurrent-adapter",
			execute: async () => { calls += 1; await gate; return { ok: true }; },
			reconcile: async () => ({ status: "unknown" }),
		};
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({ sideEffectAdapter: adapter })(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const prepared = await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "concurrent-1", operation: "send", resource: "queue://jobs/1", request: { value: 1 },
		}, ctx);
		const entryId = prepared.details.entry.id;
		const mismatch = await execute(api, "execute_goal_side_effect", { entryId, request: { value: 2 } }, ctx);
		assert.equal(mismatch.isError, true);
		assert.equal(mismatch.details.code, "idempotency_conflict");
		assert.equal(calls, 0);
		const first = execute(api, "execute_goal_side_effect", { entryId, request: { value: 1 } }, ctx);
		const concurrent = await execute(api, "execute_goal_side_effect", { entryId, request: { value: 1 } }, ctx);
		assert.equal(concurrent.details.action, "reconcile");
		assert.equal(calls, 1);
		release();
		const committed = await first;
		assert.equal(committed.details.action, "committed");
		assert.equal(calls, 1);
	});

	it("fails closed when a persisted runtime checkpoint is tampered with", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		createPiGoalExtension()(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "tamper-1", operation: "write", resource: "outputs/tampered.md", request: { content: "x" },
		}, ctx);
		const runtimeEvent = api.branch.find((entry) => entry.customType === "pi-goal:runtime-event-v3" && entry.data?.type === "goal.side_effect_prepared");
		assert.ok(runtimeEvent);
		runtimeEvent.data.payload.checkpoint.sideEffects[0].resource = "outputs/changed.md";
		await api.emit("session_tree", {}, ctx);
		const result = await execute(api, "get_goal", {}, ctx);
		assert.match(result.content[0].text, /Runtime control checkpoint rejected: checkpoint checksum mismatch/);
	});

	it("rejects a checkpoint with a valid checksum but the wrong runtime lineage", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		createPiGoalExtension()(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "prepare_goal_side_effect", {
			idempotencyKey: "lineage-1", operation: "write", resource: "outputs/lineage.md", request: { content: "x" },
		}, ctx);
		const runtimeEvent = api.branch.find((entry) => entry.customType === "pi-goal:runtime-event-v3" && entry.data?.type === "goal.side_effect_prepared");
		assert.ok(runtimeEvent);
		const checkpoint = runtimeEvent.data.payload.checkpoint;
		runtimeEvent.data.payload.checkpoint = createGoalRuntimeCheckpointV3({
			...checkpoint,
			checksum: undefined,
			lineage: { ...checkpoint.lineage, revisionId: checkpoint.lineage.revisionId + ":forged" },
		});
		await api.emit("session_tree", {}, ctx);
		const result = await execute(api, "get_goal", {}, ctx);
		assert.match(result.content[0].text, /checkpoint lineage does not match the active Goal run/);
	});

	it("runs an injected deterministic pre-tool hook in the live host event path", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const hooks = new GoalRuntimeHooksV3();
		hooks.register({ id: "deny-writes", target: "tool", phase: "pre", run: (input) => input.operation === "write" ? { deny: true, reason: "write requires an adapter" } : undefined });
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({ runtimeHooks: hooks })(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const toolCallHandler = api.handlers.get("tool_call")?.[0];
		assert.ok(toolCallHandler);
		const result = await toolCallHandler({ toolName: "write", toolCallId: "write-hook-1", input: { path: "outputs/host-smoke.md", content: "x" } }, ctx);
		assert.equal((result as { block?: boolean } | undefined)?.block, true);
		assert.match((result as { reason?: string }).reason ?? "", /adapter/);
	});

	it("uses the same update_goal action API and state transitions for interactive and headless blueprints", async () => {
		const headlessCwd = project();
		const interactiveCwd = project();
		const headlessSpec = path.join(headlessCwd, "spec.md");
		const interactiveSpec = path.join(interactiveCwd, "spec.md");
		fs.writeFileSync(headlessSpec, specMarkdown());
		fs.writeFileSync(interactiveSpec, specMarkdown());

		const headlessApi = new HeadlessFakeAPI();
		headlessApi.setFlag("goal-run", headlessSpec);
		piGoalExtension(headlessApi as any);
		const headlessCtx = context(headlessCwd, headlessApi);
		await headlessApi.emit("session_start", {}, headlessCtx);

		const interactiveApi = new HeadlessFakeAPI();
		piGoalExtension(interactiveApi as any);
		const interactiveCtx = context(interactiveCwd, interactiveApi);
		await interactiveApi.emit("session_start", {}, interactiveCtx);
		await interactiveApi.commands.get("goal").handler("run spec.md", interactiveCtx);

		assert.deepEqual(interactiveApi.tools.get("update_goal").parameters, headlessApi.tools.get("update_goal").parameters);
		const actions = [
			{
				action: "record_deviation",
				subjectId: "execution.topology",
				description: "Use one sequential pass",
				reason: "The fixture has one independent output",
				impact: "none",
			},
			{
				action: "record_evidence",
				criterionId: "c1",
				evidence: { id: "e-shared", kind: "command", summary: "Shared verifier passed", verification: "verified", origin: "tool" },
			},
		];
		for (const action of actions) {
			assert.equal((await execute(headlessApi, "update_goal", action, headlessCtx)).isError, undefined);
			assert.equal((await execute(interactiveApi, "update_goal", action, interactiveCtx)).isError, undefined);
		}
		const headlessView = JSON.parse((await execute(headlessApi, "get_goal", {}, headlessCtx)).content[0].text);
		const interactiveView = JSON.parse((await execute(interactiveApi, "get_goal", {}, interactiveCtx)).content[0].text);
		assert.deepEqual(
			interactiveView.deviations.map(({ id: _id, recordedAt: _recordedAt, ...rest }: any) => rest),
			headlessView.deviations.map(({ id: _id, recordedAt: _recordedAt, ...rest }: any) => rest),
		);
		assert.deepEqual(
			interactiveView.evidenceLedger.map(({ id: _id, recordedAt: _recordedAt, ...rest }: any) => rest),
			headlessView.evidenceLedger.map(({ id: _id, recordedAt: _recordedAt, ...rest }: any) => rest),
		);
		assert.equal(interactiveView.runtime.entrypoint, "interactive");
		assert.equal(headlessView.runtime.entrypoint, "headless");
	});

	it("logs tool calls, llm responses, and heartbeats (activity transparency)", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		// 注入可控定时器：捕获心跳回调，手动触发验证。
		const intervals: Array<() => void> = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setInterval: ((cb: () => void) => { intervals.push(cb); return intervals.length; }) as never,
			clearInterval: ((timer: number) => { intervals.splice(timer - 1, 1); }) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await api.emit("input", { source: "user", text: "Use the declared contract." }, ctx);

		// 工具调用日志
		await api.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }, ctx);
		await api.emit("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: { stdout: "ok" }, isError: false }, ctx);
		// LLM 响应
		await api.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 20 }, stopReason: "tool_use" } }, ctx);

		const lines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n");
		const events = lines.map((line) => JSON.parse(line));
		const toolStarted = events.find((e) => e.type === "tool_started");
		assert.ok(toolStarted, "tool_started logged");
		assert.equal(toolStarted.tool, "bash");
		assert.match(toolStarted.args, /npm test/);
		const toolEnded = events.find((e) => e.type === "tool_ended");
		assert.ok(toolEnded, "tool_ended logged");
		assert.equal(toolEnded.isError, false);
		assert.equal(typeof toolEnded.durationMs, "number");
		assert.match(toolEnded.result, /ok/);
		const llm = events.find((e) => e.type === "llm_response");
		assert.ok(llm, "llm_response logged");
		assert.equal(llm.stopReason, "tool_use");
		assert.deepEqual(llm.usage, { input: 10, output: 20 });
		assert.ok(events.some((entry) => entry.type === "steering_received"), "headless steering is logged, not trace-only");
		const traces = fs.readFileSync(path.join(cwd, "spec.goal.jsonl.trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(traces.map((span) => span.name), events.map((entry) => `goal.${entry.type}`));
		const tracedToolStart = traces.find((span) => span.name === "goal.tool_started");
		const tracedToolEnd = traces.find((span) => span.name === "goal.tool_ended");
		assert.equal(tracedToolStart.attributes["tool.name"], "bash");
		assert.equal(tracedToolEnd.attributes["tool.name"], "bash");
		assert.equal(tracedToolEnd.parentSpanId, tracedToolStart.spanId);
		const tracedLlm = traces.find((span) => span.name === "goal.llm_response");
		assert.equal(tracedLlm.attributes["gen_ai.usage.input_tokens"], 10);
		assert.equal(traces.find((span) => span.name === "goal.steering_received").attributes["goal.steering.kind"], "initial");
		assert.equal(traces.some((span) => span.attributes["tool.name"] === "get_goal"), false);

		await api.emit("tool_execution_start", { toolCallId: "t2", toolName: "update_goal", args: { action: "submit_completion_bundle" } }, ctx);
		await api.emit("tool_execution_end", {
			toolCallId: "t2",
			toolName: "update_goal",
			result: { content: [{ type: "text", text: "Completion rejected." }], isError: true, details: { kind: "completion_bundle_rejected" } },
			isError: false,
		}, ctx);
		const rejectedEvents = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const rejected = rejectedEvents.find((entry) => entry.type === "tool_ended" && entry.toolCallId === "t2");
		assert.equal(rejected.isError, true, "business-level tool rejection is logged as an error");
		const rejectedTraces = fs.readFileSync(path.join(cwd, "spec.goal.jsonl.trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(rejectedTraces.find((span) => span.name === "goal.tool_ended" && span.attributes["tool.call_id"] === "t2").status, "error");

		// 心跳：触发捕获的 interval 回调
		await api.emit("turn_start", { turnIndex: 3, timestamp: Date.now() }, ctx);
		assert.equal(intervals.length, 1, "heartbeat interval registered");
		intervals[0]();
		const heartbeat = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n")
			.map((line) => JSON.parse(line)).find((e) => e.type === "heartbeat");
		assert.ok(heartbeat, "heartbeat logged");
		assert.ok(["thinking", "tool", "waiting", "idle"].includes(heartbeat.phase));
		assert.equal(typeof heartbeat.tokensUsed, "number");
	});

	it("bridges nested spawn_role progress into the headless log and heartbeat", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const intervals: Array<() => void> = [];
		const api = new HeadlessFakeAPI();
		createPiGoalExtension({
			setInterval: ((cb: () => void) => { intervals.push(cb); return intervals.length; }) as never,
			clearInterval: ((timer: number) => { intervals.splice(timer - 1, 1); }) as never,
		})(api as any);
		api.setFlag("goal-run", specPath);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await api.emit("tool_execution_start", { toolCallId: "spawn-1", toolName: "spawn_role", args: { role: "report-reviewer" } }, ctx);
		await api.emit("tool_execution_update", {
			toolCallId: "spawn-1", toolName: "spawn_role",
			partialResult: { details: { kind: "subagent-progress", id: "sub-1", role: "report-reviewer", sessionFile: "/child.jsonl", phase: "tool", turnCount: 2, tool: "read", lastActivityAt: Date.now() } },
		}, ctx);
		await api.emit("tool_execution_update", {
			toolCallId: "spawn-1", toolName: "spawn_role",
			partialResult: { details: { kind: "subagent-progress", id: "sub-1", role: "report-reviewer", sessionFile: "/child.jsonl", phase: "tool", turnCount: 2, tool: "read", lastActivityAt: Date.now() } },
		}, ctx);
		const lines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const nested = lines.filter((entry) => entry.type === "subagent_started" || entry.type === "subagent_progress");
		assert.equal(nested.length, 1, "identical nested progress is deduplicated");
		const started = nested[0];
		assert.equal(started.agentId, "sub-1");
		assert.equal(started.tool, "read");
		assert.equal("args" in started, false, "nested progress remains sanitized");
		assert.ok(intervals.length > 0);
		intervals[0]();
		const heartbeatEntries = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; subagents?: any[] });
		const heartbeats = heartbeatEntries.filter((entry) => entry.type === "heartbeat");
		const heartbeat = heartbeats[heartbeats.length - 1];
		assert.ok(heartbeat?.subagents);
		assert.equal(heartbeat.subagents[0].agentId, "sub-1");
		assert.equal(heartbeat.subagents[0].phase, "tool");
	});

	it("synchronously continues the loop at agent_end (print-mode fix)", async () => {
		// print-mode 的 session.prompt() 只等当前 run 完成；agent_end 的 emit 窗口内
		// isStreaming=true，同步 sendMessage(followUp) 入队后 agent loop 继续。
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("agent_end", {}, ctx);

		// 同步出现续跑消息（不依赖 3s 定时器）
		const continuations = api.sent.filter((entry) => entry.message.customType === "pi-goal:continuation");
		assert.equal(continuations.length, 1);
		assert.equal(continuations[0].options.deliverAs, "followUp");
		assert.match(continuations[0].message.content, /Continue working toward the active goal/);
		const goal = await execute(api, "get_goal", {}, ctx);
		assert.equal(JSON.parse(goal.content[0].text).status, "active");
	});

	it("counts headless turns when agent_end precedes turn_end", async () => {
		// The print host can emit agent_end before the accounting turn_end event.
		// Headless turns must still advance the auto-turn/no-progress guards.
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("agent_end", {}, ctx);
		await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
		await api.emit("agent_end", {}, ctx);
		await api.emit("turn_end", {
			turnIndex: 1,
			timestamp: Date.now(),
			toolResults: [],
			message: { role: "assistant", content: [{ type: "text", text: "" }], usage: { output: 0 } },
		}, ctx);

		const settled = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n")
			.map((line) => JSON.parse(line)).filter((entry) => entry.type === "turn_settled");
		assert.equal(settled.at(-1)?.autoTurnCount, 1);
		assert.equal(settled.at(-1)?.noProgressCount, 1);
	});

	it("pauses at the auto-turn cap when turn_end follows agent_end", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown({ completion: { maxAutoTurns: 1 } }));
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		// Reproduce print-mode ordering: agent_end queues the next continuation
		// before turn_end has settled and incremented the counters.
		await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
		await api.emit("agent_end", {}, ctx);
		await api.emit("turn_end", {
			turnIndex: 1,
			timestamp: Date.now(),
			toolResults: [],
			message: { role: "assistant", content: [{ type: "text", text: "" }], usage: { output: 0 } },
		}, ctx);

		const goal = await execute(api, "get_goal", {}, ctx);
		const view = JSON.parse(goal.content[0].text);
		assert.equal(view.status, "paused");
		assert.equal(view.pausedReason, "reached max auto-turns (1)");
		assert.equal(api.sent.filter((entry) => entry.message.customType === "pi-goal:continuation").length, 1);
		const events = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const traces = fs.readFileSync(path.join(cwd, "spec.goal.jsonl.trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(traces.length, events.length, "headless lifecycle events and trace spans stay one-to-one");
		assert.deepEqual(
			traces.map((span) => span.attributes["goal.event_seq"]),
			events.map((entry) => entry.seq),
		);
		assert.deepEqual(traces.map((span) => span.name), events.map((entry) => `goal.${entry.type}`));
	});

	for (const order of ["agent_end_first", "turn_end_first"] as const) {
		it(`completes a flat legacy request once when ${order.replaceAll("_", " ")}`, async () => {
			const cwd = project();
			const specPath = path.join(cwd, "legacy.md");
			fs.writeFileSync(specPath, specMarkdown({
				review: { requirement: "none", checklist: [] },
				verification: { command: "true", timeoutMs: 10_000 },
				completion: { policy: "legacy", maxAutoTurns: 10 },
			}));
			let judgeCalls = 0;
			const api = new HeadlessFakeAPI();
			createPiGoalExtension({
				complete: (async () => {
					judgeCalls += 1;
					return {
						role: "assistant",
						content: [{ type: "text", text: '{"done":true,"reason":"legacy evidence accepted"}' }],
						usage: { output: 1 },
					};
				}) as any,
			})(api as any);
			api.setFlag("goal-run", specPath);
			const ctx = context(cwd, api);
			(ctx as any).model = { id: "legacy-test-model" };
			(ctx as any).modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test" });
			await api.emit("session_start", {}, ctx);
			await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);

			const evidence = await execute(api, "update_goal", {
				criterionId: "c1",
				evidence: "legacy command evidence verified",
				kind: "command",
				verification: "verified",
			}, ctx);
			assert.equal(evidence.isError, undefined);
			const completion = await execute(api, "update_goal", {
				status: "complete",
				evidence: "legacy V2 completion request",
			}, ctx);
			assert.equal(completion.isError, undefined);

			const turnEnd = () => api.emit("turn_end", {
				turnIndex: 1,
				timestamp: Date.now(),
				toolResults: [{ ok: true }],
				message: { role: "assistant", content: [{ type: "text", text: "Legacy request submitted." }], usage: { output: 5 } },
			}, ctx);
			if (order === "agent_end_first") {
				await api.emit("agent_end", {}, ctx);
				await turnEnd();
			} else {
				await turnEnd();
				await api.emit("agent_end", {}, ctx);
			}

			const goal = JSON.parse((await execute(api, "get_goal", {}, ctx)).content[0].text);
			assert.equal(goal.status, "complete");
			assert.equal(goal.criteria[0].evidenceRefs.length, 1);
			assert.equal(goal.completion.lastEvaluation.decision, "accept");
			assert.equal(judgeCalls, 1, "the same legacy request must be judged exactly once");
			assert.equal(api.sent.filter((entry) => entry.message.customType === "pi-goal:continuation").length, 0);

			const result = JSON.parse(fs.readFileSync(path.join(cwd, "legacy.result.json"), "utf8"));
			assert.equal(result.status, "complete");
			assert.equal(result.criteria[0].status, "verified");
			assert.equal(result.exit.code, 0);
			const events = fs.readFileSync(path.join(cwd, "legacy.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.ok(events.some((entry) => entry.type === "status" && entry.status === "complete"));
			assert.equal(events.filter((entry) => entry.type === "terminal").length, 1);
		});
	}

	it("does not misclassify a dispose abort as interrupted (headless)", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const controller = new AbortController();
		const ctx = context(cwd, api);
		(ctx as { signal: unknown }).signal = controller.signal;
		await api.emit("session_start", {}, ctx);

		controller.abort();
		await api.emit("agent_end", {}, ctx);

		// 不 pauseGoal：goal 保持 active，result 如实写出（exit 1）
		const goal = await execute(api, "get_goal", {}, ctx);
		assert.equal(JSON.parse(goal.content[0].text).status, "active");
		const result = JSON.parse(fs.readFileSync(path.join(cwd, "spec.result.json"), "utf8"));
		assert.equal(result.status, "active");
		assert.equal(result.exit.code, 1);
		const log = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(log.some((entry) => entry.type === "terminal"), false, "active abort is an interim snapshot, not terminal");
		// 无续跑消息
		assert.equal(api.sent.some((entry) => entry.message.customType === "pi-goal:continuation"), false);
	});

	it("keeps the interactive interrupted pause for non-headless goals", async () => {
		const cwd = project();
		const api = new HeadlessFakeAPI();
		piGoalExtension(api as any);
		const controller = new AbortController();
		const ctx = context(cwd, api);
		(ctx as { signal: unknown }).signal = controller.signal;
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "普通目标", criteria: ["完成"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);

		controller.abort();
		await api.emit("agent_end", {}, ctx);

		const goal = await execute(api, "get_goal", {}, ctx);
		const view = JSON.parse(goal.content[0].text);
		assert.equal(view.status, "paused");
		assert.equal(view.pausedReason, "interrupted");
	});

	it("bootstraps a goal from --goal-run at session_start and logs goal_started", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const goal = await execute(api, "get_goal", {}, ctx);
		assert.equal(goal.isError, undefined);
		const view = JSON.parse(goal.content[0].text);
		assert.equal(view.objective, "完成 JWT 迁移");
		assert.equal(view.execution.selected, "direct");
		assert.equal(view.execution.source, "user");
		assert.equal(view.blueprint.execution.topology, "direct");
		assert.equal(view.criteria[0].id, "c1");
		assert.equal(view.usage.tokenBudget, 200000);

		// 日志：goal_started 已写入；续跑循环由首个 turn 结束后的 agent_end → scheduleContinuation 启动
		// （headless print 模式下立即 sendContinuation 会与初始 run 竞态，已移除）。
		const logLines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n");
		assert.equal(logLines.length, 1);
		const started = JSON.parse(logLines[0]);
		assert.equal(started.type, "goal_started");
		assert.equal(started.goalId, view.id);
	});

	it("fails fast on an invalid blueprint and sets exitCode 1", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "bad.md");
		fs.writeFileSync(specPath, specMarkdown({ execution: { topology: "swarm" } }));
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const goal = await execute(api, "get_goal", {}, ctx);
		assert.match(goal.content[0].text, /No goal is currently set/);
		assert.equal(process.exitCode, 1);
		assert.equal(fs.existsSync(path.join(cwd, "bad.result.json")), false);
	});

	it("rejects verification.command in an untrusted project", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown({ verification: { command: "npm test" } }));
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api, false);
		await api.emit("session_start", {}, ctx);
		const goal = await execute(api, "get_goal", {}, ctx);
		assert.match(goal.content[0].text, /No goal is currently set/);
		assert.equal(process.exitCode, 1);
	});

	it("records deviations and evidence with log entries", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const deviation = await execute(api, "update_goal", {
			action: "record_deviation",
			subjectId: "dag.nodes.research",
			description: "改为串行",
			reason: "无并行空间",
			impact: "无",
		}, ctx);
		assert.equal(deviation.isError, undefined);
		assert.match(deviation.content[0].text, /Deviation recorded/);

		const evidence = await execute(api, "update_goal", {
			action: "record_evidence",
			criterionId: "c1",
			evidence: { id: "e1", kind: "command", summary: "npm test 全部通过", verification: "verified", origin: "tool" },
		}, ctx);
		assert.equal(evidence.isError, undefined);

		const goal = await execute(api, "get_goal", {}, ctx);
		const view = JSON.parse(goal.content[0].text);
		assert.equal(view.deviations.length, 1);
		assert.equal(view.deviations[0].description, "改为串行");
		assert.equal(view.evidenceLedger.length, 1);

		const logLines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n");
		const types = logLines.map((line) => JSON.parse(line).type);
		assert.ok(types.includes("deviation_recorded"));
		assert.ok(types.includes("evidence_recorded"));
	});

	it("finalizes with a result file and terminal log on a non-active transition", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown());
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const unmet = await execute(api, "update_goal", { action: "mark_unmet", blocker: "测试终止" }, ctx);
		assert.equal(unmet.isError, undefined);

		const result = JSON.parse(fs.readFileSync(path.join(cwd, "spec.result.json"), "utf8"));
		assert.equal(result.status, "unmet");
		assert.equal(result.exit.code, 1);
		assert.match(result.exit.message, /unmet/);
		assert.equal(process.exitCode, 1);

		const logLines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n");
		const last = JSON.parse(logLines[logLines.length - 1]);
		assert.equal(last.type, "terminal");
		assert.equal(last.result.status, "unmet");
		assert.equal(ctx.shutdownState.calls, 1, "terminal headless transition requests process shutdown once");
		// status 变更日志在 terminal 之前
		const types = logLines.map((line) => JSON.parse(line).type);
		assert.ok(types.includes("status"));
	});

	it("emits budget_warning once per threshold crossing on turn settlement", async () => {
		const cwd = project();
		const specPath = path.join(cwd, "spec.md");
		fs.writeFileSync(specPath, specMarkdown({ budget: { tokens: 100 } }));
		const api = new HeadlessFakeAPI();
		api.setFlag("goal-run", specPath);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		await api.emit("turn_start", { turnIndex: 1, timestamp: Date.now() }, ctx);
		await api.emit("turn_end", {
			turnIndex: 1,
			timestamp: Date.now(),
			toolResults: [],
			message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: { output: 60 } },
		}, ctx);

		const logLines = fs.readFileSync(path.join(cwd, "spec.goal.jsonl"), "utf8").trim().split("\n");
		const warnings = logLines.map((line) => JSON.parse(line)).filter((entry) => entry.type === "budget_warning");
		assert.equal(warnings.length, 1);
		assert.equal(warnings[0].percent, 50);
		const settled = logLines.map((line) => JSON.parse(line)).filter((entry) => entry.type === "turn_settled");
		assert.equal(settled.length, 1);
		assert.equal(settled[0].tokensUsed, 60);
	});
});
