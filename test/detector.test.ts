import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultConfig, evaluate, judgeBehavior, newMemory, observe, windowStats,
  type CoinMemory, type DetectorEvent, type DTick, type SessionInput,
} from "../src/detector.ts";
import { Store } from "../src/db.ts";
import { Runner, runnerDefaults } from "../src/runner.ts";
import { toTick } from "../src/hl.ts";

const S = 1000;
const tick = (ts: number, oracle: number, mark: number, funding = 0.00001, openInterest = 10): DTick =>
  ({ ts, oracle, mark, funding, openInterest });
const open: SessionInput = { phase: "regular", nearBoundary: false };
const closed: SessionInput = { phase: "closed", nearBoundary: false };

/** Oracle creeping toward a mark that sits above it: what internal pricing looked like. */
function feedInternal(mem: CoinMemory, from: number, n: number, start = 100): number {
  let o = start;
  for (let i = 0; i < n; i++) {
    o += 0.01;
    observe(mem, "c", tick(from + i * 20 * S, o, o + 0.3));
  }
  return o;
}

/** Oracle moving both ways under a mark that keeps a small premium: half the updates move away from mark. */
function feedExternal(mem: CoinMemory, from: number, n: number, start = 100): number {
  const steps = [0.05, 0.04, -0.06, -0.03, 0.05, -0.05, 0.02, -0.04];
  let o = start;
  for (let i = 0; i < n; i++) {
    o += steps[i % steps.length]!;
    observe(mem, "c", tick(from + i * 5 * S, o, o + 0.02));
  }
  return o;
}

test("windowStats counts oracle updates and their direction relative to mark", () => {
  const w = [tick(0, 100, 101), tick(1, 100.5, 101), tick(2, 100.5, 100.9), tick(3, 100.2, 100.9), tick(4, 100.2, 100.2), tick(5, 100.4, 100.2)];
  assert.deepEqual(windowStats(w), { updates: 3, towardMark: 0.5 });
  assert.equal(judgeBehavior({ updates: 2, towardMark: 1 }), "inconclusive");
  assert.equal(judgeBehavior({ updates: 8, towardMark: 1 }), "internal");
  assert.equal(judgeBehavior({ updates: 8, towardMark: 0.5 }), "external");
  assert.equal(judgeBehavior({ updates: 8, towardMark: 0.8 }), "inconclusive");
});

test("agreement between calendar and behavior gives confidence 'both'", () => {
  const a = newMemory();
  feedInternal(a, 0, 10);
  const ra = evaluate(a, { coin: "c", now: 200 * S, session: closed });
  assert.equal(ra.state.state, "internal");
  assert.equal(ra.state.confidence, "both");

  const b = newMemory();
  feedExternal(b, 0, 40);
  const rb = evaluate(b, { coin: "c", now: 200 * S, session: open });
  assert.equal(rb.state.state, "external");
  assert.equal(rb.state.confidence, "both");
  assert.equal(rb.state.conflict, false);
});

test("behavior overrides a calendar that disagrees and reports the conflict once", () => {
  const m = newMemory();
  feedExternal(m, 0, 40);
  const r1 = evaluate(m, { coin: "c", now: 200 * S, session: closed });
  assert.equal(r1.state.state, "external");
  assert.equal(r1.state.confidence, "behavior");
  assert.equal(r1.state.conflict, true);
  assert.equal(r1.events.length, 0); // not warm yet, and not yet confirmed
  const kinds: string[] = [];
  let t = 200 * S;
  for (let i = 0; i < 6; i++) {
    feedExternal(m, t, 6);
    t += 30 * S;
    kinds.push(...evaluate(m, { coin: "c", now: t, session: closed }).events.map((e) => e.kind));
  }
  assert.deepEqual(kinds, ["calendar_conflict"]); // once, and no mode_switch at start-up
});

test("a quiet spell does not hand the mode back to a calendar that was just contradicted", () => {
  const m = newMemory();
  let t = 0;
  for (let i = 0; i < 12; i++) {
    feedExternal(m, t, 6);
    t += 30 * S;
    evaluate(m, { coin: "c", now: t, session: closed });
  }
  // Ten minutes with no oracle updates at all: behavior becomes inconclusive.
  const kinds: string[] = [];
  let last = "";
  for (let i = 0; i < 20; i++) {
    t += 30 * S;
    const r = evaluate(m, { coin: "c", now: t, session: closed });
    kinds.push(...r.events.map((e) => e.kind));
    last = `${r.state.state}/${r.state.confidence}`;
  }
  assert.equal(last, "external/behavior");
  assert.equal(kinds.includes("mode_switch"), false);
  // The calendar phase itself changing releases the hold.
  const r = evaluate(m, { coin: "c", now: t + 30 * S, session: open });
  assert.equal(`${r.state.state}/${r.state.confidence}`, "external/calendar");
});

test("too few updates falls back to the calendar, or to unknown without one", () => {
  const m = newMemory();
  observe(m, "c", tick(0, 100, 100.1));
  observe(m, "c", tick(10 * S, 100, 100.2));
  assert.equal(evaluate(m, { coin: "c", now: 30 * S, session: closed }).state.confidence, "calendar");
  assert.equal(evaluate(m, { coin: "c", now: 60 * S, session: { phase: "unknown", nearBoundary: false } }).state.state, "unknown");
  assert.equal(evaluate(m, { coin: "c", now: 90 * S, session: { phase: "regular", nearBoundary: true } }).state.state, "transition");
  assert.equal(evaluate(newMemory(), { coin: "c", now: 0, session: open }).state.state, "unknown");
});

test("mode switch needs two confirming evaluations", () => {
  const m = newMemory();
  let o = feedInternal(m, 0, 16);
  assert.equal(evaluate(m, { coin: "c", now: 310 * S, session: closed }).state.state, "internal");
  // Underlying opens: frequent two-way updates replace the creep.
  const kinds: string[] = [];
  let t = 310 * S;
  for (let i = 0; i < 14; i++) {
    o = feedExternal(m, t, 6, o);
    t += 30 * S;
    kinds.push(...evaluate(m, { coin: "c", now: t, session: open }).events.map((e) => e.kind));
  }
  assert.deepEqual(kinds.filter((k) => k === "mode_switch"), ["mode_switch"]);
});

test("oracle jump fires on a single large update but not across a data gap", () => {
  const m = newMemory();
  observe(m, "c", tick(0, 100, 100));
  observe(m, "c", tick(5 * S, 101.5, 100));
  const r = evaluate(m, { coin: "c", now: 10 * S, session: open });
  assert.equal(r.events[0]!.kind, "oracle_jump");
  assert.equal(r.events[0]!.detail.stepBp, 150);
  observe(m, "c", tick(600 * S, 104, 104));
  assert.equal(evaluate(m, { coin: "c", now: 610 * S, session: open }).events.filter((e) => e.kind === "oracle_jump").length, 0);
});

test("stale oracle is raised once and cleared when the oracle moves again", () => {
  const m = newMemory();
  observe(m, "c", tick(0, 100, 100));
  for (let i = 1; i <= 8; i++) observe(m, "c", tick(i * 120 * S, 100, 100 + i * 0.01));
  const r1 = evaluate(m, { coin: "c", now: 961 * S, session: open });
  assert.equal(r1.state.state, "stale");
  assert.deepEqual(r1.events.map((e) => e.kind), ["oracle_stale"]);
  assert.equal(evaluate(m, { coin: "c", now: 991 * S, session: open }).events.length, 0);
  observe(m, "c", tick(1000 * S, 100.05, 100.08));
  assert.notEqual(evaluate(m, { coin: "c", now: 1021 * S, session: open }).state.state, "stale");
});

test("funding and open-interest cap conditions", () => {
  const m = newMemory();
  observe(m, "c", tick(0, 100, 100, -0.0008, 950));
  const r = evaluate(m, { coin: "c", now: S, session: open, oiCapUsd: 100_000 });
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ["funding_extreme", "oi_cap_near"]);
  assert.equal(r.state.metrics.oiCapUsage, 0.95);
});

test("basis breach needs a warm baseline, size, z-score and a hold period", () => {
  const cfg = { ...defaultConfig, baselineMinSamples: 20 };
  const m = newMemory();
  const events: DetectorEvent[] = [];
  let t = 0;
  // A coin that normally sits at -120bp must not breach just for being wide.
  for (let i = 0; i < 40; i++) {
    observe(m, "c", tick(t, 100, 98.8 + (i % 2) * 0.01));
    t += 30 * S;
    events.push(...evaluate(m, { coin: "c", now: t, session: closed }, cfg).events);
  }
  assert.equal(events.filter((e) => e.kind === "basis_breach").length, 0);
  // Then it dislocates to about -400bp and stays there.
  for (let i = 0; i < 5; i++) {
    observe(m, "c", tick(t, 100, 96 + i * 0.001));
    t += 30 * S;
    events.push(...evaluate(m, { coin: "c", now: t, session: closed }, cfg).events);
  }
  const breaches = events.filter((e) => e.kind === "basis_breach");
  assert.equal(breaches.length, 1);
  assert.ok(Number(breaches[0]!.detail.basisBp) < -390);
});

test("runner replays stored ticks, persists output and is idempotent", () => {
  const store = new Store(":memory:");
  const base = Date.parse("2026-11-24T15:00:00Z"); // US regular session
  const mem = newMemory();
  const ticks: DTick[] = [];
  const orig = mem.window;
  feedExternal(mem, base, 120);
  ticks.push(...orig);
  store.writeTicks(ticks.map((t) => toTick("xyz:NVDA", {
    funding: "0.00001", openInterest: "10", oraclePx: String(t.oracle), markPx: String(t.mark),
    midPx: null, impactPxs: null, premium: null, dayNtlVlm: "1",
  }, t.ts, "poll")));
  const opts = { ...runnerDefaults, categories: new Map([["xyz:NVDA", "stocks"]]) };
  const end = base + 11 * 60 * S;
  const r1 = new Runner(store, opts, base - S);
  r1.advance(end);
  assert.equal(r1.counts.ticks, 120);
  assert.equal(r1.latest.get("xyz:NVDA")!.state, "external");
  assert.equal(r1.latest.get("xyz:NVDA")!.confidence, "both");
  assert.ok(r1.counts.stateRows >= 1);
  const r2 = new Runner(store, opts, base - S);
  r2.advance(end);
  assert.equal(r2.counts.stateRows, 0); // same history, nothing new written
  store.close();
});

test("runner does not evaluate past the data or across a collector outage", () => {
  const store = new Store(":memory:");
  const base = Date.parse("2026-11-24T15:00:00Z");
  const raw = (o: number, ts: number) => toTick("xyz:NVDA", {
    funding: "0.00001", openInterest: "10", oraclePx: String(o), markPx: String(o + 0.02),
    midPx: null, impactPxs: null, premium: null, dayNtlVlm: "1",
  }, ts, "poll");
  const a = newMemory();
  feedExternal(a, base, 80); // 400 s of data
  const b = newMemory();
  feedExternal(b, base + 3_600 * S, 80); // resumes an hour later
  store.writeTicks([...a.window, ...b.window].map((t) => raw(t.oracle, t.ts)));
  const r = new Runner(store, { ...runnerDefaults, categories: new Map([["xyz:NVDA", "stocks"]]) }, base - S);
  r.advance(base + 24 * 3_600 * S);
  // About 13 evaluations per 400 s stretch, none in the hour between or the day after.
  assert.ok(r.counts.evals >= 20 && r.counts.evals <= 30, `evals=${r.counts.evals}`);
  store.close();
});
