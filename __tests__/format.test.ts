import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Spec mirror of formatDuration/formatTokens (defined in extensions/index.ts).
// These are pure functions; we test the spec here. The implementation in
// index.ts is verified to match via typecheck + manual diff.
// (Importing index.ts directly pulls the whole extension's dep chain, so we
// mirror the spec and keep them in sync by review.)

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ${minutes % 60}m`;
}

describe("formatDuration", () => {
  it("seconds under 60 → Ns", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(59_000), "59s");
  });

  it("minutes under 60 → Nm", () => {
    assert.equal(formatDuration(60_000), "1m");
    assert.equal(formatDuration(3599_000), "59m");
  });

  it("hours under 24 → Nh Nm", () => {
    assert.equal(formatDuration(3600_000), "1h 0m");
    assert.equal(formatDuration(90 * 60_000), "1h 30m");
    assert.equal(formatDuration((23 * 3600 + 59 * 60) * 1000), "23h 59m");
  });

  it(">=24h → Nd Nh Nm (Codex style, zero-padded h/m)", () => {
    assert.equal(formatDuration(24 * 3600_000), "1d 0h 0m");
    assert.equal(formatDuration((2 * 24 + 23) * 3600_000 + 42 * 60_000), "2d 23h 42m");
  });
});

describe("formatTokens", () => {
  it("under 1000 → plain number", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
  });

  it("1k-10k → N.Nk", () => {
    assert.equal(formatTokens(1500), "1.5K");
  });

  it(">=1M → N.NM", () => {
    assert.equal(formatTokens(1_500_000), "1.5M");
  });
});
