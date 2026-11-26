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
