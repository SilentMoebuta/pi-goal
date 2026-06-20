import { spawnSync } from "node:child_process";

// GG-1: deterministic command-based verification, opt-in via .pi/goal.json
// `verifyCommand` (trusted projects only — see config.loadGoalConfig).
//
// runVerifyCommand is the PURE, unit-testable unit: it runs a shell command
// synchronously and returns a normalized {ok, exitCode, stdout, stderr}. It is
// deliberately free of any pi context so it can be exercised in isolation.
//
// runJudge (extensions/index.ts) calls this BEFORE the LLM judge when a
// verifyCommand is configured: a non-zero exit short-circuits done:false with
// the (truncated) stderr/stdout as the reason, giving a DETERMINISTIC
// completion signal (the strongest SOTA completion signal per the C1 gap
// analysis) while keeping the LLM judge as the backward-compatible fallback
// when no command is configured.
//
// Security: runJudge receives a GoalConfig (not ctx-trust), but
// loadGoalConfig only populates `verifyCommand` for trusted projects, so the
// field's mere presence is proof the project is trusted. runVerifyCommand
// itself trusts whatever string it is handed — it is the caller's job to gate.

/** Normalized result of running the verify command. */
export interface VerifyResult {
	/** true iff exitCode === 0 (the command succeeded). */
	ok: boolean;
	/** The process exit code, or null if the process did not run to
	 *  completion (spawn failure, timeout/kill by signal, or a blank
	 *  command short-circuited before spawning). */
	exitCode: number | null;
	/** Captured stdout, truncated to ~VERIFY_MAX_OUTPUT chars. */
	stdout: string;
	/** Captured stderr, truncated to ~VERIFY_MAX_OUTPUT chars. For a blank
	 *  command or a spawn/timeout failure, this carries a human-readable
	 *  reason instead of shell output. */
	stderr: string;
}

/** Cap on captured stdout/stderr length (chars). A runaway verify command
 *  must not flood the judge prompt / session entry with output. */
const VERIFY_MAX_OUTPUT = 2_000;
/** Hard kill timeout (ms) so a hanging verify command cannot stall the
 *  agent_end judge path indefinitely. */
const VERIFY_TIMEOUT_MS = 30_000;
/** spawnSync maxBuffer (bytes). Beyond this the child is killed and the
 *  partial output is still returned. */
const VERIFY_MAX_BUFFER = 1024 * 256;

function truncate(s: string): string {
	return s.length > VERIFY_MAX_OUTPUT ? s.slice(0, VERIFY_MAX_OUTPUT) : s;
}

/** Run a verify command synchronously via a shell and return a normalized
 *  result. `ok` is true iff the command exits 0.
 *
 *  Contract for blank / non-string input: the command is NEVER handed to the
 *  shell — runVerifyCommand short-circuits to a safe {ok:false, exitCode:null}
 *  result with an explanatory stderr, rather than relying on shell quirks for
 *  an empty command line. This keeps behavior deterministic across shells. */
export function runVerifyCommand(cmd: string): VerifyResult {
	if (typeof cmd !== "string" || cmd.trim().length === 0) {
		return { ok: false, exitCode: null, stdout: "", stderr: "verify command is empty" };
	}

	const result = spawnSync(cmd, {
		shell: true,
		timeout: VERIFY_TIMEOUT_MS,
		maxBuffer: VERIFY_MAX_BUFFER,
		encoding: "utf8",
	});

	if (result.error) {
		// Could not spawn (e.g. shell binary missing). No meaningful exit code.
		return {
			ok: false,
			exitCode: null,
			stdout: "",
			stderr: "verify command failed to spawn: " + result.error.message,
		};
	}

	const stdout = truncate(typeof result.stdout === "string" ? result.stdout : "");
	const stderr = truncate(typeof result.stderr === "string" ? result.stderr : "");

	if (result.status === null) {
		// Killed by signal (e.g. timeout SIGTERM, or maxBuffer exceeded). The
		// child did not exit normally, so there is no meaningful exit code;
		// fold the signal into stderr so the reason is traceable.
		const sig = result.signal ?? "unknown";
		return {
			ok: false,
			exitCode: null,
			stdout,
			stderr: stderr + (stderr ? "\n" : "") + "verify command killed by signal: " + sig,
		};
	}

	return { ok: result.status === 0, exitCode: result.status, stdout, stderr };
}
