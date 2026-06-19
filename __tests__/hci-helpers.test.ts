import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canUpdateGoal,
  canResumeGoal,
  footerStatusText,
  isTerminalStatus,
} from "../extensions/config";

// Pure helpers extracted from index.ts so the HCI logic (tool availability,
// resume coverage, footer text) is unit-testable without spinning up the
// extension. See research/2026-06-19-pi-goal-hci-audit.md.

describe("canUpdateGoal (P0-1: no pause→no-update_goal deadlock)", () => {
  it("true in active (normal operation)", () => {
    assert.equal(canUpdateGoal("active"), true);
  });
  it("true in paused (agent can self-resume via update_goal({status:'active'}))", () => {
    assert.equal(canUpdateGoal("paused"), true);
  });
  it("true in budget_limited (resume after budget recovery)", () => {
    assert.equal(canUpdateGoal("budget_limited"), true);
  });
  it("true in usage_limited (resume after provider recovery)", () => {
    assert.equal(canUpdateGoal("usage_limited"), true);
  });
  it("true in blocked (agent can clear blocker + resume)", () => {
    assert.equal(canUpdateGoal("blocked"), true);
  });
  it("true in unmet (agent can clear blocker + resume, or user amends)", () => {
    assert.equal(canUpdateGoal("unmet"), true);
  });
  it("true in complete (amend evidence / revert if judge mis-evaluated)", () => {
    assert.equal(canUpdateGoal("complete"), true);
  });
  it("false when no goal (null/undefined)", () => {
    assert.equal(canUpdateGoal(null), false);
    assert.equal(canUpdateGoal(undefined), false);
  });
});

describe("canResumeGoal (P0-2: /goal resume coverage)", () => {
  it("true in paused", () => {
    assert.equal(canResumeGoal("paused"), true);
  });
  it("true in usage_limited (provider recovered)", () => {
    assert.equal(canResumeGoal("usage_limited"), true);
  });
  it("true in budget_limited (budget recovered)", () => {
    assert.equal(canResumeGoal("budget_limited"), true);
  });
  it("false in active (nothing to resume)", () => {
    assert.equal(canResumeGoal("active"), false);
  });
  it("false in blocked (superseded by a newer goal — terminal)", () => {
    assert.equal(canResumeGoal("blocked"), false);
  });
  it("false in unmet (terminal — clear to restart)", () => {
    assert.equal(canResumeGoal("unmet"), false);
  });
  it("false in complete (terminal)", () => {
    assert.equal(canResumeGoal("complete"), false);
  });
  it("false when no goal", () => {
    assert.equal(canResumeGoal(null), false);
  });
});

describe("isTerminalStatus (shared: terminal = no resume)", () => {
  it("blocked/unmet/complete are terminal", () => {
    assert.equal(isTerminalStatus("blocked"), true);
    assert.equal(isTerminalStatus("unmet"), true);
    assert.equal(isTerminalStatus("complete"), true);
  });
  it("active/paused/budget_limited/usage_limited are NOT terminal", () => {
    assert.equal(isTerminalStatus("active"), false);
    assert.equal(isTerminalStatus("paused"), false);
    assert.equal(isTerminalStatus("budget_limited"), false);
    assert.equal(isTerminalStatus("usage_limited"), false);
  });
  it("null/undefined is terminal-ish (no resumable goal)", () => {
    assert.equal(isTerminalStatus(null), true);
    assert.equal(isTerminalStatus(undefined), true);
  });
});

describe("footerStatusText (P1-1/P1-2/P1-3: footer shows reason/summary)", () => {
  it("active: 🎯 goal (<usage>)", () => {
    const t = footerStatusText("active", { usage: "1.2k/50k" });
    assert.ok(t.includes("goal"), "active footer mentions goal");
    assert.ok(t.includes("1.2k/50k"), "active footer shows usage");
  });
  it("paused: shows pause reason, not just 'goal paused' (P1-1)", () => {
    const t = footerStatusText("paused", { pausedReason: "no progress for 5 turns" });
    assert.ok(t.toLowerCase().includes("paused"), "says paused");
    assert.ok(t.includes("no progress"), "surfaces the reason");
  });
  it("paused with no reason: still says paused (graceful)", () => {
    const t = footerStatusText("paused", {});
    assert.ok(t.toLowerCase().includes("paused"));
  });
  it("blocked: shows blocker summary (P1-2)", () => {
    const t = footerStatusText("blocked", { blocker: "needs API key from user" });
    assert.ok(t.toLowerCase().includes("blocked"));
    assert.ok(t.includes("API key"), "surfaces blocker text");
  });
  it("unmet: shows blocker summary (P1-2)", () => {
    const t = footerStatusText("unmet", { blocker: "approver rejected 3x" });
    assert.ok(t.toLowerCase().includes("unmet") || t.toLowerCase().includes("blocked"));
    assert.ok(t.includes("rejected 3x"));
  });
  it("complete: shows achieved (P1-3, transient visibility)", () => {
    const t = footerStatusText("complete", {});
    assert.ok(t.toLowerCase().includes("achiev") || t.includes("✅"), "complete visible");
  });
  it("budget_limited: shows budget reached", () => {
    const t = footerStatusText("budget_limited", {});
    assert.ok(t.toLowerCase().includes("budget"));
  });
  it("usage_limited: shows usage limited", () => {
    const t = footerStatusText("usage_limited", {});
    assert.ok(t.toLowerCase().includes("usage"));
  });
});
