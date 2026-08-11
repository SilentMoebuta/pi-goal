import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GoalTraceCollectorV3 } from "../extensions/observability-v3";

describe("run quality gate CLI", () => {
	it("turns persisted result, event, and trace evidence into a no-average regression artifact", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-quality-"));
		const collector = new GoalTraceCollectorV3("goal-1", (() => {
			let now = 10;
			return () => now++;
		})());
		collector.startSpan({ name: "goal.tool_started", attributes: { "goal.attempt_id": "goal-1:run:1:attempt:1", "tool.name": "bash" } }).end("ok");
		collector.startSpan({ name: "goal.tool_ended", attributes: { "goal.attempt_id": "goal-1:run:1:attempt:1", "tool.name": "bash" } }).end("ok");
		fs.writeFileSync(path.join(directory, "trace.jsonl"), collector.getSpans().map((span) => JSON.stringify(span)).join("\n") + "\n");
		fs.writeFileSync(path.join(directory, "events.jsonl"), JSON.stringify({
			type: "llm_response",
			payload: { usage: { cost: { total: 0.01 } } },
		}) + "\n");
		fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
			schemaVersion: 1,
			contractVersion: 3,
			status: "complete",
			lineage: {
				goalDefinitionId: "goal-1",
				revisionId: "goal-1:revision:1",
				runId: "goal-1:run:1",
				attemptId: "goal-1:run:1:attempt:1",
			},
		}));
		fs.writeFileSync(path.join(directory, "input.json"), JSON.stringify({
			schemaVersion: 1,
			fixture: {
				schemaVersion: 1,
				id: "coding:cli",
				version: "1",
				kind: "coding",
				objective: "Run one checked tool trajectory",
				input: {},
				expected: { criteria: ["output"] },
			},
			eventsPath: "events.jsonl",
			tracePath: "trace.jsonl",
			resultPath: "result.json",
			deterministicChecks: [{ id: "verify", status: "passed", summary: "verification passed" }],
			artifactChecks: ["correct"],
			humanAccepted: null,
			policy: {
				id: "automated",
				version: "1",
				requiredDimensions: ["final_output", "tool_trajectory", "artifact_correctness", "cost", "latency"],
				requiredTrajectorySpanNames: ["goal.tool_started", "goal.tool_ended"],
				maxCostUsd: 0.1,
				maxLatencyMs: 100,
			},
			evaluatedAt: 1,
		}));
		const root = path.resolve(import.meta.dirname, "..");
		const processResult = spawnSync(path.join(root, "node_modules", ".bin", "tsx"), [
			path.join(root, "scripts", "run-quality-gate-v3.ts"),
			"--input", path.join(directory, "input.json"),
			"--output", path.join(directory, "quality.json"),
		], { encoding: "utf8" });
		assert.equal(processResult.status, 0, processResult.stderr);
		const output = JSON.parse(fs.readFileSync(path.join(directory, "quality.json"), "utf8"));
		assert.equal(output.evaluation.decision, "accept");
		assert.equal(output.regression.status, "passed");
		assert.equal(output.evaluation.dimensions.length, 7);
		assert.equal(output.trajectory.sampleId, "coding:cli");
	});
});
