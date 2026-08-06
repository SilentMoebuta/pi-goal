import { spawn } from "node:child_process";

// GG-1: deterministic command-based verification, opt-in via .pi/goal.json
// `verifyCommand` (trusted projects only — see config.loadGoalConfig).
//
// runVerifyCommand is the unit-testable unit: it runs a shell command and
// returns a normalized {ok, exitCode, stdout, stderr}. It is deliberately
// free of any pi context so it can be exercised in isolation.
//
// runJudge (extensions/index.ts) calls this BEFORE the LLM judge when a
// verifyCommand is configured: a non-zero exit short-circuits done:false with
// the (truncated) stderr/stdout as the reason, giving a DETERMINISTIC
// completion signal (the strongest SOTA completion signal per the C1 gap
// analysis) while keeping the LLM judge as the backward-compatible fallback
// when no command is configured.
//
// M1 (Step-5 audit): ASYNC via child_process.spawn (not spawnSync) so a slow
// verify command (e.g. `npm test`) does NOT block the Node event loop / freeze
// the TUI, with a configurable timeout (default 120s — real test suites exceed
// the old 30s cap) that SIGKILLs an overrun. Security: loadGoalConfig only
// populates verifyCommand for trusted projects, so runVerifyCommand can trust
// the field's presence without re-checking trust.

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

/** Stream cap guard: stop accumulating beyond the cap so a chatty command
 *  cannot grow memory without bound before close/timeout (audit finding). */
function appendCapped(buffer: string, chunk: string, max = VERIFY_MAX_OUTPUT): string {
	if (buffer.length >= max) return buffer;
	return (buffer + chunk).slice(0, max);
}

function truncate(s: string): string {
	return s.length > VERIFY_MAX_OUTPUT ? s.slice(0, VERIFY_MAX_OUTPUT) : s;
}

/** Run a verify command asynchronously via a shell and return a normalized
 *  result. `ok` is true iff the command exits 0. Resolves (never rejects) —
 *  spawn errors, timeouts, and signals all fold into a {ok:false} result.
 *
 *  Contract for blank / non-string input: the command is NEVER handed to the
 *  shell — runVerifyCommand short-circuits to a safe {ok:false, exitCode:null}
 *  result with an explanatory stderr, rather than relying on shell quirks for
 *  an empty command line. This keeps behavior deterministic across shells. */
export async function runVerifyCommand(cmd: string, timeoutMs = 120_000): Promise<VerifyResult> {
	if (typeof cmd !== "string" || cmd.trim().length === 0) {
		return { ok: false, exitCode: null, stdout: "", stderr: "verify command is empty" };
	}

	return new Promise<VerifyResult>((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		// Declared before spawn so a synchronous spawn throw cannot hit the TDZ:
		// finish() clears it even when spawn never started (audit finding).
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: VerifyResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			finish({ ok: false, exitCode: null, stdout: "", stderr: "verify command failed to spawn: " + (e instanceof Error ? e.message : String(e)) });
			return;
		}

		timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* already dead */ }
			finish({ ok: false, exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr) + (stderr ? "\n" : "") + "verify command timed out after " + timeoutMs + "ms" });
		}, timeoutMs);

		child.stdout?.on("data", (d: Buffer) => { stdout = appendCapped(stdout, d.toString()); });
		child.stderr?.on("data", (d: Buffer) => { stderr = appendCapped(stderr, d.toString()); });
		child.on("error", (e) => {
			finish({ ok: false, exitCode: null, stdout: truncate(stdout), stderr: "verify command failed to spawn: " + e.message });
		});
		child.on("close", (code, signal) => {
			if (signal) {
				finish({ ok: false, exitCode: null, stdout: truncate(stdout), stderr: truncate(stderr) + (stderr ? "\n" : "") + "verify command killed by signal: " + signal });
			} else {
				finish({ ok: code === 0, exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) });
			}
		});
	});
}
