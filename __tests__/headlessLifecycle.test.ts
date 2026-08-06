import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import piGoalExtension, { createPiGoalExtension } from "../extensions/index";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class HeadlessFakeAPI {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
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
	registerCommand() {}
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

function project() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-headless-lifecycle-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy: "v2",
		reviewPolicy: "risk_based",
	}));
	return cwd;
}

function context(cwd: string, api: HeadlessFakeAPI, trusted = true) {
	return {
		cwd,
		hasUI: false,
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
