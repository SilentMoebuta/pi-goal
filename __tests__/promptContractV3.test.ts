import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInitialRuntimeMetadataV3 } from "../extensions/goal-contract-v3";
import { continuationPrompt, goalSystemPrompt, usesAtomicCompletionV3 } from "../extensions/prompt-blocks";
import { createGoalStateV2 } from "../extensions/state";

function goal() {
	return createGoalStateV2({
		id: "g-prompt",
		objective: "Produce a verified artifact",
		criteria: [{ id: "c1", description: "Artifact is verified", level: "blocking" }],
		constraints: [],
		taskKind: "general",
		execution: { preference: "direct", selected: "direct", source: "user", confidence: 1, reasons: [], reassessOn: [] },
		assurance: { reviewRequirement: "required", reviewStatus: "pending", independent: true, depth: "deep", source: "user", reasons: [], decidedAt: 1 },
		runtime: createInitialRuntimeMetadataV3({ goalId: "g-prompt", entrypoint: "interactive" }),
		now: 1,
	});
}

function researchGoal() {
	const state = goal();
	state.taskKind = "research";
	return state;
}

function blueprintGoal(entrypoint: "interactive" | "headless") {
	const state = goal();
	state.blueprint = {
		entry: { prompt: "Use the supplied inputs only." },
		execution: { topology: "direct" },
		evidence: { criteria: [{ id: "c1", kinds: ["artifact"], verification: "verified" }] },
	};
	state.runtime = createInitialRuntimeMetadataV3({ goalId: state.id, entrypoint });
	if (entrypoint === "headless") {
		state.headless = {
			specPath: "/tmp/spec.md",
			outputPath: "/tmp/spec.result.json",
			logPath: "/tmp/spec.goal.jsonl",
			startedAt: 1,
		};
	}
	return state;
}

describe("Contract V3 interactive completion prompts", () => {
	it("uses the same typed completion action as headless by default", () => {
		const state = researchGoal();
		assert.equal(usesAtomicCompletionV3(state), true);
		for (const prompt of [goalSystemPrompt(state), continuationPrompt(state)]) {
			assert.match(prompt, /goal-reviewer/);
			assert.match(prompt, /submit_completion_bundle/);
			assert.match(prompt, /resultRef/);
			assert.match(prompt, /resultConstraints\.criterionIds exactly \["c1"\]/);
			assert.match(prompt, /deterministic check IDs are not criterion IDs/);
			assert.match(prompt, /resultConstraints\.evidenceIds/);
			assert.match(prompt, /resultConstraints\.artifactUris/);
			assert.match(prompt, /include criterionIds for every entry/);
			assert.match(prompt, /artifactId refers to bundle\.artifacts\[\]\.id/);
			assert.doesNotMatch(prompt, /findings\[0\].*Ready|reviewerSessionFile|✅ Ready|❌ Not ready/);
		}
	});

	it("keeps an already-started V2 completion request on its compatibility path", () => {
		const state = goal();
		state.completion.requestedAt = 2;
		assert.equal(usesAtomicCompletionV3(state), false);
		assert.match(goalSystemPrompt(state), /request_completion/);
	});

	it("omits reviewer operation hints when assurance does not require review", () => {
		const state = researchGoal();
		state.assurance.reviewRequirement = "none";
		const prompt = goalSystemPrompt(state);
		assert.doesNotMatch(prompt, /report_role_result|reviewerSessionFile|submit_completion_bundle/);
	});

	it("describes blueprint runs through the interactive contract without headless language", () => {
		const state = blueprintGoal("interactive");
		for (const prompt of [goalSystemPrompt(state), continuationPrompt(state)]) {
			assert.match(prompt, /<GOAL-BLUEPRINT>/);
			assert.match(prompt, /Entrypoint: interactive/);
			assert.match(prompt, /steer the run in real time/);
			assert.match(prompt, /record_deviation/);
			assert.match(prompt, /record_evidence/);
			assert.doesNotMatch(prompt, /headless/i);
		}
	});

	it("keeps unattended caller and durable log guidance for headless blueprint runs", () => {
		const state = blueprintGoal("headless");
		for (const prompt of [goalSystemPrompt(state), continuationPrompt(state)]) {
			assert.match(prompt, /<GOAL-BLUEPRINT>/);
			assert.match(prompt, /Entrypoint: headless/);
			assert.match(prompt, /runs unattended/);
			assert.match(prompt, /external caller/);
			assert.match(prompt, /goal log/);
			assert.match(prompt, /record_deviation/);
			assert.match(prompt, /record_evidence/);
		}
	});
});
