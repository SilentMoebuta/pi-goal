import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("published Goal Contract V3 schemas", () => {
	for (const name of ["goal-contract-v3.schema.json", "completion-bundle-v3.schema.json", "goal-project-spec-v3.schema.json", "goal-event-v3.schema.json", "runtime-checkpoint-v3.schema.json", "benchmark-fixture-v1.schema.json", "evaluation-v1.schema.json", "human-annotation-v1.schema.json", "pairwise-comparison-v1.schema.json", "trace-span-v1.schema.json", "offline-trajectory-sample-v1.schema.json", "run-quality-evaluation-v1.schema.json"]) {
		it(`${name} is a Draft 2020-12 schema with a stable id`, () => {
			const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8"));
			assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
			assert.match(schema.$id, /^https:\/\/silentmoebuta\.github\.io\/pi-goal\/schemas\//);
			assert.equal(schema.type, "object");
		});
	}

	it("the completion schema fixes Contract V3 lineage and digest algorithms", () => {
		const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "completion-bundle-v3.schema.json"), "utf8"));
		assert.equal(schema.properties.contractVersion.const, 3);
		assert.equal(schema.$defs.digest.properties.algorithm.const, "sha256");
		assert.deepEqual(schema.$defs.lineage.required, ["goalDefinitionId", "revisionId", "runId", "attemptId"]);
	});

	it("the completion schema pairs evidence artifactId with digest (CB-P0-01)", () => {
		const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "completion-bundle-v3.schema.json"), "utf8"));
		const evidence = schema.$defs.evidence ?? schema.properties.bundle.properties.evidence;
		assert.ok(evidence, "completion schema must define a bundle evidence shape");
		const anyOf = evidence.anyOf;
		assert.ok(Array.isArray(anyOf) && anyOf.length === 2, "evidence must use a both-or-neither anyOf pairing");
		const both = anyOf.find((branch: { required?: string[] }) => branch.required?.includes("artifactId"));
		assert.ok(both, "one branch must require artifactId and digest together");
		assert.ok(both.required.includes("digest"), "the paired branch must also require digest");
		const neither = anyOf.find((branch: { properties?: Record<string, unknown> }) => branch.properties);
		assert.ok(neither, "the other branch must forbid artifactId and digest");
		assert.equal(neither.properties.artifactId, false);
		assert.equal(neither.properties.digest, false);
	});

	it("the project spec publishes the bounded retry policy", () => {
		const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "goal-project-spec-v3.schema.json"), "utf8"));
		assert.equal(schema.properties.retry.additionalProperties, false);
		assert.equal(schema.properties.retry.properties.maxInfrastructureAttempts.minimum, 1);
		assert.equal(schema.properties.retry.properties.maxSchemaRepairs.minimum, 0);
	});
});
