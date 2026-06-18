import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// loadGoalConfig is a pure function (no pi types needed); we test it directly.
// continuationPrompt/goalSystemPrompt superpowers-free contract is verified
// via tsc + logic review (the prompt builders gate the superpowers block
// behind `config.superpowersIntegration`, matching the loadGoalConfig output).

import { loadGoalConfig, DEFAULT_GOAL_CONFIG } from "../extensions/config";

describe("loadGoalConfig", () => {
	it("defaults to superpowersIntegration:true (pi-goal pairs with pi-superpowers)", () => {
		assert.equal(DEFAULT_GOAL_CONFIG.superpowersIntegration, true);
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			// no config file → defaults
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.superpowersIntegration, true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("respects superpowersIntegration:false from .pi/goal.json (opt out for standalone use)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, ".pi", "goal.json"),
				JSON.stringify({ superpowersIntegration: false }),
			);
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.superpowersIntegration, false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("ignores untrusted projects (returns default, no forcing)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, ".pi", "goal.json"),
				JSON.stringify({ superpowersIntegration: false }),
			);
			const cfg = loadGoalConfig(tmp, false);
			assert.equal(cfg.superpowersIntegration, true); // default, untrusted config ignored
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("clamps invalid superpowersIntegration to true (default)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, ".pi", "goal.json"),
				JSON.stringify({ superpowersIntegration: "bogus" }),
			);
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.superpowersIntegration, true); // only explicit false opts out
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("falls back to default on malformed JSON", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cfg-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(tmp, ".pi", "goal.json"), "{ not json");
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.superpowersIntegration, true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
