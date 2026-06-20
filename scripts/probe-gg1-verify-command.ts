// GG-1 live probe: exercises runVerifyCommand in a fresh `npx tsx` process
// (bypasses parent-pi module cache — pi-roles independent-process methodology).
// Unlike the model-based probes (GG-3/GM-9/GG-14/GM-1), this needs NO provider
// or network — it runs real shell commands via child_process, so it executes
// anywhere and proves the verify-command runtime path end-to-end (exit-code
// propagation, stdout/stderr capture, truncation) beyond the unit tests.
//
//   npx tsx scripts/probe-gg1-verify-command.ts

import { runVerifyCommand } from "../extensions/verify-command";

function assert(cond: boolean, msg: string): void {
	if (!cond) { console.error("FAIL: " + msg); process.exit(1); }
	console.log("  ok: " + msg);
}

console.log("[probe-gg1] exercising runVerifyCommand with real shell commands...");
const ok = runVerifyCommand('node -e "process.exit(0)"');
assert(ok.ok === true && ok.exitCode === 0, "exit 0 -> ok=true, exitCode=0");

const fail = runVerifyCommand('node -e "process.exit(1)"');
assert(fail.ok === false && fail.exitCode === 1, "exit 1 -> ok=false, exitCode=1");

const withStdout = runVerifyCommand("echo probe-gg1-output");
assert(withStdout.ok === true, "echo -> ok=true");
assert(withStdout.stdout.includes("probe-gg1-output"), "stdout captured");

const blank = runVerifyCommand("");
assert(blank.ok === false && blank.exitCode === null, "blank command -> safe {ok:false, exitCode:null}");

console.log("[probe-gg1] PASS: runVerifyCommand runtime path works (exit codes + stdout + blank-cmd safety).");
