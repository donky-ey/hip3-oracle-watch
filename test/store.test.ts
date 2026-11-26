import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { changed } from "../src/collector.ts";
import { toTick, type RawCtx } from "../src/hl.ts";

const ctx = (over: Partial<RawCtx> = {}): RawCtx => ({
  funding: "0.00001", openInterest: "10", oraclePx: "100", markPx: "100.5", midPx: "100.4",
  impactPxs: ["100.3", "100.6"], premium: "0.001", dayNtlVlm: "5000", ...over,
});

test("toTick parses strings and tolerates missing book fields", () => {
  const t = toTick("xyz:NVDA", ctx({ midPx: null, impactPxs: null }), 1, "poll");
  assert.equal(t.oracle, 100);
  assert.equal(t.mid, null);
  assert.equal(t.impactBid, null);
});

test("changed ignores volume-only updates", () => {
  const a = toTick("xyz:NVDA", ctx(), 1, "poll");
  assert.equal(changed(undefined, a), true);
  assert.equal(changed(a, toTick("xyz:NVDA", ctx({ dayNtlVlm: "9999" }), 2, "poll")), false);
  assert.equal(changed(a, toTick("xyz:NVDA", ctx({ oraclePx: "100.1" }), 2, "poll")), true);
});

test("store writes ticks, dedupes on key and reports gaps", () => {
  const s = new Store(":memory:");
  const t = toTick("xyz:NVDA", ctx(), 1000, "poll");
  s.writeTicks([t, t]);
  for (const ts of [1000, 6000, 11000, 71000, 76000]) s.recordPoll(ts, "xyz", 150, 1);
  const c = s.coverage("xyz", 0, 100000, 15000);
  assert.equal(c.ticks, 1);
  assert.equal(c.polls, 5);
  assert.deepEqual(c.gaps, [{ from: 11000, to: 71000, seconds: 60 }]);
  s.close();
});

test("dex config is stored only when it changes", () => {
  const s = new Store(":memory:");
  assert.equal(s.recordDexConfig(1, "xyz", "a", "{}"), false); // first sighting is not a change
  assert.equal(s.recordDexConfig(2, "xyz", "a", "{}"), false);
  assert.equal(s.recordDexConfig(3, "xyz", "b", "{}"), true);
  s.close();
});

test("compact folds old ticks into one-minute bars and keeps recent ones", () => {
  const s = new Store(":memory:");
  const M = 60_000;
  const mk = (ts: number, oracle: string, mark: string, extra: Partial<RawCtx> = {}) =>
    toTick("xyz:NVDA", ctx({ oraclePx: oracle, markPx: mark, ...extra }), ts, "poll");
  s.writeTicks([
    // minute 0: oracle 100 -> 102 -> 101, basis 0bp, ~98bp, ~-99bp
    mk(0 * M + 1_000, "100", "100"),
    mk(0 * M + 20_000, "102", "103"),
    mk(0 * M + 50_000, "101", "100", { funding: "0.0002", openInterest: "42", midPx: "100.9" }),
    // minute 1
    mk(1 * M + 5_000, "101", "101"),
    // recent, must survive
    mk(10 * M + 5_000, "105", "105"),
    toTick("xyz:SKHX", ctx({ oraclePx: "800", markPx: "790" }), 0 * M + 2_000, "ws"),
  ]);
  s.recordPoll(1_000, "xyz", 150, 3);
  s.recordPoll(10 * M, "xyz", 150, 1);

  // now = 12 min, retention = 5 min -> cutoff at minute 7
  const r = s.compact(12 * M, 5 * M, 11 * M + 30_000, 90_000);
  assert.equal(r.cutoff, 7 * M);
  assert.equal(r.ticksRemoved, 5);
  assert.equal(r.barsWritten, 3);
  assert.equal(r.pollsRemoved, 1);

  const left = s.db.prepare("SELECT coin, ts FROM ticks").all();
  assert.deepEqual(left.map((x) => ({ ...x })), [{ coin: "xyz:NVDA", ts: 10 * M + 5_000 }]);

  const b = s.db.prepare("SELECT * FROM bars_1m WHERE coin = 'xyz:NVDA' AND ts = 0").get() as Record<string, number>;
  assert.equal(b.oracle_open, 100);
  assert.equal(b.oracle_high, 102);
  assert.equal(b.oracle_low, 100);
  assert.equal(b.oracle_close, 101);
  assert.equal(b.mark_open, 100);
  assert.equal(b.mark_high, 103);
  assert.equal(b.mark_close, 100);
  assert.equal(b.mid_close, 100.9);
  assert.equal(b.funding_close, 0.0002);
  assert.equal(b.open_interest_close, 42);
  assert.equal(b.ticks, 3);
  assert.ok(Math.abs(b.basis_max_bp! - (103 / 102 - 1) * 1e4) < 1e-6);
  assert.ok(Math.abs(b.basis_min_bp! - (100 / 101 - 1) * 1e4) < 1e-6);
  assert.ok(Math.abs(b.oracle_max_step_bp! - 200) < 1e-6); // 100 -> 102

  const skhx = s.db.prepare("SELECT basis_min_bp FROM bars_1m WHERE coin = 'xyz:SKHX'").get() as { basis_min_bp: number };
  assert.ok(Math.abs(skhx.basis_min_bp + 125) < 1e-6);

  // Running again changes nothing.
  const again = s.compact(12 * M, 5 * M, 11 * M + 30_000);
  assert.equal(again.ticksRemoved, 0);
  assert.equal(again.barsWritten, 0);
  s.close();
});
