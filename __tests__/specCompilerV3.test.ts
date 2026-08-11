import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GoalSpecCompileError,
	compileGoalProjectSpecV3,
	migrateGoalSpecMarkdownV2ToV3,
	parseGoalProjectSpecV3,
} from "../extensions/spec-compiler-v3";
import { proposalToMarkdown } from "../extensions/spec-doc";

const SOURCE = {
	schemaVersion: 3,
	objective: "Produce a reusable research brief",
	criteria: [{ id: "c1", description: "The brief is evidence-backed", level: "blocking" }],
	constraints: ["Use only declared inputs"],
	taskKind: "research",
	profile: "research/default",
	inputs: [{ uri: "workspace://sources.md", description: "Approved sources" }],
	outputs: [{ uri: "workspace://brief.md", description: "Research brief" }],
	execution: { topology: "direct" },
	review: { requirement: "required", checklist: ["Trace claims to sources"] },
	verification: { command: "node verify.mjs", timeoutMs: 120000 },
	retry: { maxInfrastructureAttempts: 3, maxSchemaRepairs: 1, baseDelayMs: 250, maxDelayMs: 2000 },
};

describe("Goal Project Spec V3 compiler", () => {
	it("compiles a concise project declaration into the shared typed protocol", () => {
		const compiled = compileGoalProjectSpecV3(SOURCE);
		assert.equal(compiled.contractVersion, 3);
		assert.equal(compiled.doc.machine.contractVersion, 3);
		assert.equal(compiled.doc.machine.profile, "research/default");
		assert.deepEqual(compiled.doc.machine.blueprint?.retry, SOURCE.retry);
		assert.match(compiled.markdown, /submit_completion_bundle/);
		assert.match(compiled.markdown, /goal-reviewer/);
		const entryPrompt = compiled.doc.machine.blueprint?.entry?.prompt ?? "";
		assert.match(entryPrompt, /resultConstraints\.criterionIds exactly to \["c1"\]/);
		assert.match(entryPrompt, /resultConstraints\.artifactUris exactly to \["workspace:\/\/brief\.md"\]/);
		assert.match(entryPrompt, /Only IDs declared in criteria may be used as criterionId or criterionIds/);
		assert.match(entryPrompt, /\$constraint:n.*reviewer finding subject.*never.*criterion evidence target/i);
		assert.match(entryPrompt, /Preflight record_evidence, reviewer constraints, and the completion bundle/i);
		assert.match(entryPrompt, /Before the first deterministic verification run.*inspect.*requirements.*current artifact/i);
		assert.match(entryPrompt, /required paths, literal markers, schema fields, and invariants/i);
		assert.match(entryPrompt, /include criterionIds/);
		assert.match(entryPrompt, /artifactId must reference bundle\.artifacts\[\]\.id/);
		assert.doesNotMatch(JSON.stringify(SOURCE), /submit_completion_bundle|sessionFile|Ready\/Not ready/);
	});

	it("rejects malformed retry policy at the project-spec boundary", () => {
		const invalid = parseGoalProjectSpecV3({ ...SOURCE, retry: { maxInfrastructureAttempts: 0, baseDelayMs: 1000, maxDelayMs: 10 } });
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.ok(invalid.issues.some((entry) => entry.message.includes("blueprint.retry")));
	});

	it("rejects project instructions that restate legacy completion protocol", () => {
		const result = parseGoalProjectSpecV3({ ...SOURCE, instructions: "Call request_completion and parse reviewerSessionFile." });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === "legacy_protocol"));
		assert.throws(() => compileGoalProjectSpecV3({ ...SOURCE, criteria: [] }), GoalSpecCompileError);
	});

	it("keeps compiler and runtime task kinds aligned", () => {
		for (const taskKind of ["document", "business"]) {
			const result = parseGoalProjectSpecV3({ ...SOURCE, taskKind });
			assert.equal(result.ok, true, taskKind);
		}
		const unsupported = parseGoalProjectSpecV3({ ...SOURCE, taskKind: "legal-report" });
		assert.equal(unsupported.ok, false);
		if (!unsupported.ok) assert.ok(unsupported.issues.some((entry) => entry.path === "taskKind"));
	});

	it("migrates V2 markdown and explicitly removes duplicated legacy protocol", () => {
		const v2 = proposalToMarkdown({
			original: "old",
			objective: "Migrate an old goal",
			criteria: [{ description: "Output is verified", level: "blocking" }],
			constraints: [],
			claims: [],
			machine: {
				taskKind: "general",
				blueprint: {
					entry: { prompt: "Call record_review, then request_completion using reviewerSessionFile." },
					execution: { topology: "direct" },
					retry: { maxInfrastructureAttempts: 2, baseDelayMs: 500, maxDelayMs: 500 },
				},
			},
		});
		const migrated = migrateGoalSpecMarkdownV2ToV3(v2);
		assert.equal(migrated.spec.schemaVersion, 3);
		assert.equal(migrated.spec.instructions, undefined);
		assert.equal(migrated.warnings[0]?.code, "legacy_protocol");
		assert.deepEqual(migrated.spec.retry, { maxInfrastructureAttempts: 2, baseDelayMs: 500, maxDelayMs: 500 });
		const compiled = compileGoalProjectSpecV3(migrated.spec);
		assert.match(compiled.markdown, /submit_completion_bundle/);
		assert.doesNotMatch(compiled.markdown, /reviewerSessionFile/);
	});
});
