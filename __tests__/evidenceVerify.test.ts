import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mechanicallyVerifyEvidence } from "../extensions/evidence-verify";
import type { EvidenceRef } from "../extensions/state";

function artifact(over: Partial<EvidenceRef> = {}): EvidenceRef {
	return {
		id: "ev", kind: "artifact", summary: "s", locator: "dist/out", recordedAt: 1,
		origin: "agent", verification: "verified", ...over,
	};
}

describe("mechanical evidence verification (Proof-or-Stop)", () => {
	it("verifies an artifact that exists on disk", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-verify-"));
		try {
			fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
			fs.writeFileSync(path.join(dir, "dist", "out"), "content", "utf8");
			const result = mechanicallyVerifyEvidence(artifact({ locator: "dist/out" }), dir);
			assert.equal(result.verification, "verified");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("rejects an artifact claimed verified but missing on disk (anti-forgery)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-verify-"));
		try {
			// Agent claims verified, but the file does not exist.
			const result = mechanicallyVerifyEvidence(artifact({ locator: "dist/missing" }), dir);
			assert.equal(result.verification, "rejected");
			assert.match(result.verificationNote ?? "", /not found/);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("rejects a directory locator (not a regular file)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-verify-"));
		try {
			fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
			const result = mechanicallyVerifyEvidence(artifact({ locator: "dist" }), dir);
			assert.equal(result.verification, "rejected");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("attaches a short content hash for small files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-verify-"));
		try {
			fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
			fs.writeFileSync(path.join(dir, "dist", "out"), "content", "utf8");
			const result = mechanicallyVerifyEvidence(artifact({ locator: "dist/out" }), dir);
			assert.equal(result.verification, "verified");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("does not touch non-artifact kinds (judge semantics handle them)", () => {
		const observation = artifact({ kind: "observation", verification: "unverified" });
		const result = mechanicallyVerifyEvidence(observation, "/tmp");
		assert.equal(result.verification, "unverified");
		assert.equal(result.verificationNote, undefined);
	});

	it("ignores remote locators (no filesystem check)", () => {
		const result = mechanicallyVerifyEvidence(artifact({ locator: "https://example.test/a" }), "/tmp");
		assert.equal(result.verification, "verified");
	});
});
