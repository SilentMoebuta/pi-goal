import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runVerifyCommand, type VerifyResult } from "../extensions/verify-command";
import { loadGoalConfig, DEFAULT_GOAL_CONFIG, type GoalConfig } from "../extensions/config";

// GG-1: deterministic command-based verification, opt-in via .pi/goal.json
// `verifyCommand` (trusted projects only). runVerifyCommand is the pure unit
// under test: it runs the command via child_process.spawnSync({shell:true})
// and returns {ok, exitCode, stdout, stderr}. runJudge (NOT unit-tested — it
// calls a real provider via complete()) calls runVerifyCommand before the LLM
// judge and short-circuits done:false on a non-zero exit, keeping the LLM
// judge as a backward-compatible fallback when no command is configured.
// loadGoalConfig surfaces verifyCommand from .pi/goal.json (trusted only).

describe("runVerifyCommand (GG-1 command execution)", () => {
	it("exit 0 → ok:true, exitCode:0", async () => {
		const r = await runVerifyCommand('node -e "process.exit(0)"');
		assert.equal(r.ok, true);
		assert.equal(r.exitCode, 0);
	});

	it("exit 1 → ok:false, exitCode:1", async () => {
		const r = await runVerifyCommand('node -e "process.exit(1)"');
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 1);
	});

	it("captures stdout (echo hello → stdout contains 'hello')", async () => {
		const r = await runVerifyCommand("echo hello");
		assert.equal(r.ok, true);
		assert.equal(r.exitCode, 0);
		assert.match(r.stdout, /hello/);
	});

	it("exit code 2 propagates as ok:false, exitCode:2", async () => {
		const r = await runVerifyCommand('node -e "process.exit(2)"');
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 2);
	});

	it("captures stderr from a failing command", async () => {
		const r = await runVerifyCommand('node -e "process.stderr.write(\'boom\'); process.exit(3)"');
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 3);
		assert.match(r.stderr, /boom/);
	});

	it("empty string → defined safe result (ok:false, exitCode:null, explained stderr)", async () => {
		// Documented contract: an empty/blank command is NEVER handed to the
		// shell — runVerifyCommand short-circuits to a safe {ok:false} result
		// rather than relying on shell quirks for an empty command line.
		const r = await runVerifyCommand("");
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, null);
		assert.ok(r.stderr.length > 0, "stderr should explain why the command didn't run");
	});

	it("whitespace-only string → same safe result as empty", async () => {
		const r = await runVerifyCommand("   ");
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, null);
	});

	it("returns a full VerifyResult shape (all four fields present)", async () => {
		const r: VerifyResult = await runVerifyCommand("echo ok");
		assert.equal(typeof r.ok, "boolean");
		assert.ok(r.exitCode === null || typeof r.exitCode === "number");
		assert.equal(typeof r.stdout, "string");
		assert.equal(typeof r.stderr, "string");
	});

	it("truncates very long stdout to a bounded length (≤ ~2000 chars)", async () => {
		// Print 5000 chars; result.stdout must be capped so a runaway verify
		// command cannot flood the judge prompt / session entry with output.
		const r = await runVerifyCommand('node -e "process.stdout.write(\'x\'.repeat(5000))"');
		assert.equal(r.ok, true);
		assert.ok(r.stdout.length <= 2000, "stdout must be truncated to <= 2000 chars, got " + r.stdout.length);
		assert.ok(r.stdout.length > 0, "stdout must still contain the (truncated) output");
	});
});

describe("GoalConfig.verifyCommand (GG-1 config wiring)", () => {
	it("is undefined by default (no command verification — backward compatible)", () => {
		// When verifyCommand is unset, runJudge is UNCHANGED: LLM-judge-only.
		assert.equal(DEFAULT_GOAL_CONFIG.verifyCommand, undefined);
	});

	it("is a valid typed field", () => {
		const c: GoalConfig = { superpowersIntegration: true, verifyCommand: "npm test" };
		assert.equal(c.verifyCommand, "npm test");
	});

	it("loadGoalConfig reads verifyCommand from .pi/goal.json (trusted)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-verify-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(tmp, ".pi", "goal.json"), JSON.stringify({ verifyCommand: "npm test" }));
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.verifyCommand, "npm test");
			// other fields keep their defaults
			assert.equal(cfg.superpowersIntegration, true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("loadGoalConfig ignores verifyCommand for untrusted projects (returns default)", () => {
		// Security gate: verifyCommand is only honored when trusted. loadGoalConfig
		// already returns DEFAULT_GOAL_CONFIG (verifyCommand: undefined) when
		// !trusted, so runJudge can trust config.verifyCommand presence.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-verify-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(tmp, ".pi", "goal.json"), JSON.stringify({ verifyCommand: "npm test" }));
			const cfg = loadGoalConfig(tmp, false);
			assert.equal(cfg.verifyCommand, undefined);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("loadGoalConfig treats a non-string verifyCommand as undefined", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-verify-"));
		try {
			fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(tmp, ".pi", "goal.json"), JSON.stringify({ verifyCommand: 123 }));
			const cfg = loadGoalConfig(tmp, true);
			assert.equal(cfg.verifyCommand, undefined);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
