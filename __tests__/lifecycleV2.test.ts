import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import piGoalExtension, { createPiGoalExtension } from "../extensions/index";
import { createGoalSnapshotV2, createGoalStateV2 } from "../extensions/state";

const GOAL_CONTINUATION_TYPE = "pi-goal:continuation";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class FakeExtensionAPI {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly commands = new Map<string, any>();
	readonly sent: Array<{ message: any; options: any }> = [];
	readonly branch: any[];
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
	getActiveTools() { return [...this.activeTools]; }
	setActiveTools(tools: string[]) { this.activeTools = [...tools]; }
	appendEntry(customType: string, data: unknown) {
		this.branch.push({ type: "custom", customType, data, timestamp: Date.now() });
	}
	sendMessage(message: any, options: any) { this.sent.push({ message, options }); }
	sendUserMessage(message: string) { this.sent.push({ message: { role: "user", content: message }, options: {} }); }
}

class FakeTickerClock {
	private value: number;
	private nextId = 1;
	private readonly intervals = new Map<number, { callback: () => void; ms: number; nextAt: number }>();

	constructor(start: number) { this.value = start; }
	readonly now = () => this.value;
	readonly setInterval = (callback: () => void, ms: number): ReturnType<typeof setInterval> => {
		const id = this.nextId++;
		this.intervals.set(id, { callback, ms, nextAt: this.value + ms });
		return id as unknown as ReturnType<typeof setInterval>;
	};
	readonly clearInterval = (timer: ReturnType<typeof setInterval>) => {
		this.intervals.delete(timer as unknown as number);
	};
	advance(ms: number): void {
		const target = this.value + ms;
		while (true) {
			let next: { id: number; at: number } | null = null;
			for (const [id, interval] of this.intervals) {
				if (interval.nextAt <= target && (!next || interval.nextAt < next.at || (interval.nextAt === next.at && id < next.id))) {
					next = { id, at: interval.nextAt };
				}
			}
			if (!next) break;
			this.value = next.at;
			const interval = this.intervals.get(next.id);
			if (!interval) continue;
			interval.nextAt += interval.ms;
			interval.callback();
		}
		this.value = target;
	}
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function project(
	completionPolicy: "legacy" | "shadow" | "v2" = "v2",
	overrides: Record<string, unknown> = {},
) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-lifecycle-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2,
		superpowersIntegration: false,
		completionPolicy,
		reviewPolicy: "risk_based",
		...overrides,
	}));
	return cwd;
}

function context(cwd: string, api: FakeExtensionAPI, model?: any) {
	const statusUpdates: Array<string | undefined> = [];
	return {
		statusUpdates,
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
			setStatus: (_key: string, value: string | undefined) => { statusUpdates.push(value); },
			theme: { fg: (_color: string, text: string) => text },
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

describe("real ExtensionAPI Goal V2 lifecycle", () => {
	it("rejects malformed draft boundaries before creating goal state", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const validBase = {
			objective: "Produce a supported result",
			criteria: ["Result is supported"],
			taskKind: "research",
			executionPreference: "direct",
			roleCatalogAvailable: false,
			assurance: { risk: "low" },
		};
		const invalidCases = [
			{ expected: /objective.*blank/i, input: { ...validBase, objective: " \t " } },
			{ expected: /constraints?.*blank/i, input: { ...validBase, constraints: [" "] } },
			{
				expected: /duplicate claim id.*claim-1/i,
				input: {
					...validBase,
					researchClaims: [
						{ id: "claim-1", text: "First", materiality: "material" },
						{ id: "claim-1", text: "Second", materiality: "supporting" },
					],
				},
			},
			{
				expected: /unknown draft evidence.*not-yet-recorded/i,
				input: {
					...validBase,
					researchClaims: [{
						id: "claim-1", text: "Claim", materiality: "material",
						evidenceRefs: ["not-yet-recorded"],
					}],
				},
			},
		];

		for (const { input, expected } of invalidCases) {
			const result = await execute(api, "propose_goal_draft", input, ctx);
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, expected);
			assert.equal(api.branch.length, 0, "invalid draft must not persist a goal snapshot");
		}
		await api.emit("session_shutdown", {}, ctx);
	});

	it("selects direct, specialist, and team topologies through the real draft tool", async () => {
		const cases = [
			{
				name: "direct", config: { defaultExecution: "direct" }, preference: undefined, role: undefined,
				routing: { uncertainty: "low", coupling: "high", risk: "low", specialistNeed: "none", independentWorkstreams: 1, heterogeneousSkills: false, effort: "small" },
			},
			{
				name: "specialist", config: {}, preference: "specialist", role: "researcher",
				routing: { uncertainty: "high", coupling: "high", risk: "low", specialistNeed: "required", independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium" },
			},
			{
				name: "team", config: {}, preference: "team", role: undefined,
				routing: { uncertainty: "high", coupling: "low", risk: "low", specialistNeed: "helpful", independentWorkstreams: 3, heterogeneousSkills: true, effort: "large" },
			},
		] as const;
		for (const item of cases) {
			const cwd = project("v2", item.config ?? {});
			const api = new FakeExtensionAPI();
			piGoalExtension(api as any);
			const ctx = context(cwd, api);
			await api.emit("session_start", {}, ctx);
			const result = await execute(api, "propose_goal_draft", {
				objective: "Route " + item.name, criteria: ["Outcome exists"], taskKind: "general",
				...(item.preference ? { executionPreference: item.preference } : {}),
				...(item.role ? { role: item.role } : {}),
				availableRoles: ["researcher"], roleCatalogAvailable: true,
				routing: item.routing, assurance: { risk: "low" },
			}, ctx);
				assert.equal(result.isError, undefined);
				const routed = await publicGoal(api, ctx);
				assert.equal(routed.execution.selected, item.name);
				assert.equal(routed.execution.source, "auto", "model-produced draft preferences must not create a user lock");
			await api.emit("session_shutdown", {}, ctx);
		}
	});

	it("downgrades draft environment-state gates through the real draft tool", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const result = await execute(api, "propose_goal_draft", {
			objective: "Implement a slugify function",
			criteria: [
				"git status --porcelain must be empty",
				"The slugify function passes npm test",
			],
			taskKind: "coding",
			executionPreference: "direct",
			roleCatalogAvailable: false,
		}, ctx);
		assert.equal(result.isError, undefined);
		const goal = await publicGoal(api, ctx);
		const byLevel = Object.fromEntries(goal.criteria.map((c: any) => [c.description, c.level]));
		assert.equal(byLevel["git status --porcelain must be empty"], "advisory");
		assert.equal(byLevel["The slugify function passes npm test"], "blocking");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("uses a specialist probe at low confidence and falls back to direct when no matching role exists", async () => {
		const lowConfidence = {
			uncertainty: "high", coupling: "high", risk: "low", specialistNeed: "none",
			independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium", confidence: 0.25,
		};
		const specialistCwd = project("v2");
		const specialistApi = new FakeExtensionAPI();
		piGoalExtension(specialistApi as any);
		const specialistCtx = context(specialistCwd, specialistApi);
		await specialistApi.emit("session_start", {}, specialistCtx);
		const specialist = await execute(specialistApi, "propose_goal_draft", {
			objective: "Probe a specialist question", criteria: ["Question is resolved"], taskKind: "general",
			role: "researcher", availableRoles: ["researcher"], roleCatalogAvailable: true,
			routing: lowConfidence, assurance: { risk: "low" },
		}, specialistCtx);
		assert.equal(specialist.isError, undefined);
		assert.equal((await publicGoal(specialistApi, specialistCtx)).execution.selected, "specialist");
		await specialistApi.emit("session_shutdown", {}, specialistCtx);

		const fallbackCwd = project("v2");
		const fallbackApi = new FakeExtensionAPI();
		piGoalExtension(fallbackApi as any);
		const fallbackCtx = context(fallbackCwd, fallbackApi);
		await fallbackApi.emit("session_start", {}, fallbackCtx);
		const fallback = await execute(fallbackApi, "propose_goal_draft", {
			objective: "Probe without a role", criteria: ["Question is resolved"], taskKind: "general",
			availableRoles: ["reviewer"], roleCatalogAvailable: true,
			routing: lowConfidence, assurance: { risk: "low" },
		}, fallbackCtx);
		assert.equal(fallback.isError, undefined);
		const fallbackGoal = await publicGoal(fallbackApi, fallbackCtx);
		assert.equal(fallbackGoal.execution.selected, "direct");
		assert.match(fallbackGoal.execution.reasons.join(" "), /no matching registered specialist role/i);
		await fallbackApi.emit("session_shutdown", {}, fallbackCtx);
	});

	it("requires list_roles and routes only from the observed role catalog", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		api.setActiveTools(["read", "spawn_role", "dag_execute", "list_roles"]);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const specialistDraft = {
			objective: "Route through a registered specialist",
			criteria: ["The specialist produces the requested outcome"],
			taskKind: "general",
			executionPreference: "specialist",
			routing: {
				uncertainty: "high", coupling: "high", risk: "low", specialistNeed: "required",
				independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium",
			},
			assurance: { risk: "low" },
		};

		const beforeCatalog = await execute(api, "propose_goal_draft", {
			...specialistDraft,
			role: "researcher",
			availableRoles: ["researcher"],
			roleCatalogAvailable: true,
		}, ctx);
		assert.equal(beforeCatalog.isError, true);
		assert.match(beforeCatalog.content[0].text, /call list_roles before propose_goal_draft/i);
		assert.equal(beforeCatalog.details.requiredTool, "list_roles");
		assert.equal(api.branch.length, 0, "a rejected preflight must not persist goal state");

		await api.emit("tool_result", {
			toolName: "list_roles",
			toolCallId: "catalog",
			input: {},
			isError: false,
			details: {
				roles: [{ name: "researcher", description: "Research specialist", tools: [], skills: [] }],
			},
			content: [{ type: "text", text: JSON.stringify({ roles: [{ name: "researcher" }] }) }],
		}, ctx);

		const fabricatedRole = await execute(api, "propose_goal_draft", {
			...specialistDraft,
			role: "fabricated",
			availableRoles: ["fabricated"],
			roleCatalogAvailable: true,
		}, ctx);
		assert.equal(fabricatedRole.isError, true);
		assert.match(fabricatedRole.content[0].text, /matching registered role from list_roles/i);
		assert.deepEqual(fabricatedRole.details.availableRoles, ["researcher"]);

		const registeredRole = await execute(api, "propose_goal_draft", {
			...specialistDraft,
			role: "researcher",
			availableRoles: ["fabricated"],
			roleCatalogAvailable: true,
		}, ctx);
		assert.equal(registeredRole.isError, undefined);
		const state = await publicGoal(api, ctx);
		assert.equal(state.execution.selected, "specialist");
		assert.equal(state.execution.role, "researcher");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("preserves a real user execution lock against agent route changes", async () => {
		const cwd = project("v2");
		const now = Date.now();
		const seededGoal = createGoalStateV2({
			id: "user-locked-goal",
			objective: "Keep the user-selected direct route",
			criteria: [{ id: "outcome", description: "Outcome exists" }],
			taskKind: "general",
			execution: {
				preference: "direct", selected: "direct", source: "user", confidence: 1,
				reasons: ["Selected in Goal Draft Review."],
				reassessOn: ["scope_expanded", "new_workstream", "conflict", "stalled"],
			},
			assurance: {
				reviewRequirement: "none", reviewStatus: "not_required", independent: false,
				depth: "light", source: "auto", reasons: ["Low risk"], decidedAt: now,
			},
			now,
		});
		const branch = [{
			type: "custom", customType: "pi-goal", timestamp: now,
			data: createGoalSnapshotV2({ revision: 1, savedAt: now, action: "set", goal: seededGoal }),
		}];
		const api = new FakeExtensionAPI(branch);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const result = await execute(api, "update_goal", {
			action: "change_execution",
			execution: {
				preference: "team", selected: "team", source: "auto", confidence: 0.8,
				reasons: ["Agent discovered more work."], reassessOn: ["stalled"],
			},
		}, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /user-locked/i);
		assert.equal((await publicGoal(api, ctx)).execution.selected, "direct");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("fails an explicit unknown specialist but uses direct when pi-roles is unavailable", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		api.setActiveTools(["read"]);
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const explicit = await execute(api, "propose_goal_draft", {
			objective: "Use an unavailable specialist", criteria: ["Outcome exists"], taskKind: "general",
			executionPreference: "specialist", role: "missing", availableRoles: [], roleCatalogAvailable: true,
			routing: { uncertainty: "high", coupling: "high", risk: "low", specialistNeed: "required", independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium" },
			assurance: { risk: "low" },
		}, ctx);
		assert.equal(explicit.isError, true);
		assert.match(explicit.content[0].text, /unavailable|registered role/i);

		const automatic = await execute(api, "propose_goal_draft", {
			objective: "Fall back without pi-roles", criteria: ["Outcome exists"], taskKind: "general",
			role: "missing", roleCatalogAvailable: false,
			routing: { uncertainty: "high", coupling: "high", risk: "low", specialistNeed: "required", independentWorkstreams: 1, heterogeneousSkills: false, effort: "medium" },
			assurance: { risk: "low" },
		}, ctx);
		assert.equal(automatic.isError, undefined);
		assert.equal((await publicGoal(api, ctx)).execution.selected, "direct");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("derives required assurance from a declared high-risk material claim", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const result = await execute(api, "propose_goal_draft", {
			objective: "Assess a high-risk claim", criteria: ["The assessment is supported"], taskKind: "research",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
			researchClaims: [{ id: "claim-risk", text: "The material claim is safe to act on.", materiality: "material", risk: "high" }],
		}, ctx);
		assert.equal(result.isError, undefined);
		const state = await publicGoal(api, ctx);
		assert.equal(state.assurance.reviewRequirement, "required");
		assert.ok(state.assurance.reasons.some((reason: string) => /high-risk material claim/i.test(reason)));
		await api.emit("session_shutdown", {}, ctx);
	});

	it("upgrades assurance for a new high-risk claim and invalidates stale approval after mutation", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Maintain a risk-sensitive claim", criteria: ["The material conclusion is supported"],
			taskKind: "research", executionPreference: "direct", roleCatalogAvailable: false,
			assurance: { risk: "low" },
		}, ctx);
		await execute(api, "update_goal", {
			action: "upsert_claim",
			claim: { id: "claim-risk", text: "Initial high-risk conclusion", materiality: "material", risk: "high" },
		}, ctx);
		assert.equal((await publicGoal(api, ctx)).assurance.reviewRequirement, "required");

		const reviewerFile = path.join(cwd, "risk-reviewer.jsonl");
		fs.writeFileSync(reviewerFile, [
			JSON.stringify({ type: "session", id: "risk-review", parentSession: path.join(cwd, "main.jsonl") }),
			JSON.stringify({ type: "custom", customType: "pi-roles:spawn-provenance", data: {
				schemaVersion: 1, agentId: "sub_300_0", role: "reviewer", sessionId: "risk-review",
				parentSession: path.join(cwd, "main.jsonl"),
				} }),
				JSON.stringify({ message: { role: "assistant", content: [{
					type: "toolCall", id: "risk-report", name: "report_role_result", arguments: { findings: ["✅ Ready"], artifacts: [] },
				}] } }),
				JSON.stringify({ message: {
					role: "toolResult", toolCallId: "risk-report", toolName: "report_role_result", isError: false,
					content: [{ type: "text", text: "[pi-roles] report accepted. You may now stop." }],
				} }),
		].join("\n"));
		assert.equal((await execute(api, "update_goal", {
			action: "record_review",
			review: {
				status: "passed", reason: "Reviewed", sessionFile: reviewerFile,
				evaluator: { kind: "reviewer", agentId: "sub_300_0", sessionId: "risk-review" },
				findings: [], advisories: [],
			},
		}, ctx)).isError, undefined);
		assert.equal((await publicGoal(api, ctx)).assurance.reviewStatus, "passed");

		await execute(api, "update_goal", {
			action: "upsert_claim",
			claim: { id: "claim-risk", text: "Changed high-risk conclusion", materiality: "material", risk: "high" },
		}, ctx);
		assert.equal((await publicGoal(api, ctx)).assurance.reviewStatus, "pending");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("accepts a requested goal through the production V2 evaluator path", async () => {
		const cwd = project("v2");
		const fakeComplete = async (_model: unknown, request: any) => {
			const prompt = request.messages[0].content[0].text as string;
			const packet = JSON.parse(prompt.slice(prompt.indexOf("{")));
			const verdict = {
				schemaVersion: "goal_completion_policy_v2",
				outcome: "accept",
				requirements: packet.criteria.map((criterion: any) => ({
					id: criterion.id,
					status: "satisfied",
					evidenceRefs: criterion.evidenceRefs,
					reason: "The attached artifact verifies the outcome.",
				})),
				claims: [], blockingFailures: [], advisories: [],
			};
			return { role: "assistant", content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { output: 1 } } as any;
		};
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ complete: fakeComplete as any })(api as any);
		const ctx = context(cwd, api, { id: "fake-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Complete through V2", criteria: ["Verified artifact exists"], taskKind: "coding",
			constraints: ["Do not publish the artifact externally"],
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		await Promise.resolve();
		const criterionId = (await publicGoal(api, ctx)).criteria[0].id;
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 10 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId,
			evidence: { id: "artifact", kind: "artifact", summary: "Artifact inspected", locator: "dist/result", verification: "verified" },
		}, ctx);
		await execute(api, "update_goal", { action: "request_completion", summary: "Artifact is verified." }, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "The artifact is ready." }], usage: { output: 20 } },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);
		const completed = await publicGoal(api, ctx);
		assert.equal(completed.status, "complete");
		assert.equal(completed.completion.lastEvaluation.decision, "accept");
		assert.equal(completed.progress.assurance.evaluationFresh, true);
		assert.equal(completed.progress.outcomes.counts.verified, 2, "criterion and explicit constraint are both verified outcomes");
		assert.equal(completed.progress.outcomes.blocking.open, 0);
		assert.ok(completed.completion.lastEvaluation.criterionCoverage.some((item: any) => item.criterionId === "$constraint:0"));
		assert.equal(completed.completion.rejectionCount, 0);
		const completionEvent = api.sent.find(({ message }) => message?.details?.kind === "complete")?.message;
		assert.equal(completionEvent?.details?.progress?.status, "complete", "historical terminal cards carry a frozen progress snapshot");
		const terminalMutation = await execute(api, "update_goal", {
			action: "record_evidence",
			evidence: { id: "late", kind: "observation", summary: "Late mutation" },
			criterionId,
		}, ctx);
		assert.equal(terminalMutation.isError, true);
		assert.match(terminalMutation.content[0].text, /terminal/i);
		const frozenWall = completed.usage.wallMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal((await publicGoal(api, ctx)).usage.wallMs, frozenWall);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("defers drafting when the model flags genuine ambiguity", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const result = await execute(api, "propose_goal_draft", {
			objective: "优化定价", criteria: ["定价策略确定"], taskKind: "pm",
			executionPreference: "auto", roleCatalogAvailable: false,
			needsClarification: true,
			openQuestions: ["目标用户是个人还是企业？", "是否允许破坏性调价？"],
		}, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.needsClarification, true);
		assert.deepEqual(result.details.openQuestions, ["目标用户是个人还是企业？", "是否允许破坏性调价？"]);
		// 未创建 goal，等待澄清后再 draft。
		const check = await execute(api, "get_goal", {}, ctx);
		assert.match(check.content[0].text, /no goal|No goal/i);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("passes through all clarification questions without a count limit", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const questions = [
			"问题 1：目标市场？", "问题 2：预算约束？", "问题 3：时间窗口？",
			"问题 4：合规要求？", "问题 5：团队规模？",
		];
		const result = await execute(api, "propose_goal_draft", {
			objective: "制定定价策略", criteria: ["策略确定"], taskKind: "pm",
			executionPreference: "auto", roleCatalogAvailable: false,
			needsClarification: true, openQuestions: questions,
		}, ctx);
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details.openQuestions, questions, "all questions are passed through, none truncated");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("writes the goal spec markdown when a goal starts", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		const result = await execute(api, "propose_goal_draft", {
			objective: "实现 slugify 函数并通过测试", criteria: ["npm test 全部通过"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false,
			constraints: ["不新增依赖"],
		}, ctx);
		assert.equal(result.isError, undefined);
		const specPath = result.details?.specDoc;
		assert.ok(specPath, "draft response reports the written spec path");
		const absolute = path.join(cwd, specPath);
		assert.equal(fs.existsSync(absolute), true, "spec md exists on disk");
		const text = fs.readFileSync(absolute, "utf8");
		assert.match(text, /## 目标/);
		assert.match(text, /## 验收标准/);
		assert.match(text, /- \[ \] `blocking` npm test 全部通过/);
		assert.match(text, /- 不新增依赖/);
		assert.match(text, /## 机器字段/);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("judges a pending request even when the turn ended without assistant text", async () => {
		// UX finding: the agent's last turn was a pure tool call, lastAssistantText
		// stayed empty, and neither the judge nor scheduleContinuation ever ran.
		const cwd = project("v2");
		const fakeComplete = async (_model: unknown, request: any) => {
			const prompt = request.messages[0].content[0].text as string;
			const packet = JSON.parse(prompt.slice(prompt.indexOf("{")));
			return { role: "assistant", content: [{ type: "text", text: JSON.stringify({
				schemaVersion: "goal_completion_policy_v2", outcome: "accept",
				requirements: packet.criteria.map((criterion: any) => ({ id: criterion.id, status: "satisfied", evidenceRefs: criterion.evidenceRefs, reason: "ok" })),
				claims: [], blockingFailures: [], advisories: [],
			}) }], usage: { output: 1 } } as any;
		};
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ complete: fakeComplete as any, minContinueIntervalMs: 0 })(api as any);
		const ctx = context(cwd, api, { id: "fake-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Finish with a tool-only turn", criteria: ["Verified artifact exists"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		await Promise.resolve();
		const criterionId = (await publicGoal(api, ctx)).criteria[0].id;
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 10 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId,
			evidence: { id: "artifact", kind: "artifact", summary: "Artifact inspected", locator: "dist/result", verification: "verified" },
		}, ctx);
		await execute(api, "update_goal", { action: "request_completion", summary: "Artifact is verified." }, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [] },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);
		const completed = await publicGoal(api, ctx);
		assert.equal(completed.status, "complete", "pending request is judged despite an empty assistant text");
		assert.equal(completed.completion.lastEvaluation.decision, "accept");
		await api.emit("session_shutdown", {}, ctx);
	});

	it("evaluates a pending completion at the budget gate before closing as budget_limited", async () => {
		// UX finding: reviewer accepted + request_completion pending, then the
		// budget gate fired before the authoritative judge ran — finished work
		// was stranded at budget_limited. A pending V2 request must be judged
		// once before the goal is closed.
		const cwd = project("v2");
		const fakeComplete = async (_model: unknown, request: any) => {
			const prompt = request.messages[0].content[0].text as string;
			const packet = JSON.parse(prompt.slice(prompt.indexOf("{")));
			return { role: "assistant", content: [{ type: "text", text: JSON.stringify({
				schemaVersion: "goal_completion_policy_v2", outcome: "accept",
				requirements: packet.criteria.map((criterion: any) => ({ id: criterion.id, status: "satisfied", evidenceRefs: criterion.evidenceRefs, reason: "ok" })),
				claims: [], blockingFailures: [], advisories: [],
			}) }], usage: { output: 1 } } as any;
		};
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ complete: fakeComplete as any })(api as any);
		const ctx = context(cwd, api, { id: "fake-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Finish before the budget gate", criteria: ["Verified artifact exists"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
			tokenBudget: 50,
		}, ctx);
		await Promise.resolve();
		const criterionId = (await publicGoal(api, ctx)).criteria[0].id;
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 10 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId,
			evidence: { id: "artifact", kind: "artifact", summary: "Artifact inspected", locator: "dist/result", verification: "verified" },
		}, ctx);
		await execute(api, "update_goal", { action: "request_completion", summary: "Artifact is verified." }, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "The artifact is ready." }], usage: { output: 10000 } },
			toolResults: [{ ok: true }],
		}, ctx);
		const completed = await publicGoal(api, ctx);
		assert.equal(completed.status, "complete", "pending request is judged at the budget gate instead of being stranded");
		assert.equal(completed.completion.lastEvaluation.decision, "accept");
		const completionEvent = api.sent.find(({ message }) => message?.details?.kind === "complete")?.message;
		assert.ok(completionEvent, "emits the complete event at the budget gate");
		assert.match(completionEvent.content, /budget limit/);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("keeps V2 non-authoritative in shadow mode while persisting its audit", async () => {
		const cwd = project("shadow");
		const fakeComplete = async (_model: unknown, request: any) => {
			if (String(request.systemPrompt).includes("Goal V2")) {
				const prompt = request.messages[0].content[0].text as string;
				const packet = JSON.parse(prompt.slice(prompt.indexOf("{")));
				return { role: "assistant", content: [{ type: "text", text: JSON.stringify({
					schemaVersion: "goal_completion_policy_v2", outcome: "continue",
					requirements: packet.criteria.map((criterion: any) => ({ id: criterion.id, status: "unsatisfied", evidenceRefs: [], reason: "Shadow evaluator disagrees." })),
					claims: [], blockingFailures: [], advisories: [],
				}) }], usage: { output: 1 } } as any;
			}
			return { role: "assistant", content: [{ type: "text", text: '{"done":true,"reason":"legacy accepted"}' }], usage: { output: 1 } } as any;
		};
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ complete: fakeComplete as any })(api as any);
		const ctx = context(cwd, api, { id: "dual-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Shadow ownership", criteria: ["Artifact exists"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		await Promise.resolve();
		const criterionId = (await publicGoal(api, ctx)).criteria[0].id;
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 5 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId,
			evidence: { id: "shadow-artifact", kind: "artifact", summary: "Artifact exists", locator: "result", verification: "verified" },
		}, ctx);
		await execute(api, "update_goal", { action: "request_completion", summary: "Ready" }, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Ready." }], usage: { output: 10 } },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);
		const completed = await publicGoal(api, ctx);
		assert.equal(completed.status, "complete", "legacy remains authoritative during shadow canary");
		assert.equal(completed.completion.lastEvaluation.decision, "revise");
		assert.ok(completed.completion.lastEvaluation.advisories.some((item: string) => item.startsWith("completionPolicy=shadow:")));
		assert.equal(completed.progress.assurance.evaluationFresh, true, "legacy acceptance does not stale the same shadow audit");
		assert.ok(!completed.progress.health.issues.some((item: any) => item.code === "reevaluation_needed"));
		assert.equal(completed.completion.rejectionCount, 0);
		assert.deepEqual(completed.completion.rejectionHistory, []);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("persists a synthetic accepted audit when the legacy policy completes a V2 goal", async () => {
		const cwd = project("legacy");
		const api = new FakeExtensionAPI();
		createPiGoalExtension({
			complete: (async () => ({
				role: "assistant",
				content: [{ type: "text", text: '{"done":true,"reason":"legacy accepted"}' }],
				usage: { output: 1 },
			})) as any,
		})(api as any);
		const ctx = context(cwd, api, { id: "legacy-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Complete through compatibility policy", criteria: ["Artifact exists"], taskKind: "coding",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		const criterionId = (await publicGoal(api, ctx)).criteria[0].id;
		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 5 }, ctx);
		await execute(api, "update_goal", {
			action: "record_evidence", criterionId,
			evidence: { id: "legacy-artifact", kind: "artifact", summary: "Artifact exists", locator: "result" },
		}, ctx);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Ready." }], usage: { output: 10 } },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);
		const completed = await publicGoal(api, ctx);
		assert.equal(completed.status, "complete");
		assert.equal(completed.completion.lastEvaluation.decision, "accept");
		assert.equal(completed.completion.lastEvaluation.fingerprint, null);
		assert.ok(completed.completion.lastEvaluation.advisories.some((item: string) => /completionPolicy=legacy/.test(item)));
		await api.emit("session_shutdown", {}, ctx);
	});

	it("redraws live elapsed time every second and stops the ticker when execution pauses", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		const clock = new FakeTickerClock(Date.now());
		createPiGoalExtension({ now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval })(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Exercise live timer", criteria: ["Timer observed"], taskKind: "general",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		await Promise.resolve();
		ctx.hasUI = true;
		await api.emit("turn_start", { turnIndex: 0, timestamp: clock.now() }, ctx);
		const beforeTick = ctx.statusUpdates.length;
		const snapshotsBeforeTick = api.branch.length;
		clock.advance(1_100);
		assert.ok(ctx.statusUpdates.length > beforeTick);
		assert.match(ctx.statusUpdates.at(-1) ?? "", /0 tok.*active 1s.*wall 1s/);
		assert.equal(api.branch.length, snapshotsBeforeTick, "ticker redraws must never append snapshots");

		await api.emit("after_provider_response", { status: 429, headers: {} }, ctx);
		const usageEvent = api.sent.find(({ message }) => message?.details?.kind === "usage_limited")?.message;
		assert.equal(usageEvent?.details?.progress?.status, "usage_limited");
		const eventWall = usageEvent.details.progress.resources.wallMs;
		const afterPause = ctx.statusUpdates.length;
		const wallBefore = (await publicGoal(api, ctx)).usage.wallMs;
		clock.advance(1_100);
		assert.equal(ctx.statusUpdates.length, afterPause);
		assert.equal(usageEvent.details.progress.resources.wallMs, eventWall, "historical event progress does not drift with the live wall clock");
		const wallAfter = (await publicGoal(api, ctx)).usage.wallMs;
		assert.ok(wallAfter > wallBefore, "wall time continues for a resumable pause");

		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Provider stopped the turn." }], usage: { output: 33 } },
			toolResults: [],
		}, ctx);
		const paused = await publicGoal(api, ctx);
		assert.equal(paused.status, "usage_limited");
		assert.equal(paused.usage.tokensUsed, 33);
		assert.ok(paused.usage.activeMs >= 1_000 && paused.usage.activeMs < 2_000);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("persists atomic actions, evaluates one request, and reloads the latest snapshot", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);

		const created = await execute(api, "propose_goal_draft", {
			objective: "Produce a verified result",
			criteria: [
				{ description: "Core result is verified", level: "blocking" },
				{ description: "Optional context is included", level: "advisory" },
			],
			taskKind: "general",
			executionPreference: "direct",
			routing: {
				uncertainty: "low", coupling: "high", risk: "low", specialistNeed: "none",
				independentWorkstreams: 1, heterogeneousSkills: false, effort: "small",
			},
			assurance: { risk: "low" },
			roleCatalogAvailable: false,
		}, ctx);
		assert.equal(created.isError, undefined);
		await Promise.resolve();
		const initial = await publicGoal(api, ctx);
		const [blockingId, advisoryId] = initial.criteria.map((item: any) => item.id);

		await api.emit("turn_start", { turnIndex: 0, timestamp: Date.now() - 25 }, ctx);
		const evidence = {
			id: "ev:test", kind: "tool_result", summary: "Focused verification passed",
			locator: "test:focused", origin: "tool", verification: "verified",
		};
		assert.equal((await execute(api, "update_goal", {
			action: "record_evidence", evidence, criterionId: blockingId,
		}, ctx)).isError, undefined);
		// A retry gets a fresh default timestamp but remains idempotent by semantic ID/content.
		assert.equal((await execute(api, "update_goal", {
			action: "record_evidence", evidence, criterionId: blockingId,
		}, ctx)).isError, undefined);
		assert.equal((await execute(api, "update_goal", {
			action: "record_evidence", evidenceId: "ev:test", criterionId: advisoryId,
		}, ctx)).isError, undefined);

		const reviewerFile = path.join(cwd, "reviewer.jsonl");
		fs.writeFileSync(reviewerFile, [
			JSON.stringify({ type: "session", id: "review-child", parentSession: path.join(cwd, "main.jsonl") }),
			JSON.stringify({
				type: "custom", customType: "pi-roles:spawn-provenance",
				data: {
					schemaVersion: 1, agentId: "sub_200_0", role: "reviewer",
					sessionId: "review-child", parentSession: path.join(cwd, "main.jsonl"),
				},
			}),
				JSON.stringify({
					message: { role: "assistant", content: [{
						type: "toolCall", id: "persisted-report", name: "report_role_result",
						arguments: { findings: ["✅ Ready"], artifacts: [] },
					}] },
				}),
				JSON.stringify({ message: {
					role: "toolResult", toolCallId: "persisted-report", toolName: "report_role_result", isError: false,
					content: [{ type: "text", text: "[pi-roles] report accepted. You may now stop." }],
				} }),
		].join("\n") + "\n");
		assert.equal((await execute(api, "update_goal", {
			action: "record_review",
			review: {
				status: "passed", reason: "Independent review passed.", sessionFile: reviewerFile,
				evaluator: { kind: "reviewer", agentId: "sub_200_0" },
				findings: [], advisories: [],
			},
		}, ctx)).isError, undefined);
		const afterReview = await publicGoal(api, ctx);
		assert.equal(afterReview.completion.lastEvaluation.evaluator.legacySessionFile, undefined);
		assert.match(afterReview.completion.lastEvaluation.evaluator.reportDigest, /^[a-f0-9]{64}$/);

		assert.equal((await execute(api, "update_goal", {
			action: "request_completion", summary: "Blocking result is supported by ev:test.",
		}, ctx)).isError, undefined);
		await api.emit("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Completion requested from the recorded evidence." }], usage: { output: 80 } },
			toolResults: [{ ok: true }],
		}, ctx);
		await api.emit("agent_end", {}, ctx);

		const evaluated = await publicGoal(api, ctx);
		assert.equal(evaluated.status, "active");
		assert.equal(evaluated.evidenceLedger.length, 1);
		assert.deepEqual(evaluated.criteria.map((item: any) => item.evidenceRefs), [["ev:test"], ["ev:test"]]);
		assert.equal(evaluated.completion.lastEvaluation.evaluator.kind, "judge");
		assert.equal(evaluated.completion.lastEvaluation.decision, "revise");
		assert.equal(evaluated.completion.rejectionCount, 1);
		assert.equal(evaluated.usage.tokensUsed, 80);

		await api.emit("session_shutdown", {}, ctx);
		const restoredApi = new FakeExtensionAPI([...api.branch]);
		piGoalExtension(restoredApi as any);
		const restoredCtx = context(cwd, restoredApi);
		await restoredApi.emit("session_start", {}, restoredCtx);
		const restored = await publicGoal(restoredApi, restoredCtx);
		assert.equal(restored.status, "paused");
		assert.equal(restored.completion.rejectionCount, 1);
		assert.equal(restored.evidenceLedger.length, 1);
		await restoredApi.emit("session_shutdown", {}, restoredCtx);
	});

	it("pauses instead of collecting more filler after the third identical research rejection", async () => {
		const cwd = project("v2");
		const rejectingComplete = async (_model: unknown, request: any) => {
			const prompt = request.messages[0].content[0].text as string;
			const packet = JSON.parse(prompt.slice(prompt.indexOf("{")));
			return {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify({
					schemaVersion: "goal_completion_policy_v2", outcome: "continue",
					requirements: packet.criteria.map((criterion: any) => ({ id: criterion.id, status: "unsatisfied", evidenceRefs: [], reason: "Core claim remains unsupported." })),
					claims: [], blockingFailures: [], advisories: ["Do not add unrelated URLs."],
				}) }],
				usage: { output: 1 },
			} as any;
		};
		const api = new FakeExtensionAPI();
		createPiGoalExtension({ complete: rejectingComplete as any, minContinueIntervalMs: 0 })(api as any);
		const ctx = context(cwd, api, { id: "rejecting-evaluator" });
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Research one material conclusion", criteria: ["Material conclusion is supported"],
			taskKind: "research", executionPreference: "direct", roleCatalogAvailable: false,
			assurance: { risk: "low" },
		}, ctx);
		await Promise.resolve();

		for (let attempt = 1; attempt <= 3; attempt++) {
			await api.emit("turn_start", { turnIndex: attempt, timestamp: Date.now() - 5 }, ctx);
			await execute(api, "update_goal", { action: "request_completion", summary: "Attempt " + attempt }, ctx);
			await api.emit("turn_end", {
				message: { role: "assistant", content: [{ type: "text", text: "Requesting completion without filler sources." }], usage: { output: 30 } },
				toolResults: [{ ok: true }],
			}, ctx);
			await api.emit("agent_end", {}, ctx);
			if (attempt === 1) {
				const continuation = api.sent.find(({ message }) => message?.customType === GOAL_CONTINUATION_TYPE)?.message;
				assert.ok(continuation, "a continuation is scheduled after the first rejection");
				assert.match(continuation.content, /request_completion/, "feedback tells the agent to resubmit a fresh completion request");
			}
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const paused = await publicGoal(api, ctx);
		assert.equal(paused.status, "paused");
		assert.equal(paused.completion.rejectionCount, 3);
		assert.equal(paused.completion.rejectionHistory.length, 3);
		assert.match(paused.pausedReason ?? "", /repeated three times/);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("rejects a reviewer identity that has no readable spawned-session transcript", async () => {
		const cwd = project("v2");
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Review provenance", criteria: ["A result exists"], taskKind: "review",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "low" },
		}, ctx);
		const result = await execute(api, "update_goal", {
			action: "record_review",
			review: {
				status: "passed", reason: "claimed", sessionFile: path.join(cwd, "missing.jsonl"),
				evaluator: { kind: "reviewer", agentId: "invented", sessionId: "invented" },
			},
		}, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /unreadable/i);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("rejects a readable child transcript spawned under a non-reviewer role", async () => {
		const cwd = project("v2");
		const reviewerFile = path.join(cwd, "forged-role.jsonl");
		fs.writeFileSync(reviewerFile, [
			JSON.stringify({ type: "session", id: "wrong-role", parentSession: path.join(cwd, "main.jsonl") }),
			JSON.stringify({ type: "custom", customType: "pi-roles:spawn-provenance", data: {
				schemaVersion: 1, agentId: "sub_400_0", role: "researcher", sessionId: "wrong-role",
				parentSession: path.join(cwd, "main.jsonl"),
				} }),
				JSON.stringify({ message: { role: "assistant", content: [{
					type: "toolCall", id: "wrong-role-report", name: "report_role_result", arguments: { findings: ["✅ Ready"], artifacts: [] },
				}] } }),
				JSON.stringify({ message: {
					role: "toolResult", toolCallId: "wrong-role-report", toolName: "report_role_result", isError: false,
					content: [{ type: "text", text: "[pi-roles] report accepted. You may now stop." }],
				} }),
		].join("\n"));
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Verify reviewer role provenance", criteria: ["A reviewed result exists"], taskKind: "review",
			executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "high" },
		}, ctx);
		const result = await execute(api, "update_goal", {
			action: "record_review",
			review: {
				status: "passed", reason: "Claimed reviewer approval", sessionFile: reviewerFile,
				evaluator: { kind: "reviewer", agentId: "sub_400_0", sessionId: "wrong-role" },
				findings: [], advisories: [],
			},
		}, ctx);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not reviewer/i);
		await api.emit("session_shutdown", {}, ctx);
	});

	it("accepts constraint-bound findings only from a spawned reviewer and pauses on the third equivalent rejection", async () => {
		const cwd = project("v2");
		const reviewerFile = path.join(cwd, "reviewer.jsonl");
		fs.writeFileSync(reviewerFile, [
			JSON.stringify({ type: "session", id: "child-session", parentSession: path.join(cwd, "main.jsonl") }),
			JSON.stringify({
				type: "custom", customType: "pi-roles:spawn-provenance",
				data: {
					schemaVersion: 1, agentId: "sub_100_0", role: "reviewer",
					sessionId: "child-session", parentSession: path.join(cwd, "main.jsonl"),
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
						content: [{ type: "toolCall", id: "constraint-report", name: "report_role_result", arguments: {
						findings: [
							"❌ Not ready",
							"code=blocking_requirement_unsatisfied subjectId=$constraint:0 missingEvidenceKind=observation: constraint evidence is missing",
						],
						artifacts: [],
					} }],
					},
				}),
				JSON.stringify({ message: {
					role: "toolResult", toolCallId: "constraint-report", toolName: "report_role_result", isError: false,
					content: [{ type: "text", text: "[pi-roles] report accepted. You may now stop." }],
				} }),
		].join("\n"));
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", {
			objective: "Review a constrained result", criteria: ["A result exists"], constraints: ["Do not publish"],
			taskKind: "review", executionPreference: "direct", roleCatalogAvailable: false, assurance: { risk: "high" },
		}, ctx);

		for (let attempt = 1; attempt <= 3; attempt++) {
			const result = await execute(api, "update_goal", {
				action: "record_review",
				review: {
					status: "failed",
					reason: "Constraint is not verified",
					sessionFile: reviewerFile,
					evaluator: { kind: "reviewer", agentId: "sub_100_0", sessionId: "child-session" },
					findings: [{
						code: "blocking_requirement_unsatisfied",
						subjectId: "$constraint:0",
						reason: "No evidence proves the no-publish constraint.",
						missingEvidenceKind: "observation",
					}],
				},
			}, ctx);
			assert.equal(result.isError, undefined);
			assert.match(result.content[0].text, attempt === 1 ? /feedback/ : attempt === 2 ? /replan/ : /pause/);
		}
		const paused = await publicGoal(api, ctx);
		assert.equal(paused.status, "paused");
		assert.equal(paused.completion.rejectionCount, 3);
		assert.equal(paused.completion.lastEvaluation.findings[0].subjectId, "$constraint:0");
		await api.emit("session_shutdown", {}, ctx);
	});
});
