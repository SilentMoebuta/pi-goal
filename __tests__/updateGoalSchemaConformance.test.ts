import { describe, it } from "node:test";
import assert from "node:assert/strict";
import piGoalExtension from "../extensions/index";
import { normalizeUpdateGoalAction } from "../extensions/update-goal-action-v2";

// ═══════════════════════════════════════════════════════════════════════
// UX-P0-01：工具 schema 与 parser 的契约一致性。
//
// 对象 evidence 的 `id` 在 schema 中必须是显式必填——不能再出现
// “schema 宣称 optional、parser 却要求必填”的误导。缺 id 的输入在
// schema 层（宿主）与 normalize 层（extension）得到一致的拒绝。
// ═══════════════════════════════════════════════════════════════════════

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

class FakeExtensionAPI {
	readonly tools = new Map<string, any>();
	on() {}
	async emit() {}
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand() {}
	registerMessageRenderer() {}
	getActiveTools() { return ["read", "spawn_role", "dag_execute"]; }
	setActiveTools() {}
	appendEntry() {}
	sendMessage() {}
	sendUserMessage() {}
}

function updateGoalParameters(): { schema: any; evidenceObject: any } {
	const api = new FakeExtensionAPI();
	piGoalExtension(api as any);
	const tool = api.tools.get("update_goal");
	assert.ok(tool, "update_goal tool must be registered");
	const schema = tool.parameters;
	assert.ok(schema, "update_goal must publish a parameters schema");
	const union = schema.properties.evidence;
	assert.ok(union && union.anyOf, "evidence must be a union of string and object");
	const objectBranch = union.anyOf.find((branch: any) => branch.type === "object");
	assert.ok(objectBranch, "evidence union must contain an object branch");
	return { schema, evidenceObject: objectBranch };
}

describe("update_goal evidence schema conformance (UX-P0-01)", () => {
	it("declares evidence.id as required in the tool schema", () => {
		const { evidenceObject } = updateGoalParameters();
		const id = evidenceObject.properties.id;
		assert.ok(id, "evidence object must declare an id property");
		assert.equal(id.optional, undefined, "id must not carry the Type.Optional marker");
		assert.ok(
			Array.isArray(evidenceObject.required) && evidenceObject.required.includes("id"),
			"id must appear in the required list",
		);
		// 其余结构化核心字段（kind/summary）也必须保持必填，避免 schema 与
		// parser 在其它字段上再次分叉。
		for (const field of ["kind", "summary"]) {
			assert.ok(evidenceObject.required.includes(field), field + " must remain required");
		}
	});

	it("normalizer rejects a structured evidence without id with a stable code", () => {
		const result = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: { kind: "artifact", summary: "Built artifact" },
			criterionIds: ["c1"],
		}, { now: 1 });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "evidence_id_required");
			assert.equal(result.recovery, "provide_immutable_evidence_id");
		}
	});

	it("normalizer accepts structured evidence with id and keeps legacy strings valid", () => {
		const accepted = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: { id: "ev:typed", kind: "artifact", summary: "Built artifact", verification: "verified" },
			criterionIds: ["c1"],
		}, { now: 1 });
		assert.equal(accepted.ok, true, accepted.ok ? undefined : accepted.reason);
		const legacy = normalizeUpdateGoalAction({
			action: "record_evidence",
			evidence: "npm test passed",
			criterionId: "c1",
		}, { now: 1 });
		assert.equal(legacy.ok, true, "legacy string evidence must remain accepted");
	});
});

describe("update_goal bundle evidence schema conformance (CB-P0-01)", () => {
	function bundleEvidenceSchema() {
		const api = new FakeExtensionAPI();
		piGoalExtension(api as any);
		const tool = api.tools.get("update_goal");
		assert.ok(tool, "update_goal tool must be registered");
		const bundle = tool.parameters.properties.bundle;
		assert.ok(bundle && bundle.type === "object", "bundle must declare an object schema");
		const evidence = bundle.properties.evidence;
		assert.ok(evidence && evidence.type === "array" && evidence.items?.anyOf, "bundle evidence must be an array of a both-or-neither union");
		return evidence.items;
	}

	it("declares artifactId and digest as a required pair for artifact-linked evidence", () => {
		const items = bundleEvidenceSchema();
		const paired = items.anyOf.find((branch: any) => branch.properties?.artifactId);
		assert.ok(paired, "a branch must declare artifactId");
		assert.ok(Array.isArray(paired.required) && paired.required.includes("artifactId") && paired.required.includes("digest"), "artifactId and digest must both be required in the paired branch");
		const artifactId = paired.properties.artifactId;
		assert.equal(artifactId.optional, undefined, "artifactId must not carry the Type.Optional marker");
		const plain = items.anyOf.find((branch: any) => branch !== paired);
		assert.ok(plain, "a plain branch must exist");
		assert.equal(plain.properties.artifactId, undefined, "plain branch must not declare artifactId");
		assert.equal(plain.properties.digest, undefined, "plain branch must not declare digest");
	});
});
