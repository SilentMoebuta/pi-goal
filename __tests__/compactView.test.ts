import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piGoalExtension from "../extensions/index";
import { compactGoalProgress, deriveGoalProgress } from "../extensions/progress-model";
import { createGoalStateV2 } from "../extensions/state";

// ═══════════════════════════════════════════════════════════════════════
// UX-P2-02：get_goal(mode=compact) 真正精简投影。
//
// compact 不返回完整 outcomes.items[*].evidenceRefs 与长 label；保留
// counts/blocking/activity/assurance/health/resources 摘要；full/delta
// 仍可回查明细；大目标 fixture 下 compact 序列化体积显著小于 full。
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
	appendEntry() {}
	sendMessage() {}
	sendUserMessage() {}
}

const cleanupPaths: string[] = [];
afterEach(() => {
	for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function project() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-compact-"));
	cleanupPaths.push(cwd);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "goal.json"), JSON.stringify({
		schemaVersion: 2, superpowersIntegration: false, completionPolicy: "v2", reviewPolicy: "risk_based",
	}));
	return cwd;
}

function context(cwd: string, api: FakeExtensionAPI) {
	return {
		cwd,
		hasUI: false,
		model: { id: "compact-view" },
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }) },
		sessionManager: { getBranch: () => api.branch, getHeader: () => ({}), getSessionFile: () => path.join(cwd, "main.jsonl") },
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

function longGoalInput() {
	return {
		objective: "Upgrade the shared goal runtime so that interactive and headless entries share state, events, evidence, evaluation, permissions and recovery semantics, while keeping project-specific rules injectable through profiles, skills, MCP, hooks or project policy. ".repeat(3),
		criteria: Array.from({ length: 8 }, (_v, i) => ({
			description: `Acceptance criterion ${i + 1}: verify that the system produces a deterministic, reviewable outcome for scenario ${i + 1}, including a traceable evidence chain and an independently verifiable artifact digest without regressing prior fixtures.`,
			level: i % 3 === 0 ? "blocking" : "advisory",
		})),
		constraints: Array.from({ length: 5 }, (_v, i) => `Constraint ${i + 1}: do not modify anything outside the dedicated worktree; keep all changes reviewable, idempotent and traceable through the shared event envelope.`),
		taskKind: "research",
		executionPreference: "direct",
		roleCatalogAvailable: false,
		assurance: { risk: "low" },
	};
}

describe("compactGoalProgress projection (UX-P2-02)", () => {
	it("drops label and evidenceRefs while keeping counts/blocking and an evidenceRefCount", () => {
		const state = createGoalStateV2({
			id: "g-compact",
			objective: "Compact projection test",
			criteria: [
				{ id: "c1", description: "A very long criterion description that would dominate the compact view if retained verbatim with full evidence references attached", level: "blocking" },
				{ id: "c2", description: "Second criterion", level: "advisory" },
			],
			constraints: ["Only modify outputs/"],
			taskKind: "general",
			execution: { preference: "direct", selected: "direct", source: "user", confidence: 1, reasons: [], reassessOn: [] },
			assurance: { reviewRequirement: "none", reviewStatus: "not_required", independent: false, depth: "light", source: "user", reasons: [], decidedAt: 1 },
			now: 1,
		});
		state.evidenceLedger.push({ id: "e1", kind: "artifact", summary: "Artifact", origin: "tool", recordedAt: 2, verification: "verified" });
		state.criteria[0].evidenceRefs.push("e1");
		const progress = deriveGoalProgress(state, null, { now: 10 });
		const compact = compactGoalProgress(progress);

		assert.equal(compact.outcomes.counts.total, 3);
		assert.equal(compact.outcomes.blocking.total, 2);
		for (const item of compact.outcomes.items) {
			assert.equal("evidenceRefs" in item, false, "compact items must not carry evidenceRefs");
			assert.equal("label" in item, false, "compact items must not carry long labels");
			assert.ok(typeof item.evidenceRefCount === "number", "compact items must carry evidenceRefCount");
		}
		assert.equal(compact.outcomes.items.find((item) => item.id === "c1")?.evidenceRefCount, 1);
		assert.equal(compact.outcomes.items.find((item) => item.id === "$constraint:0")?.status, "pending");
		// 摘要字段保留。
		assert.ok(compact.health && compact.resources && compact.assurance && compact.activity && compact.evidence);
	});

	it("keeps full and delta projections intact for detailed lookup", () => {
		const state = createGoalStateV2({
			id: "g-full", objective: "Full lookup", criteria: [{ id: "c1", description: "Criterion", level: "blocking" }],
			constraints: [], taskKind: "general",
			execution: { preference: "direct", selected: "direct", source: "user", confidence: 1, reasons: [], reassessOn: [] },
			assurance: { reviewRequirement: "none", reviewStatus: "not_required", independent: false, depth: "light", source: "user", reasons: [], decidedAt: 1 },
			now: 1,
		});
		state.evidenceLedger.push({ id: "e1", kind: "artifact", summary: "Artifact", origin: "tool", recordedAt: 2, verification: "verified" });
		state.criteria[0].evidenceRefs.push("e1");
		const progress = deriveGoalProgress(state, null, { now: 10 });
		assert.equal(progress.outcomes.items[0].evidenceRefs.length, 1, "full projection keeps evidenceRefs");
		assert.ok(progress.outcomes.items[0].label.length > 0, "full projection keeps labels");
	});
});

describe("get_goal(mode=compact) end-to-end size gate (UX-P2-02)", () => {
	it("serializes far smaller than full for a large goal and exposes no item evidenceRefs", async () => {
		const cwd = project();
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const ctx = context(cwd, api);
		await api.emit("session_start", {}, ctx);
		await execute(api, "propose_goal_draft", longGoalInput(), ctx);

		const fullResult = await execute(api, "get_goal", { mode: "full" }, ctx);
		const full = JSON.parse(fullResult.content[0].text);
		const compactResult = await execute(api, "get_goal", { mode: "compact" }, ctx);
		const compact = JSON.parse(compactResult.content[0].text);

		assert.equal(compact.view, "compact");
		assert.equal(full.progress.outcomes.items.length, 13, "full keeps all 13 outcome items");
		assert.equal(compact.progress.outcomes.items.length, 13, "compact keeps the same item set for decision-making");
		for (const item of compact.progress.outcomes.items) {
			assert.equal("evidenceRefs" in item, false, "compact items must not expose evidenceRefs");
			assert.ok("evidenceRefCount" in item, "compact items must expose evidenceRefCount");
			assert.equal("label" in item, false, "compact items must not expose long labels");
		}
		assert.deepEqual(compact.progress.outcomes.counts, full.progress.outcomes.counts, "counts must match");
		assert.deepEqual(compact.progress.outcomes.blocking, full.progress.outcomes.blocking, "blocking must match");

		const fullBytes = Buffer.byteLength(fullResult.content[0].text);
		const compactBytes = Buffer.byteLength(compactResult.content[0].text);
		assert.ok(compactBytes < fullBytes * 0.6,
			`compact (${compactBytes}B) must be well below full (${fullBytes}B)`);

		// delta 仍提供完整明细。
		const deltaResult = await execute(api, "get_goal", { mode: "delta", sinceEventSeq: 0 }, ctx);
		const delta = JSON.parse(deltaResult.content[0].text);
		assert.ok(delta.progress.outcomes.items[0].label, "delta keeps full item labels");
		await api.emit("session_shutdown", {}, ctx);
	});
});
