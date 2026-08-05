import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractReviewerFindings } from "../extensions/config";

// G3 (CLM 二次 live 测试复盘 / 教训6): verdict 来源真实性残留.
// 深修 D 第2条验 reviewerVerdict 结构合规, 第3条重跑 quality-gates 验报告内容真伪, 但两者都不验
// "verdict 真来自一个 spawn 的 reviewer session" — main agent 可编造 verdict 塞进 update_goal.
// Fix: update_goal 加 reviewerAgentId + reviewerSessionFile; handler 读 sessionFile(.jsonl, sub-session
// 独有文件, pi-core 写、main agent 不可伪造), 提取 report_role_result 的 findings, 验非空.
// 这是跨 ext 唯一可行的独立验证路径 (pi-goal 无法读 pi-roles 内存态 ReportState).

function jsonlLine(content: any, role = "assistant"): string {
	return JSON.stringify({ type: "message", message: { role, content } });
}

const sessionHeader = JSON.stringify({ type: "session", id: "session-child", parentSession: "/tmp/parent.jsonl" });

describe("extractReviewerFindings — G3 从 session jsonl 提取 reviewer 真实 findings", () => {
	it("extracts findings from a jsonl line containing a report_role_result toolCall", () => {
		const line = jsonlLine([{ type: "toolCall", name: "report_role_result", arguments: { findings: ["APPROVED"], artifacts: [] } }]);
		const r = extractReviewerFindings(line);
		assert.equal(r.found, true);
		assert.deepEqual(r.findings, ["APPROVED"]);
	});

	it("handles findings as a string (some reviewers report prose findings)", () => {
		const line = jsonlLine([{ type: "toolCall", name: "report_role_result", arguments: { findings: "G4 审查结论: APPROVED" } }]);
		const r = extractReviewerFindings(line);
		assert.equal(r.found, true);
		assert.equal(r.findings, "G4 审查结论: APPROVED");
	});

	it("found=false when jsonl has no report_role_result toolCall (no reviewer reported)", () => {
		const line = jsonlLine([{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }]);
		const r = extractReviewerFindings(line);
		assert.equal(r.found, false);
	});

	it("found=true but findings empty when reviewer reported empty findings (handler must reject)", () => {
		const line = jsonlLine([{ type: "toolCall", name: "report_role_result", arguments: { findings: [], artifacts: [] } }]);
		const r = extractReviewerFindings(line);
		assert.equal(r.found, true);
		assert.deepEqual(r.findings, []);
	});

	it("found=false on empty / malformed jsonl (cannot verify → reject, not trust)", () => {
		assert.equal(extractReviewerFindings("").found, false);
		assert.equal(extractReviewerFindings("not json at all").found, false);
		assert.equal(extractReviewerFindings('{"type":"message","message":{"role":"assistant","content":"oops"}}').found, false);
	});

	it("extracts from multi-line jsonl (real sub-session has many lines, only one report_role_result)", () => {
		const lines = [
			sessionHeader,
			jsonlLine([{ type: "text", text: "reviewing..." }]),
			jsonlLine([{ type: "toolCall", name: "read", arguments: { path: "x" } }], "assistant"),
			jsonlLine([{ type: "text", text: "result" }], "toolResult"),
			jsonlLine([{ type: "toolCall", name: "report_role_result", arguments: { findings: ["real-approval"] } }]),
		].join("\n");
		const r = extractReviewerFindings(lines);
		assert.equal(r.found, true);
		assert.deepEqual(r.findings, ["real-approval"]);
		assert.equal(r.spawnedSession, true);
		assert.equal(r.parentSession, "/tmp/parent.jsonl");
	});

	it("does not treat a report-only jsonl file as a spawned reviewer session", () => {
		const r = extractReviewerFindings(jsonlLine([
			{ type: "toolCall", name: "report_role_result", arguments: { findings: ["fabricated"] } },
		]));
		assert.equal(r.found, true);
		assert.equal(r.spawnedSession, false);
	});

	it("binds a provenance-bearing transcript to the accepted report retry", () => {
		const lines = [
			sessionHeader,
			JSON.stringify({ type: "custom", customType: "pi-roles:spawn-provenance", data: {
				schemaVersion: 1, agentId: "sub_1_0", role: "reviewer", sessionId: "session-child",
				parentSession: "/tmp/parent.jsonl",
			} }),
			jsonlLine([{ type: "toolCall", id: "bad", name: "report_role_result", arguments: { findings: ["✅ Ready but malformed"] } }]),
			JSON.stringify({ type: "message", message: {
				role: "toolResult", toolCallId: "bad", toolName: "report_role_result", isError: false,
				details: { errorType: "schema_mismatch" }, content: [{ type: "text", text: "schema mismatch" }],
			} }),
			jsonlLine([{ type: "toolCall", id: "good", name: "report_role_result", arguments: { findings: ["❌ Not ready", "subjectId=c1 missingEvidenceKind=source"] } }]),
			JSON.stringify({ type: "message", message: {
				role: "toolResult", toolCallId: "good", toolName: "report_role_result", isError: false,
				content: [{ type: "text", text: "[pi-roles] report accepted. You may now stop." }],
			} }),
		].join("\n");
		const r = extractReviewerFindings(lines);
		assert.equal(r.found, true);
		assert.deepEqual(r.findings, ["❌ Not ready", "subjectId=c1 missingEvidenceKind=source"]);
	});

	it("fails closed when a provenance-bearing report has no accepted tool result", () => {
		const lines = [
			sessionHeader,
			JSON.stringify({ type: "custom", customType: "pi-roles:spawn-provenance", data: {
				schemaVersion: 1, agentId: "sub_1_0", role: "reviewer", sessionId: "session-child",
				parentSession: "/tmp/parent.jsonl",
			} }),
			jsonlLine([{ type: "toolCall", id: "bad", name: "report_role_result", arguments: { findings: ["✅ Ready"] } }]),
			JSON.stringify({ type: "message", message: {
				role: "toolResult", toolCallId: "bad", toolName: "report_role_result", isError: false,
				details: { errorType: "schema_mismatch" }, content: [{ type: "text", text: "schema mismatch" }],
			} }),
		].join("\n");
		assert.equal(extractReviewerFindings(lines).found, false);
	});
});

import { verifyReviewerSource } from "../extensions/config";

describe("verifyReviewerSource — G3 决策：编造 verdict 被拒 (教训6 闭合)", () => {
	it("rejects a forged verdict with no reviewerAgentId (main agent self-constructed JSON)", () => {
		const r = verifyReviewerSource(undefined, undefined, { found: true, findings: ["fake"], spawnedSession: false });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /reviewerAgentId.*reviewerSessionFile|source authenticity/i);
	});

	it("rejects when agentId present but sessionFile missing", () => {
		const r = verifyReviewerSource("sub_1_0", undefined, { found: true, findings: ["x"], spawnedSession: true, parentSession: "parent", sessionId: "child" });
		assert.equal(r.ok, false);
	});

	it("rejects when the session jsonl has no report_role_result (no real reviewer reported)", () => {
		const r = verifyReviewerSource("sub_1_0", "/path/s.jsonl", { found: false, spawnedSession: true, parentSession: "parent", sessionId: "child" });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /did not actually report|report_role_result/i);
	});

	it("rejects a rubber-stamp reviewer whose findings are empty", () => {
		const r = verifyReviewerSource("sub_1_0", "/path/s.jsonl", { found: true, findings: [], spawnedSession: true, parentSession: "parent", sessionId: "child" });
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /empty|rubber-stamp|substantive/i);
	});

	it("accepts a real reviewer with agentId + sessionFile + non-empty findings", () => {
		const r = verifyReviewerSource("sub_1_0", "/path/s.jsonl", {
			found: true,
			findings: ["APPROVED: G4 correct"],
			spawnedSession: true,
			parentSession: "/path/parent.jsonl",
			sessionId: "child-session",
		});
		assert.equal(r.ok, true);
	});

	it("rejects a plausible agent id when the transcript is not a child session", () => {
		const r = verifyReviewerSource("sub_1_0", "/path/s.jsonl", {
			found: true,
			findings: ["APPROVED"],
			spawnedSession: false,
		});
		assert.equal(r.ok, false);
		assert.match(r.reason ?? "", /spawned child session|parentSession/i);
	});
});
