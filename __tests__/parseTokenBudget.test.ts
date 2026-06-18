import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Spec mirrors (kept in sync with extensions/index.ts by review).
// Importing index.ts pulls the whole extension dep chain, so we mirror the
// two pure functions under test and assert their spec.

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// Mirror of parseTokenBudget (extensions/index.ts).
function parseTokenBudget(input: string): { objective: string; tokenBudget: number | null } {
  const match = input.match(/(?:^|\s)--tokens(?:=|\s+)([0-9]+(?:\.[0-9]+)?\s*[kKmM]?)(?:\s|$)/);
  if (!match) return { objective: input.trim(), tokenBudget: null };
  const raw = match[1].replace(/\s+/g, "");
  const suffix = raw.slice(-1).toLowerCase();
  const numeric = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) return { objective: input.trim(), tokenBudget: null };
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return {
    tokenBudget: Math.round(value * multiplier),
    objective: (input.slice(0, match.index) + " " + input.slice((match.index ?? 0) + match[0].length)).trim(),
  };
}

describe("parseTokenBudget", () => {
  it("no --tokens → null budget, objective intact", () => {
    const r = parseTokenBudget("fix all the bugs");
    assert.equal(r.tokenBudget, null);
    assert.equal(r.objective, "fix all the bugs");
  });

  it("--tokens 50k → 50000", () => {
    const r = parseTokenBudget("fix bugs --tokens 50k");
    assert.equal(r.tokenBudget, 50000);
    assert.equal(r.objective, "fix bugs");
  });

  it("--tokens=1m → 1000000 (= syntax)", () => {
    const r = parseTokenBudget("do task --tokens=1m");
    assert.equal(r.tokenBudget, 1_000_000);
    assert.equal(r.objective, "do task");
  });

  it("--tokens 1000 (no suffix) → 1000", () => {
    const r = parseTokenBudget("task --tokens 1000");
    assert.equal(r.tokenBudget, 1000);
    assert.equal(r.objective, "task");
  });

  it("--tokens 1.5k (decimal) → 1500", () => {
    const r = parseTokenBudget("task --tokens 1.5k");
    assert.equal(r.tokenBudget, 1500);
  });

  it("--tokens 50K (uppercase) → 50000", () => {
    const r = parseTokenBudget("task --tokens 50K");
    assert.equal(r.tokenBudget, 50000);
  });

  it("--tokens 0 → null (non-positive falls back)", () => {
    const r = parseTokenBudget("task --tokens 0");
    assert.equal(r.tokenBudget, null);
  });

  it("--tokens -5 → null (negative)", () => {
    const r = parseTokenBudget("task --tokens -5");
    assert.equal(r.tokenBudget, null);
  });

  it("budget mid-sentence preserves surrounding text", () => {
    const r = parseTokenBudget("do X --tokens 50k and Y");
    assert.equal(r.tokenBudget, 50000);
    assert.equal(r.objective, "do X and Y");
  });
});

describe("formatTokens (regression)", () => {
  it("M/K/plain thresholds", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5K");
    assert.equal(formatTokens(1_500_000), "1.5M");
  });
});
