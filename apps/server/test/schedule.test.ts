import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { toTick } from "../src/hl.ts";
import { BUCKET_MS, bucketRegime, buildSchedule, findSwitches, loadBuckets, ranges, toMarkdown, type Bucket } from "../src/schedule.ts";

const bk = (ts: number, updates: number, judged: number, toward: number, coin = "c"): Bucket => ({ coin, ts, updates, judged, toward });

test("bucketRegime", () => {
  assert.equal(bucketRegime({ updates: 60, judged: 60, toward: 27 }), "external");
  assert.equal(bucketRegime({ updates: 100, judged: 100, toward: 99 }), "internal");
  assert.equal(bucketRegime({ updates: 5, judged: 5, toward: 5 }), "internal"); // short run, all chasing mark
  assert.equal(bucketRegime({ updates: 5, judged: 5, toward: 3 }), null); // too few to call external
  assert.equal(bucketRegime({ updates: 2, judged: 2, toward: 2 }), null);
  assert.equal(bucketRegime({ updates: 60, judged: 8, toward: 8 }), null); // mark pinned to oracle
  assert.equal(bucketRegime({ updates: 20, judged: 20, toward: 16 }), null); // in between
  assert.equal(bucketRegime({ updates: 0, judged: 0, toward: 0 }), null);
});

test("findSwitches needs both regimes established and ignores gaps and blips", () => {
  const B = BUCKET_MS;
  const ext = (i: number) => bk(i * B, 60, 60, 28);
  const int = (i: number) => bk(i * B, 20, 20, 20);
  const none = (i: number) => bk(i * B, 1, 1, 1);
  assert.deepEqual(findSwitches([ext(0), ext(1), ext(2), int(3), int(4), int(5)]), [{ coin: "c", ts: 3 * B, from: "external", to: "internal" }]);
  assert.deepEqual(findSwitches([ext(0), ext(1), int(2), ext(3), ext(4)]), []); // one-bucket blip
  assert.deepEqual(findSwitches([ext(0), ext(1), none(2), none(3), int(4), int(5)]).map((s) => s.ts), [4 * B]);
  assert.deepEqual(findSwitches([int(0), int(1)]), []); // nothing to switch from
  assert.deepEqual(findSwitches([ext(0), ext(1), int(20), int(21)]), []); // 90-minute hole in between
  assert.equal(findSwitches([ext(0), ext(1), int(2), int(3), ext(4), ext(5)]).length, 2);
});

test("ranges merges adjacent half-hour slots and wraps midnight", () => {
  assert.equal(ranges([600, 630, 660, 900]), "10:00-11:30, 15:00-15:30");
  assert.equal(ranges([1410]), "23:30-00:00");
  assert.equal(ranges([]), "");
});

/** Writes ticks that produce `n` oracle updates in a bucket, `towardAll` deciding their direction. */
function fill(store: Store, coin: string, start: number, n: number, towardAll: boolean, o0: number): number {
  let o = o0;
  const ticks = [];
  for (let i = 0; i < n; i++) {
    const up = towardAll ? true : i % 2 === 0;
    o += up ? 0.01 : -0.01;
    ticks.push(toTick(coin, { funding: "0", openInterest: "1", oraclePx: o.toFixed(4), markPx: (o + 0.5).toFixed(4), midPx: null, impactPxs: null, premium: null, dayNtlVlm: "1" }, start + 1000 + i * 2000, "poll"));
  }
  store.writeTicks(ticks);
  return o;
}

test("schedule is the same from raw ticks and from compacted bars, and repeats group by time of day", () => {
  const store = new Store(":memory:");
  const day = 86_400_000;
  const d1 = Date.parse("2026-11-24T00:00:00Z");
  let o = 800;
  for (const d of [d1, d1 + day]) {
    const eleven = d + 11 * 3_600_000;
    for (let i = -4; i < 0; i++) o = fill(store, "xyz:SKHX", eleven + i * BUCKET_MS, 40, false, o);
    for (let i = 0; i < 4; i++) o = fill(store, "xyz:SKHX", eleven + i * BUCKET_MS, 40, true, o);
    for (let i = -4; i < 4; i++) store.recordPoll(eleven + i * BUCKET_MS, "xyz", 1, 1);
  }
  const cats = new Map([["xyz:SKHX", "stocks"]]);
  const from = d1;
  const to = d1 + 2 * day;
  const raw = buildSchedule(store, cats, from, to);
  assert.equal(raw.switches.length, 1);
  const s = raw.switches[0]!;
  assert.equal(s.direction, "external → internal");
  assert.equal(s.utc, "11:00");
  assert.equal(s.local, "20:00");
  assert.equal(s.timezone, "Asia/Seoul");
  assert.equal(s.daysObserved, 2);
  assert.deepEqual(s.dates, ["2026-11-24", "2026-11-25"]);
  assert.equal(s.calendar, "extended → closed");
  assert.equal(raw.regimes[0]!.external, "10:30-11:00");
  assert.equal(raw.regimes[0]!.internal, "11:00-11:30");

  // Fold the first day into bars; the answer must not change.
  const before = loadBuckets(store, from, to).map((b) => [b.ts, b.updates, b.judged, b.toward]);
  store.compact(d1 + day + 3_600_000, 3_600_000, 365 * day);
  assert.ok((store.db.prepare("SELECT count(*) AS n FROM bars_1m").get() as { n: number }).n > 0);
  const after = loadBuckets(store, from, to).map((b) => [b.ts, b.updates, b.judged, b.toward]);
  // The first tick of a compaction chunk has no predecessor, so one update may go uncounted per chunk.
  assert.equal(after.length, before.length);
  assert.deepEqual(buildSchedule(store, cats, from, to).switches, raw.switches);

  const md = toMarkdown(raw);
  assert.match(md, /\| xyz:SKHX \| external → internal \| 11:00 \| 20:00 Asia\/Seoul \| 2 of 2 day\(s\)/);
  store.close();
});

test("an older database gains the update counters on open", () => {
  const store = new Store(":memory:");
  const cols = (store.db.prepare("PRAGMA table_info(bars_1m)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("toward_updates"));
  store.close();
});
